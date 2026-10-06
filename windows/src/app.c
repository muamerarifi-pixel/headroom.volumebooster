/*
 * Headroom.exe: the control app for the system-wide boost.
 *
 * The audio itself is processed by HeadroomLimiter.dll, which Equalizer APO
 * runs inside the Windows audio engine for every app and every sound. This
 * program only writes Equalizer APO's config (config\headroom.txt), so the
 * boost keeps working when Headroom.exe is closed and after a restart.
 */
#define WIN32_LEAN_AND_MEAN
#define COBJMACROS
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <commctrl.h>
#include <shellapi.h>
#include <shlwapi.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <stdio.h>
#include <wchar.h>
#include "resource.h"

#define APP_NAME L"Headroom"
#define REG_APP L"Software\\Headroom"
#define REG_RUN L"Software\\Microsoft\\Windows\\CurrentVersion\\Run"
#define REG_EQAPO L"SOFTWARE\\EqualizerAPO"
#define REG_MMDEV L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render\\"
#define ENGINE_INSTALLER L"EqualizerAPO-x64-1.4.2.exe"
#define BOOST_STEPS 48 /* 0..24 dB in 0.5 dB steps */

#define WM_TRAY (WM_APP + 1)
#define TIMER_APPLY 1
#define TIMER_STATUS 2

enum {
  IDC_ENABLED = 100,
  IDC_SLIDER,
  IDC_VALUE,
  IDC_STYLE0,
  IDC_STYLE1,
  IDC_STYLE2,
  IDC_AUTOSTART,
  IDC_DEVICES,
  IDC_SOUND,
  IDC_ENGINE,
  IDC_STATUS,
  IDC_DEVICE,
  IDC_TITLE,
  IDC_LABEL_BOOST,
  IDC_LABEL_STYLE,
  IDC_HINT,
};

enum {
  IDM_TOGGLE = 1000,
  IDM_OPEN,
  IDM_EXIT,
  IDM_STYLE0 = 1010,
  IDM_PRESET0 = 1020, /* + preset index */
};

enum { HK_TOGGLE = 1 };

typedef struct {
  BOOL enabled;
  int boostHalfDb; /* 0..48 */
  int style;       /* 0 transparent, 1 balanced, 2 night */
} Settings;

static const wchar_t* STYLE_NAMES[3] = {L"Transparent", L"Balanced", L"Night"};
static const int PRESETS_DB[] = {0, 3, 6, 9, 12, 18, 24};

static HINSTANCE g_inst;
static HWND g_wnd;
static Settings g_set;
static NOTIFYICONDATAW g_nid;
static UINT g_msgTaskbarCreated;
static HFONT g_font, g_fontBold, g_fontTitle;
static HBRUSH g_bg;
static HICON g_iconBig, g_iconSmall;
static int g_dpi = 96;
static wchar_t g_appDir[MAX_PATH];
static wchar_t g_lastWritten[1024];

/* ---------- settings ---------- */

static DWORD reg_get_dword(HKEY root, const wchar_t* path, const wchar_t* name, DWORD def) {
  DWORD v = def, size = sizeof v;
  if (RegGetValueW(root, path, name, RRF_RT_REG_DWORD, NULL, &v, &size) != ERROR_SUCCESS) return def;
  return v;
}

static void reg_set_dword(const wchar_t* name, DWORD v) {
  HKEY k;
  if (RegCreateKeyExW(HKEY_CURRENT_USER, REG_APP, 0, NULL, 0, KEY_SET_VALUE, NULL, &k, NULL) == ERROR_SUCCESS) {
    RegSetValueExW(k, name, 0, REG_DWORD, (const BYTE*)&v, sizeof v);
    RegCloseKey(k);
  }
}

static void load_settings(void) {
  g_set.enabled = reg_get_dword(HKEY_CURRENT_USER, REG_APP, L"Enabled", 1) != 0;
  g_set.boostHalfDb = (int)reg_get_dword(HKEY_CURRENT_USER, REG_APP, L"BoostHalfDb", 16);
  g_set.style = (int)reg_get_dword(HKEY_CURRENT_USER, REG_APP, L"Style", 1);
  if (g_set.boostHalfDb < 0 || g_set.boostHalfDb > BOOST_STEPS) g_set.boostHalfDb = 16;
  if (g_set.style < 0 || g_set.style > 2) g_set.style = 1;
}

