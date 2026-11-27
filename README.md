# Headroom

Automatic, limiter-protected volume boost. Audio stays on your device.

## Windows app: boost everything on your PC

**[Download Headroom-Setup.exe](https://github.com/muamerarifi-pixel/headroom.volumebooster/releases/latest/download/Headroom-Setup.exe)** (Windows 10/11, 64-bit)

The Windows app boosts **every** sound the PC plays (browsers, Spotify, games, video players, calls) by up to +24 dB, all the time, with a limiter that stops clipping. See [windows/README.md](windows/README.md) for setup and how it works.

## Chrome extension: boost browser tabs

![Headroom](docs/screenshot.png)

- **Automatic:** any tab that plays audio or video is boosted the moment it starts. Nothing to click.
- **Up to +24 dB with studio-grade limiting:** true-bypassable compressor in Transparent mode, 25 Hz infrasonic rumble filter, and a distortion-free 4x-oversampled safety ceiling that keeps output below 0 dBFS.
- **Auto-Level (gated AGC):** smoothly rides gain over a ~1.5 s loudness window to keep quiet and loud videos consistent, with a silence gate so pauses don't boost hiss.
- **Voice Clarity:** one-click 90 Hz rumble cut and gentle vocal presence lift for lectures, podcasts, and calls.
- **Per-site pinning & switch:** turn boost off for any website, or pin a separate boost, Auto-Level, Voice, and limiter profile to a specific host.
- **Three limiter styles:** Transparent, Balanced and Night.
- **"Active tab" mode:** boost only the tab you're looking at (works in both Auto and Deep capture).
- **Deep capture** for players the page boost can't reach (Spotify, Netflix, web calls): open the popup on that tab, or press `Alt+Shift+B`.

## Install

1. **[Download headroom.zip](https://github.com/muamerarifi-pixel/headroom.volumebooster/releases/latest/download/headroom.zip)** and unzip it. You get a folder named `headroom`.
2. Move that folder somewhere permanent (for example `Documents/Extensions/headroom`). Chrome loads the extension from this folder, so don't delete it.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the `headroom` folder (the one that contains `manifest.json`).

Works in Chrome, Edge, Brave and Opera (version 116 or newer).

## Update

Download [headroom.zip](https://github.com/muamerarifi-pixel/headroom.volumebooster/releases/latest/download/headroom.zip) again, replace the files in your folder, then click the reload ↻ icon on Headroom's card in `chrome://extensions`.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Alt+Shift+H` | Turn Headroom on or off |
| `Alt+Shift+B` | Deep-capture the current tab (press again to stop) |

Change them at `chrome://extensions/shortcuts`.

## Privacy

All audio is processed locally in your browser. Headroom has no servers, no analytics and no accounts. Nothing is recorded or uploaded. See [PRIVACY.md](PRIVACY.md) for the full policy.
