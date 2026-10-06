# Headroom for Windows

Boosts the volume of **everything** your PC plays (browsers, Spotify, games, video players, Teams/Discord/Zoom calls, system sounds) by up to **+24 dB**, with a brickwall limiter so the louder sound never clips. It runs all the time, including after a restart and when the Headroom window is closed.

**[Download Headroom-Setup.exe](dist/Headroom-Setup.exe)** (Windows 10/11, 64-bit)

## Install

1. Run `Headroom-Setup.exe`. Windows SmartScreen may say "Windows protected your PC" because the installer isn't code-signed. Click **More info → Run anyway**.
2. Setup installs the audio engine (Equalizer APO). A **Device Selector** window opens: **tick the speakers and headphones you listen on** and click OK.
3. If Windows asks to restart, restart. If you can't hear a difference yet, restart once anyway.

Headroom then sits in the taskbar tray (click the `^` arrow if you can't see it).

## Use

| | |
|---|---|
| **Boost slider** | 0 to +24 dB in 0.5 dB steps (default +8 dB) |
| **Transparent** | Pure gain plus limiter. Cleanest sound. |
| **Balanced** | Gentle compression, so quiet parts come up too. |
| **Night** | Strong compression: quiet dialogue up, explosions down. |
| **Alt+Shift+H** | Turn the boost on or off from anywhere |
| **Tray icon** | Left click opens the window. Right click gives quick presets. |

Closing the window, or choosing **Close** in the tray menu, leaves the boost running. To stop it, untick **Boost on**.

Headroom shows whether your current output device is set up. If it says a device "isn't set up" (for example new headphones), click **Audio devices…** and tick it.

## How it works

Windows doesn't let a normal app turn up other apps' sound past 100%. The boost has to happen inside the Windows audio engine itself, which only an **Audio Processing Object (APO)** can do. Headroom uses [Equalizer APO](https://sourceforge.net/projects/equalizerapo/), a widely used open-source APO, as that host:

```
any app ──► Windows audio engine ──► Equalizer APO ──► HeadroomLimiter.dll ──► speakers
                                                         gain → compressor → look-ahead limiter (−1 dBFS)
```

- `HeadroomLimiter.dll` is a small VST 2-compatible effect (no Steinberg SDK needed). The limiter looks 2 ms ahead, so peaks are caught before they happen and output never goes above −1 dBFS.
- `Headroom.exe` is only the control panel. It writes `config\headroom.txt` in Equalizer APO's folder, which Equalizer APO reloads within a moment.
- Headroom replaces Equalizer APO's demo config (a −6 dB preamp and a bass boost) after saving a backup as `config.txt.before-headroom`. If you already had your own Equalizer APO config, Headroom keeps it and adds one `Include: headroom.txt` line at the end.

### Limits

- Apps that bypass the Windows mixer (ASIO, or WASAPI *exclusive* mode in some audio players and games) skip all APOs, so they aren't boosted.
- If Windows **Audio enhancements** are off for a device (Settings → Sound → *device* → Audio enhancements), APOs are bypassed. Headroom warns you when this happens.
- Bluetooth devices sometimes need to be ticked again in **Audio devices…** after pairing.

## Uninstall

Settings → Apps → **Headroom** → Uninstall. The uninstaller turns the boost off and asks whether to remove Equalizer APO too.

## Build from source

Builds on Linux, WSL or MSYS2 with mingw-w64 and NSIS:

```sh
sudo apt install mingw-w64 nsis   # optional: wine, to run the plugin ABI test
./build.sh                        # → dist/Headroom-Setup.exe
```

`build.sh` runs the DSP unit tests, builds `HeadroomLimiter.dll` and `Headroom.exe`, downloads the Equalizer APO 1.4.2 installer (checked against its SHA-256) and packages everything with NSIS.

| Path | What |
|---|---|
| `src/headroom_dsp.h` | Gain, compressor and look-ahead limiter (shared by plugin and tests) |
| `src/plugin.c` | `HeadroomLimiter.dll`, the effect Equalizer APO runs |
| `src/app.c` | `Headroom.exe`, the tray app |
| `installer/headroom.nsi` | Installer script |
| `tests/` | DSP test (native) and plugin host test (Windows/Wine) |

Equalizer APO is © Jonas Thedering, GPL v2+. It is bundled unmodified; see `installer/NOTICE.txt`.
