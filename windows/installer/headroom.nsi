; Headroom for Windows installer (NSIS 3). Build with ../build.sh.
Unicode true
SetCompressor /SOLID lzma
ManifestDPIAware true

!define APP "Headroom"
!define VERSION "1.0.0"
!define ENGINE "EqualizerAPO-x64-1.4.2.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Headroom"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

Name "${APP}"
OutFile "..\dist\Headroom-Setup.exe"
InstallDir "$PROGRAMFILES64\Headroom"
InstallDirRegKey HKLM "${UNINST_KEY}" "InstallLocation"
RequestExecutionLevel admin
BrandingText "Headroom ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Headroom for Windows"
VIAddVersionKey "FileDescription" "Headroom setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Headroom"
VIAddVersionKey "LegalCopyright" "Headroom"

!define MUI_ICON "..\res\headroom.ico"
!define MUI_UNICON "..\res\headroom.ico"
!define MUI_ABORTWARNING

!define MUI_WELCOMEPAGE_TITLE "Make everything louder"
!define MUI_WELCOMEPAGE_TEXT "Headroom boosts the volume of every sound on this PC (browsers, Spotify, games, videos and calls) by up to 24 dB. A limiter keeps the louder sound from clipping.$\r$\n$\r$\nSetup also installs Equalizer APO, the free audio engine Headroom runs in. When it asks which devices to use, tick your speakers and headphones.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME

!define MUI_LICENSEPAGE_TEXT_TOP "Please read how Headroom works and the third-party notice."
!define MUI_LICENSEPAGE_BUTTON "&Next >"
!define MUI_LICENSEPAGE_TEXT_BOTTOM "Click Next to continue."
!insertmacro MUI_PAGE_LICENSE "NOTICE.txt"

!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Headroom is ready"
!define MUI_FINISHPAGE_TEXT "The boost is on and runs all the time. Change it from the Headroom icon in the taskbar tray.$\r$\n$\r$\nIf you can't hear a difference yet, restart your PC once."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "Open Headroom"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Headroom needs 64-bit Windows 10 or 11."
    Abort
  ${EndIf}
  SetRegView 64
FunctionEnd

Function un.onInit
  SetRegView 64
FunctionEnd

; Start the app as the normal user, not elevated like this installer.
Function LaunchApp
  Exec '"$WINDIR\explorer.exe" "$INSTDIR\Headroom.exe"'
FunctionEnd

Function EngineInstalled
  ReadRegStr $0 HKLM "SOFTWARE\EqualizerAPO" "InstallPath"
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\EqualizerAPO.dll"
    StrCpy $0 "1"
  ${Else}
    StrCpy $0 "0"
  ${EndIf}
FunctionEnd

Section "Headroom" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; Upgrade: close the old app. The audio engine may still hold the old
  ; limiter DLL, which can be renamed but not overwritten while loaded.
  nsExec::Exec 'taskkill /IM Headroom.exe /F'
  Pop $1
  ${If} ${FileExists} "$INSTDIR\HeadroomLimiter.dll"
    Delete "$INSTDIR\HeadroomLimiter.dll.old"
    Rename "$INSTDIR\HeadroomLimiter.dll" "$INSTDIR\HeadroomLimiter.dll.old"
    Delete /REBOOTOK "$INSTDIR\HeadroomLimiter.dll.old"
  ${EndIf}

  File "..\build\Headroom.exe"
  File "..\build\HeadroomLimiter.dll"
  File "..\third_party\${ENGINE}"
  File "NOTICE.txt"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortCut "$SMPROGRAMS\Headroom.lnk" "$INSTDIR\Headroom.exe"

  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "Headroom"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "Headroom"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\Headroom.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ; Start with Windows, in the tray.
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Headroom" '"$INSTDIR\Headroom.exe" /tray'
SectionEnd

Section "Audio engine" SecEngine
  Call EngineInstalled
  ${If} $0 == "0"
    DetailPrint "Installing Equalizer APO (audio engine)..."
    MessageBox MB_OK|MB_ICONINFORMATION "Setup will now install the audio engine (Equalizer APO).$\r$\n$\r$\nIn the window that opens, tick the speakers and headphones you use, then click OK." /SD IDOK
    ExecWait '"$INSTDIR\${ENGINE}" /S' $1
    DetailPrint "Equalizer APO setup finished ($1)"
    Call EngineInstalled
    ${If} $0 == "0"
      MessageBox MB_OK|MB_ICONEXCLAMATION "The audio engine wasn't installed. You can install it later from the Headroom window (Install engine)." /SD IDOK
    ${EndIf}
  ${Else}
    DetailPrint "Equalizer APO is already installed."
  ${EndIf}

  ; Turn the boost on with the saved (or default) settings.
  ExecWait '"$INSTDIR\Headroom.exe" /apply'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /IM Headroom.exe /F'
  Pop $1
  ; Stop the boost first so the engine releases the limiter.
  ExecWait '"$INSTDIR\Headroom.exe" /remove'
  Sleep 1000

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Headroom"
  DeleteRegKey HKCU "Software\Headroom"
  Delete "$SMPROGRAMS\Headroom.lnk"
  Delete "$INSTDIR\Headroom.exe"
  Delete /REBOOTOK "$INSTDIR\HeadroomLimiter.dll"
  Delete /REBOOTOK "$INSTDIR\HeadroomLimiter.dll.old"
  Delete "$INSTDIR\${ENGINE}"
  Delete "$INSTDIR\NOTICE.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir /REBOOTOK "$INSTDIR"
  DeleteRegKey HKLM "${UNINST_KEY}"

  ReadRegStr $0 HKLM "SOFTWARE\EqualizerAPO" "InstallPath"
  ${If} ${FileExists} "$0\Uninstall.exe"
    MessageBox MB_YESNO|MB_ICONQUESTION "Also uninstall Equalizer APO, the audio engine Headroom used?$\r$\n$\r$\nChoose No if you use Equalizer APO for anything else." /SD IDNO IDNO done
    ExecWait '"$0\Uninstall.exe"'
    done:
  ${EndIf}
SectionEnd
