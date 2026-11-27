# Chrome Web Store Submission Guide

Ready-to-paste permission justifications and privacy disclosures for the Chrome Web Store Developer Dashboard when uploading `headroom-store-upload.zip`.

## Single Purpose Description

Automatically boosts and limiter-protects audio playing in browser tabs locally on the user's device, with per-site profiles, Auto-Level, Voice Clarity, and an on-demand Deep Capture fallback for protected/DRM players.

## Privacy Policy URL

`https://github.com/muamerarifi-pixel/headroom.volumebooster/blob/main/PRIVACY.md`

## Permission Justifications

- **`host_permissions` (`<all_urls>`)**: Required so the automatic page audio engine (`content.js` + `bridge.js`) can detect `<audio>` and `<video>` elements on any website the user visits and route them through the local Web Audio limiter without requiring the user to click the extension on every tab. No page text, cookies, or personal data are read or transmitted.
- **`tabCapture`**: Used only for the optional **Deep Capture** fallback when a tab's audio cannot be reached via Web Audio (for example, DRM-protected streams such as Netflix/Spotify, WebRTC calls, or cross-origin media without CORS). Capture starts only after an explicit user gesture (opening the popup or pressing `Alt+Shift+B`).
- **`offscreen`**: Required in Manifest V3 to host the Web Audio `AudioContext` that processes and plays back the MediaStream obtained from `chrome.tabCapture` during Deep Capture, since service workers do not have access to the Web Audio API.
- **`storage`**: Stores user preferences (boost level, limiter style, Auto-Level, Voice Clarity, active-tab scope, per-site pinned profiles, and excluded hostnames) locally via `chrome.storage.local`, and stores transient Deep Capture tab state via `chrome.storage.session` across service worker restarts.
- **`tabs`**: Used to read the active tab's title, URL hostname, audible state, and active status so Headroom can display the current tab in the popup, apply per-site pinned/excluded rules, enforce "Active tab only" scope during Deep Capture, update the toolbar badge, and stop capture when a captured tab closes.
- **`scripting`**: Used once on extension install/update (`chrome.runtime.onInstalled`) to inject the audio engine into already-open HTTP/HTTPS tabs so boosting works immediately without forcing the user to reload their tabs.
- **Remote code**: **No** — all JavaScript (`dsp.js`, `content.js`, `bridge.js`, `background.js`, `offscreen.js`, `popup.js`) is bundled locally inside the extension package.

## Data Usage Certification

- Does not collect or use any user data (all checkboxes unchecked).
- Certify all three Chrome Web Store limited-use disclosures.