static void save_settings(void) {
  reg_set_dword(L"Enabled", g_set.enabled);
  reg_set_dword(L"BoostHalfDb", (DWORD)g_set.boostHalfDb);
  reg_set_dword(L"Style", (DWORD)g_set.style);
}

static BOOL autostart_enabled(void) {
  wchar_t buf[MAX_PATH * 2];
  DWORD size = sizeof buf;
  return RegGetValueW(HKEY_CURRENT_USER, REG_RUN, APP_NAME, RRF_RT_REG_SZ, NULL, buf, &size) == ERROR_SUCCESS;
}

static void set_autostart(BOOL on) {
  HKEY k;
  if (RegOpenKeyExW(HKEY_CURRENT_USER, REG_RUN, 0, KEY_SET_VALUE, &k) != ERROR_SUCCESS) return;
  if (on) {
    wchar_t exe[MAX_PATH], cmd[MAX_PATH + 16];
    GetModuleFileNameW(NULL, exe, MAX_PATH);
    swprintf(cmd, MAX_PATH + 16, L"\"%ls\" /tray", exe);
    RegSetValueExW(k, APP_NAME, 0, REG_SZ, (const BYTE*)cmd, (DWORD)((wcslen(cmd) + 1) * sizeof(wchar_t)));
  } else {
    RegDeleteValueW(k, APP_NAME);
  }
  RegCloseKey(k);
}

/* ---------- Equalizer APO engine ---------- */

static BOOL eqapo_value(const wchar_t* name, wchar_t* out, DWORD cch) {
  DWORD size = cch * sizeof(wchar_t);
  out[0] = 0;
  return RegGetValueW(HKEY_LOCAL_MACHINE, REG_EQAPO, name, RRF_RT_REG_SZ, NULL, out, &size) ==
             ERROR_SUCCESS &&
         out[0];
}

static BOOL engine_installed(void) {
  wchar_t dir[MAX_PATH], dll[MAX_PATH];
  if (!eqapo_value(L"InstallPath", dir, MAX_PATH)) return FALSE;
  swprintf(dll, MAX_PATH, L"%ls\\EqualizerAPO.dll", dir);
  return PathFileExistsW(dll);
}

static BOOL engine_config_dir(wchar_t* out, DWORD cch) {
  if (eqapo_value(L"ConfigPath", out, cch)) return TRUE;
  wchar_t dir[MAX_PATH];
  if (!eqapo_value(L"InstallPath", dir, MAX_PATH)) return FALSE;
  swprintf(out, cch, L"%ls\\config", dir);
  return TRUE;
}

static BOOL read_file(const wchar_t* path, char** data, DWORD* len) {
  HANDLE f = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING, 0, NULL);
  if (f == INVALID_HANDLE_VALUE) return FALSE;
  DWORD size = GetFileSize(f, NULL);
  if (size == INVALID_FILE_SIZE || size > (1 << 20)) {
    CloseHandle(f);
    return FALSE;
  }
  char* buf = (char*)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, size + 1);
  DWORD got = 0;
  BOOL ok = buf && ReadFile(f, buf, size, &got, NULL);
  CloseHandle(f);
  if (!ok) {
    if (buf) HeapFree(GetProcessHeap(), 0, buf);
    return FALSE;
  }
  buf[got] = 0;
  *data = buf;
  *len = got;
  return TRUE;
}

static BOOL write_file(const wchar_t* path, const char* data, DWORD len) {
  HANDLE f = CreateFileW(path, GENERIC_WRITE, FILE_SHARE_READ, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (f == INVALID_HANDLE_VALUE) return FALSE;
  DWORD wrote = 0;
  BOOL ok = WriteFile(f, data, len, &wrote, NULL) && wrote == len;
  CloseHandle(f);
  return ok;
}

static BOOL contains_ci(const char* hay, const char* needle) { return StrStrIA(hay, needle) != NULL; }

/* Makes Equalizer APO's config.txt load headroom.txt. Equalizer APO's stock
 * config (a -6 dB preamp plus a demo bass boost) is replaced, after a backup;
 * a config the user customised is kept and the include is appended. */
static BOOL ensure_include(const wchar_t* cfgDir) {
  wchar_t path[MAX_PATH], backup[MAX_PATH];
  swprintf(path, MAX_PATH, L"%ls\\config.txt", cfgDir);
  static const char line[] = "Include: headroom.txt\r\n";
  char* data = NULL;
  DWORD len = 0;
  if (!read_file(path, &data, &len)) return write_file(path, line, sizeof line - 1);

  BOOL ok = TRUE;
  if (!contains_ci(data, "headroom.txt")) {
    BOOL stock = len < 400 && contains_ci(data, "Preamp: -6 dB") && contains_ci(data, "Include: example.txt");
    if (stock) {
      swprintf(backup, MAX_PATH, L"%ls\\config.txt.before-headroom", cfgDir);
      CopyFileW(path, backup, TRUE);
      ok = write_file(path, line, sizeof line - 1);
    } else {
      DWORD cap = len + 64;
      char* out = (char*)HeapAlloc(GetProcessHeap(), 0, cap);
      if (!out) {
        HeapFree(GetProcessHeap(), 0, data);
        return FALSE;
      }
      memcpy(out, data, len);
      DWORD n = len;
      if (n > 0 && out[n - 1] != '\n') {
        out[n++] = '\r';
        out[n++] = '\n';
      }
      memcpy(out + n, line, sizeof line - 1);
      n += sizeof line - 1;
      ok = write_file(path, out, n);
      HeapFree(GetProcessHeap(), 0, out);
    }
  }
  HeapFree(GetProcessHeap(), 0, data);
  return ok;
}

/* Writes config\headroom.txt. Equalizer APO watches its config folder and
 * reloads within a moment, for every device it is installed on. */
static BOOL apply_to_engine(void) {
  wchar_t cfgDir[MAX_PATH], path[MAX_PATH], dll[MAX_PATH];
  if (!engine_config_dir(cfgDir, MAX_PATH)) return FALSE;
  ensure_include(cfgDir);

  swprintf(dll, MAX_PATH, L"%ls\\HeadroomLimiter.dll", g_appDir);
  wchar_t text[1024];
  int n = swprintf(text, 1024,
                   L"# Headroom system-wide volume boost.\r\n"
                   L"# This file is rewritten by Headroom.exe; change the boost in the Headroom app.\r\n");
  if (g_set.enabled && g_set.boostHalfDb > 0) {
    /* Integer formatting keeps the decimal point a '.', whatever the locale. */
    int boostMicro = (int)((g_set.boostHalfDb * 1000000LL + BOOST_STEPS / 2) / BOOST_STEPS);
    static const wchar_t* styleVal[3] = {L"0", L"0.5", L"1"};
    swprintf(text + n, 1024 - n, L"VSTPlugin: Library \"%ls\" Boost %d.%06d Style %ls Enabled 1\r\n", dll,
             boostMicro / 1000000, boostMicro % 1000000, styleVal[g_set.style]);
  }
  if (wcscmp(text, g_lastWritten) == 0) return TRUE;

  char utf8[2048];
  int len = WideCharToMultiByte(CP_UTF8, 0, text, -1, utf8, sizeof utf8, NULL, NULL);
  if (len <= 0) return FALSE;
  swprintf(path, MAX_PATH, L"%ls\\headroom.txt", cfgDir);
  if (!write_file(path, utf8, (DWORD)(len - 1))) return FALSE;
  wcscpy(g_lastWritten, text);
  return TRUE;
}

/* ---------- default device status ---------- */

DEFINE_GUID(CLSID_MMDeviceEnumerator_, 0xBCDE0395, 0xE52F, 0x467C, 0x8E, 0x3D, 0xC4, 0x57, 0x92, 0x91, 0x69, 0x2E);
DEFINE_GUID(IID_IMMDeviceEnumerator_, 0xA95664D2, 0x9614, 0x4F35, 0xA7, 0x46, 0xDE, 0x8D, 0xB6, 0x36, 0x17, 0xE6);
static const PROPERTYKEY PKEY_FriendlyName_ = {
    {0xa45c254e, 0xdf1c, 0x4efd, {0x80, 0x20, 0x67, 0xd1, 0x46, 0xa8, 0x50, 0xe0}}, 14};

typedef enum { DEV_UNKNOWN, DEV_NONE, DEV_READY, DEV_NOT_SETUP, DEV_FX_OFF } DeviceState;

static DeviceState default_device(wchar_t* name, int cch) {
  DeviceState state = DEV_UNKNOWN;
  IMMDeviceEnumerator* en = NULL;
  IMMDevice* dev = NULL;
  name[0] = 0;
  if (FAILED(CoCreateInstance(&CLSID_MMDeviceEnumerator_, NULL, CLSCTX_ALL, &IID_IMMDeviceEnumerator_, (void**)&en)))
    return DEV_UNKNOWN;
  if (FAILED(IMMDeviceEnumerator_GetDefaultAudioEndpoint(en, eRender, eMultimedia, &dev))) {
    IMMDeviceEnumerator_Release(en);
    return DEV_NONE;
  }

  IPropertyStore* props = NULL;
  if (SUCCEEDED(IMMDevice_OpenPropertyStore(dev, STGM_READ, &props))) {
    PROPVARIANT v;
    PropVariantInit(&v);
    if (SUCCEEDED(IPropertyStore_GetValue(props, &PKEY_FriendlyName_, &v)) && v.vt == VT_LPWSTR)
      lstrcpynW(name, v.pwszVal, cch);
    PropVariantClear(&v);
    IPropertyStore_Release(props);
  }

  LPWSTR id = NULL;
  if (SUCCEEDED(IMMDevice_GetId(dev, &id)) && id) {
    /* id looks like {0.0.0.00000000}.{endpoint-guid} */
    const wchar_t* guid = wcsrchr(id, L'{');
    if (guid) {
      wchar_t key[512];
      HKEY k;
      state = DEV_NOT_SETUP;
      swprintf(key, 512, L"%ls%ls\\FxProperties", REG_MMDEV, guid);
      if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, key, 0, KEY_READ | KEY_WOW64_64KEY, &k) == ERROR_SUCCESS) {
        wchar_t vname[256];
        BYTE data[4096];
        for (DWORD i = 0;; i++) {
          DWORD nlen = 256, dlen = sizeof data - 4, type;
          LONG r = RegEnumValueW(k, i, vname, &nlen, NULL, &type, data, &dlen);
          if (r == ERROR_NO_MORE_ITEMS) break;
          if (r != ERROR_SUCCESS || (type != REG_SZ && type != REG_MULTI_SZ)) continue;
          data[dlen] = data[dlen + 1] = data[dlen + 2] = data[dlen + 3] = 0;
          /* walk every string of a REG_MULTI_SZ */
          for (const wchar_t* s = (const wchar_t*)data; *s; s += wcslen(s) + 1) {
            if (StrStrIW(s, L"EC1CC9CE-FAED-4822-828A-82A81A6F018F") ||
                StrStrIW(s, L"EACD2258-FCAC-4FF4-B36D-419E924A6D79"))
              state = DEV_READY;
          }
        }
        RegCloseKey(k);
      } else {
        state = DEV_UNKNOWN;
      }
      if (state == DEV_READY) {
        /* PKEY_AudioEndpoint_Disable_SysFx: Windows "Audio enhancements" off */
        swprintf(key, 512, L"%ls%ls\\Properties", REG_MMDEV, guid);
        if (reg_get_dword(HKEY_LOCAL_MACHINE, key, L"{1da5d803-d492-4edd-8c23-e0c0ffee7f0e},5", 0) == 1)
          state = DEV_FX_OFF;
      }
    }
    CoTaskMemFree(id);
  }
  IMMDevice_Release(dev);
  IMMDeviceEnumerator_Release(en);
  return state;
}

/* ---------- UI ---------- */

static int S(int px) { return MulDiv(px, g_dpi, 96); }

static void format_boost(wchar_t* buf, int cch, int halfDb) {
  swprintf(buf, cch, L"+%d.%d dB", halfDb / 2, (halfDb % 2) * 5);
}

static void update_tray(void) {
  wchar_t b[32];
  format_boost(b, 32, g_set.boostHalfDb);
  if (g_set.enabled)
    swprintf(g_nid.szTip, ARRAYSIZE(g_nid.szTip), L"Headroom: %ls (%ls)", b, STYLE_NAMES[g_set.style]);
  else
    swprintf(g_nid.szTip, ARRAYSIZE(g_nid.szTip), L"Headroom: off");
  g_nid.uFlags = NIF_TIP | NIF_SHOWTIP;
  Shell_NotifyIconW(NIM_MODIFY, &g_nid);
}

static void update_status(void) {
  if (!g_wnd) return;
  wchar_t status[256], device[256], name[160];
  BOOL installed = engine_installed();
  ShowWindow(GetDlgItem(g_wnd, IDC_ENGINE), installed ? SW_HIDE : SW_SHOW);
  EnableWindow(GetDlgItem(g_wnd, IDC_DEVICES), installed);

  if (!installed) {
    wcscpy(status, L"The audio engine (Equalizer APO) is not installed yet.");
    wcscpy(device, L"Click \"Install engine\" to set it up. It takes a minute.");
  } else {
    if (!g_lastWritten[0]) apply_to_engine(); /* engine was installed while we ran */
    DeviceState st = default_device(name, ARRAYSIZE(name));
    if (!g_set.enabled || g_set.boostHalfDb == 0)
      wcscpy(status, L"Boost is off. Sound plays at normal volume.");
    else
      wcscpy(status, L"Boosting every sound on this PC.");
    switch (st) {
      case DEV_READY:
        swprintf(device, 256, L"Output: %ls  \x2714", name);
        break;
      case DEV_NOT_SETUP:
        swprintf(device, 256, L"\x26A0 \"%ls\" isn't set up. Click Audio devices and tick it.", name);
        break;
      case DEV_FX_OFF:
        swprintf(device, 256, L"\x26A0 Audio enhancements are off for \"%ls\". Turn them on in Sound settings.", name);
        break;
      case DEV_NONE:
        wcscpy(device, L"No speakers or headphones found.");
        break;
      default:
        swprintf(device, 256, L"Output: %ls", name[0] ? name : L"unknown");
    }
  }
  SetDlgItemTextW(g_wnd, IDC_STATUS, status);
  SetDlgItemTextW(g_wnd, IDC_DEVICE, device);
}

static void sync_controls(void) {
  wchar_t b[32];
  CheckDlgButton(g_wnd, IDC_ENABLED, g_set.enabled ? BST_CHECKED : BST_UNCHECKED);
  SendDlgItemMessageW(g_wnd, IDC_SLIDER, TBM_SETPOS, TRUE, g_set.boostHalfDb);
  format_boost(b, 32, g_set.boostHalfDb);
  SetDlgItemTextW(g_wnd, IDC_VALUE, b);
  CheckRadioButton(g_wnd, IDC_STYLE0, IDC_STYLE2, IDC_STYLE0 + g_set.style);
  CheckDlgButton(g_wnd, IDC_AUTOSTART, autostart_enabled() ? BST_CHECKED : BST_UNCHECKED);
  BOOL on = g_set.enabled;
  EnableWindow(GetDlgItem(g_wnd, IDC_SLIDER), on);
  for (int i = 0; i < 3; i++) EnableWindow(GetDlgItem(g_wnd, IDC_STYLE0 + i), on);
}

/* Called after any settings change: saves, refreshes UI, and schedules the
 * engine write (debounced so dragging the slider doesn't reload 50 times). */
static void settings_changed(void) {
  save_settings();
  sync_controls();
  update_tray();
  update_status();
  SetTimer(g_wnd, TIMER_APPLY, 250, NULL);
}

static void run_engine_installer(void) {
  wchar_t path[MAX_PATH];
  swprintf(path, MAX_PATH, L"%ls\\%ls", g_appDir, ENGINE_INSTALLER);
  if (!PathFileExistsW(path)) {
    MessageBoxW(g_wnd,
                L"The engine installer is missing. Reinstall Headroom, or install Equalizer APO from "
                L"https://sourceforge.net/projects/equalizerapo/",
                APP_NAME, MB_ICONWARNING);
    return;
  }
  SHELLEXECUTEINFOW sei = {sizeof sei};
  sei.fMask = SEE_MASK_NOCLOSEPROCESS;
  sei.hwnd = g_wnd;
  sei.lpVerb = L"runas";
  sei.lpFile = path;
  sei.nShow = SW_SHOWNORMAL;
  if (ShellExecuteExW(&sei) && sei.hProcess) {
    /* Wait without freezing the window. */
    while (MsgWaitForMultipleObjects(1, &sei.hProcess, FALSE, INFINITE, QS_ALLINPUT) == WAIT_OBJECT_0 + 1) {
      MSG m;
      while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
      }
    }
    CloseHandle(sei.hProcess);
    g_lastWritten[0] = 0;
    apply_to_engine();
    update_status();
  }
}

static void open_device_selector(void) {
  wchar_t dir[MAX_PATH], exe[MAX_PATH];
  if (!eqapo_value(L"InstallPath", dir, MAX_PATH)) return;
  swprintf(exe, MAX_PATH, L"%ls\\DeviceSelector.exe", dir);
  ShellExecuteW(g_wnd, L"runas", exe, NULL, dir, SW_SHOWNORMAL);
}

static HWND add(const wchar_t* cls, const wchar_t* text, DWORD style, int x, int y, int w, int h, int id, HFONT f) {
  HWND c = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, S(x), S(y), S(w), S(h), g_wnd,
                           (HMENU)(INT_PTR)id, g_inst, NULL);
  SendMessageW(c, WM_SETFONT, (WPARAM)f, FALSE);
  return c;
}

static HFONT make_font(int pt, int weight) {
  return CreateFontW(-MulDiv(pt, g_dpi, 72), 0, 0, 0, weight, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0,
                     L"Segoe UI");
}

static void create_controls(void) {
  g_font = make_font(9, FW_NORMAL);
  g_fontBold = make_font(9, FW_SEMIBOLD);
  g_fontTitle = make_font(16, FW_SEMIBOLD);

  add(L"STATIC", L"Headroom", 0, 20, 14, 240, 32, IDC_TITLE, g_fontTitle);
  add(L"STATIC", L"", SS_NOPREFIX, 20, 50, 360, 18, IDC_STATUS, g_fontBold);
  add(L"STATIC", L"", SS_NOPREFIX, 20, 70, 360, 34, IDC_DEVICE, g_font);

  add(L"BUTTON", L"Boost on   (Alt+Shift+H)", BS_AUTOCHECKBOX | WS_TABSTOP, 20, 116, 300, 22, IDC_ENABLED, g_font);

  add(L"STATIC", L"Boost", 0, 20, 150, 120, 18, IDC_LABEL_BOOST, g_fontBold);
  add(L"STATIC", L"", SS_RIGHT, 260, 150, 120, 18, IDC_VALUE, g_fontBold);
  HWND sl = add(TRACKBAR_CLASSW, L"", TBS_HORZ | TBS_NOTICKS | WS_TABSTOP, 12, 170, 376, 30, IDC_SLIDER, g_font);
  SendMessageW(sl, TBM_SETRANGE, TRUE, MAKELPARAM(0, BOOST_STEPS));
  SendMessageW(sl, TBM_SETLINESIZE, 0, 1);
  SendMessageW(sl, TBM_SETPAGESIZE, 0, 4);

  add(L"STATIC", L"Sound", 0, 20, 212, 120, 18, IDC_LABEL_STYLE, g_fontBold);
  add(L"BUTTON", L"Transparent", BS_AUTORADIOBUTTON | WS_GROUP | WS_TABSTOP, 20, 232, 110, 22, IDC_STYLE0, g_font);
  add(L"BUTTON", L"Balanced", BS_AUTORADIOBUTTON, 140, 232, 100, 22, IDC_STYLE1, g_font);
  add(L"BUTTON", L"Night", BS_AUTORADIOBUTTON, 250, 232, 100, 22, IDC_STYLE2, g_font);

  add(L"BUTTON", L"Start with Windows", BS_AUTOCHECKBOX | WS_TABSTOP | WS_GROUP, 20, 268, 300, 22, IDC_AUTOSTART,
      g_font);

  add(L"BUTTON", L"Audio devices\x2026", BS_PUSHBUTTON | WS_TABSTOP, 20, 304, 116, 28, IDC_DEVICES, g_font);
  add(L"BUTTON", L"Sound settings", BS_PUSHBUTTON | WS_TABSTOP, 144, 304, 116, 28, IDC_SOUND, g_font);
  HWND eng = add(L"BUTTON", L"Install engine", BS_DEFPUSHBUTTON | WS_TABSTOP, 268, 304, 112, 28, IDC_ENGINE, g_font);
  ShowWindow(eng, SW_HIDE);

  add(L"STATIC", L"Closing this window keeps the boost running.", SS_NOPREFIX, 20,
      346, 370, 18, IDC_HINT, g_font);
}

static void show_main(void) {
  ShowWindow(g_wnd, SW_SHOWNORMAL);
  SetForegroundWindow(g_wnd);
  update_status();
  SetTimer(g_wnd, TIMER_STATUS, 3000, NULL);
}

static void show_tray_menu(void) {
  HMENU m = CreatePopupMenu();
  wchar_t b[64];
  AppendMenuW(m, MF_STRING | (g_set.enabled ? MF_CHECKED : 0), IDM_TOGGLE, L"Boost on\tAlt+Shift+H");
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  for (int i = 0; i < (int)ARRAYSIZE(PRESETS_DB); i++) {
    swprintf(b, 64, L"+%d dB", PRESETS_DB[i]);
    AppendMenuW(m, MF_STRING | (g_set.boostHalfDb == PRESETS_DB[i] * 2 ? MF_CHECKED : 0) | (g_set.enabled ? 0 : MF_GRAYED),
                IDM_PRESET0 + i, b);
  }
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  for (int i = 0; i < 3; i++)
    AppendMenuW(m, MF_STRING | (g_set.style == i ? MF_CHECKED : 0) | (g_set.enabled ? 0 : MF_GRAYED), IDM_STYLE0 + i,
                STYLE_NAMES[i]);
  AppendMenuW(m, MF_SEPARATOR, 0, NULL);
  AppendMenuW(m, MF_STRING, IDM_OPEN, L"Open Headroom");
  AppendMenuW(m, MF_STRING, IDM_EXIT, L"Close (boost stays active)");
  SetMenuDefaultItem(m, IDM_OPEN, FALSE);

  POINT pt;
  GetCursorPos(&pt);
  SetForegroundWindow(g_wnd);
  TrackPopupMenu(m, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, g_wnd, NULL);
  PostMessageW(g_wnd, WM_NULL, 0, 0);
  DestroyMenu(m);
}

static void add_tray_icon(void) {
  g_nid.cbSize = sizeof g_nid;
  g_nid.hWnd = g_wnd;
  g_nid.uID = 1;
  g_nid.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
  g_nid.uCallbackMessage = WM_TRAY;
  g_nid.hIcon = g_iconSmall;
  wcscpy(g_nid.szTip, APP_NAME);
  Shell_NotifyIconW(NIM_ADD, &g_nid);
  g_nid.uVersion = NOTIFYICON_VERSION_4;
  Shell_NotifyIconW(NIM_SETVERSION, &g_nid);
  update_tray();
}

static void on_command(int id, int code) {
  switch (id) {
    case IDC_ENABLED:
      g_set.enabled = IsDlgButtonChecked(g_wnd, IDC_ENABLED) == BST_CHECKED;
      settings_changed();
      break;
    case IDC_STYLE0:
    case IDC_STYLE1:
    case IDC_STYLE2:
      if (code == BN_CLICKED) {
        g_set.style = id - IDC_STYLE0;
        settings_changed();
      }
      break;
    case IDC_AUTOSTART:
      set_autostart(IsDlgButtonChecked(g_wnd, IDC_AUTOSTART) == BST_CHECKED);
      break;
    case IDC_DEVICES:
      open_device_selector();
      break;
    case IDC_SOUND:
      ShellExecuteW(g_wnd, L"open", L"ms-settings:sound", NULL, NULL, SW_SHOWNORMAL);
      break;
    case IDC_ENGINE:
      run_engine_installer();
      break;
    case IDM_TOGGLE:
      g_set.enabled = !g_set.enabled;
      settings_changed();
      break;
    case IDM_OPEN:
      show_main();
      break;
    case IDM_EXIT:
      DestroyWindow(g_wnd);
      break;
    default:
      if (id >= IDM_PRESET0 && id < IDM_PRESET0 + (int)ARRAYSIZE(PRESETS_DB)) {
        g_set.boostHalfDb = PRESETS_DB[id - IDM_PRESET0] * 2;
        settings_changed();
      } else if (id >= IDM_STYLE0 && id < IDM_STYLE0 + 3) {
        g_set.style = id - IDM_STYLE0;
        settings_changed();
      }
  }
}

static LRESULT CALLBACK wnd_proc(HWND h, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == g_msgTaskbarCreated && g_msgTaskbarCreated) {
    add_tray_icon();
    return 0;
  }
  switch (msg) {
    case WM_CREATE:
      g_wnd = h;
      create_controls();
      return 0;
    case WM_COMMAND:
      on_command(LOWORD(wp), HIWORD(wp));
      return 0;
    case WM_HSCROLL:
      if ((HWND)lp == GetDlgItem(h, IDC_SLIDER)) {
        int pos = (int)SendMessageW((HWND)lp, TBM_GETPOS, 0, 0);
        if (pos != g_set.boostHalfDb) {
          g_set.boostHalfDb = pos;
          settings_changed();
        }
      }
      return 0;
    case WM_TIMER:
      if (wp == TIMER_APPLY) {
        KillTimer(h, TIMER_APPLY);
        if (!apply_to_engine() && engine_installed())
          SetDlgItemTextW(h, IDC_STATUS, L"Couldn't write the engine settings. Try reinstalling Headroom.");
      } else if (wp == TIMER_STATUS) {
        if (IsWindowVisible(h)) update_status();
        else KillTimer(h, TIMER_STATUS);
      }
      return 0;
    case WM_HOTKEY:
      if (wp == HK_TOGGLE) on_command(IDM_TOGGLE, 0);
      return 0;
    case WM_TRAY:
      switch (LOWORD(lp)) {
        case WM_LBUTTONUP:
        case NIN_SELECT:
        case NIN_KEYSELECT:
          show_main();
          break;
        case WM_RBUTTONUP:
        case WM_CONTEXTMENU:
          show_tray_menu();
          break;
      }
      return 0;
    case WM_CTLCOLORSTATIC:
      SetBkMode((HDC)wp, TRANSPARENT);
      SetTextColor((HDC)wp, GetSysColor(COLOR_WINDOWTEXT));
      return (LRESULT)g_bg;
    case WM_CLOSE:
      ShowWindow(h, SW_HIDE);
      return 0;
    case WM_ENDSESSION:
      if (wp) DestroyWindow(h);
      return 0;
    case WM_DESTROY:
      KillTimer(h, TIMER_APPLY);
      apply_to_engine(); /* flush a pending change */
      Shell_NotifyIconW(NIM_DELETE, &g_nid);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(h, msg, wp, lp);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, LPWSTR cmd, int show) {
  (void)prev;
  (void)show;
  g_inst = inst;
  GetModuleFileNameW(NULL, g_appDir, MAX_PATH);
  PathRemoveFileSpecW(g_appDir);
  BOOL tray = cmd && StrStrIW(cmd, L"/tray") != NULL;
  BOOL applyOnly = cmd && StrStrIW(cmd, L"/apply") != NULL;
  BOOL removeOnly = cmd && StrStrIW(cmd, L"/remove") != NULL;

  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  load_settings();

  /* Used by the installer/uninstaller, which run elevated. */
  if (applyOnly) {
    if (engine_installed()) apply_to_engine();
    return 0;
  }
  if (removeOnly) {
    wchar_t cfgDir[MAX_PATH], path[MAX_PATH];
    if (engine_config_dir(cfgDir, MAX_PATH)) {
      static const char empty[] = "# Headroom was uninstalled.\r\n";
      swprintf(path, MAX_PATH, L"%ls\\headroom.txt", cfgDir);
      if (PathFileExistsW(path)) write_file(path, empty, sizeof empty - 1);
    }
    return 0;
  }

  HANDLE mutex = CreateMutexW(NULL, TRUE, L"Local\\HeadroomVolumeBooster");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND other = FindWindowW(L"HeadroomMain", NULL);
    if (other) PostMessageW(other, WM_COMMAND, IDM_OPEN, 0);
    return 0;
  }

  INITCOMMONCONTROLSEX icc = {sizeof icc, ICC_BAR_CLASSES | ICC_STANDARD_CLASSES};
  InitCommonControlsEx(&icc);
  HDC screen = GetDC(NULL);
  g_dpi = GetDeviceCaps(screen, LOGPIXELSY);
  ReleaseDC(NULL, screen);

  g_iconBig = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
                                GetSystemMetrics(SM_CYICON), 0);
  g_iconSmall = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(IDI_APP), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                  GetSystemMetrics(SM_CYSMICON), 0);
  g_bg = GetSysColorBrush(COLOR_WINDOW);
  g_msgTaskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");

  WNDCLASSEXW wc = {sizeof wc};
  wc.lpfnWndProc = wnd_proc;
  wc.hInstance = inst;
  wc.hIcon = g_iconBig;
  wc.hIconSm = g_iconSmall;
  wc.hCursor = LoadCursorW(NULL, IDC_ARROW);
  wc.hbrBackground = g_bg;
  wc.lpszClassName = L"HeadroomMain";
  RegisterClassExW(&wc);

  DWORD style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
  RECT rc = {0, 0, MulDiv(400, g_dpi, 96), MulDiv(380, g_dpi, 96)};
  AdjustWindowRect(&rc, style, FALSE);
  HWND h = CreateWindowExW(0, wc.lpszClassName, APP_NAME, style, CW_USEDEFAULT, CW_USEDEFAULT, rc.right - rc.left,
                           rc.bottom - rc.top, NULL, NULL, inst, NULL);
  if (!h) return 1;

  sync_controls();
  add_tray_icon();
  RegisterHotKey(h, HK_TOGGLE, MOD_ALT | MOD_SHIFT | MOD_NOREPEAT, 'H');

  apply_to_engine();
  if (tray) update_status();
  else show_main();

  MSG m;
  while (GetMessageW(&m, NULL, 0, 0) > 0) {
    if (!IsDialogMessageW(h, &m)) {
      TranslateMessage(&m);
      DispatchMessageW(&m);
    }
  }
  CoUninitialize();
  if (mutex) CloseHandle(mutex);
  return 0;
}
