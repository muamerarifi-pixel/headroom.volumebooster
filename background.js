importScripts("dsp.js");

/*
 * Two engines:
 *  - Auto (content.js): boosts every page's <audio>/<video> automatically.
 *  - Deep capture (offscreen.js): tab-capture fallback for audio the page engine
 *    can't reach (DRM players, calls, Web Audio games). Chrome only allows this
 *    after a user gesture, so it starts from the popup or the keyboard shortcut.
 *
 * All state lives in chrome.storage so nothing is lost when Chrome puts this
 * service worker to sleep (the old version forgot the captured tab after ~30 s).
 */

const CAPTURE_KEY = "headroom.capture";
const NO_CAPTURE = { tabId: null, title: "", error: null };
let creatingOffscreen = null;

function blockedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|chrome-untrusted|view-source):/i.test(url) ||
    /^https:\/\/chrome(webstore)?\.google\.com\/webstore/i.test(url);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(stored[STORAGE_KEY]);
}

async function setSettings(settings) {
  await chrome.storage.local.set({ [STORAGE_KEY]: normalizeSettings(settings) });
}

async function getCapture() {
  const stored = await chrome.storage.session.get(CAPTURE_KEY);
  const cap = stored[CAPTURE_KEY] || NO_CAPTURE;
  if (cap.tabId && !(await hasOffscreen())) {
    await setCapture({ ...NO_CAPTURE });
    return { ...NO_CAPTURE };
  }
  return cap;
}

async function setCapture(cap) {
  await chrome.storage.session.set({ [CAPTURE_KEY]: cap });
}

// ---- offscreen processor ---------------------------------------------------

async function hasOffscreen() {
  if (chrome.offscreen.hasDocument) return chrome.offscreen.hasDocument();
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Capture tab audio and play limiter-protected output.",
      })
      .catch((err) => {
        if (!String(err?.message || err).includes("single offscreen")) throw err;
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function sendOffscreen(message) {
  if (!(await hasOffscreen())) return { ok: false, error: "Processor is not running." };
  try {
    return await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Processor unavailable." };
  }
}

// ---- badge -----------------------------------------------------------------

async function updateBadge(settings) {
  const s = settings || (await getSettings());
  try {
    const on = s.enabled && !s.bypass;
    const text = !s.enabled ? "off" : s.bypass ? "A/B" : `+${Math.round(s.boostDb)}`;
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: on ? "#7ea58a" : "#6a6c72" });
    if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#0a0b0d" });
  } catch {
    /* badge APIs unavailable */
  }
}

// ---- deep capture ----------------------------------------------------------

function notifyTab(tabId, captured) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "HR_CAPTURE_STATE", captured }).catch(() => {});
}

async function startCapture({ tabId, streamId, title }) {
  const prev = await getCapture();
  if (prev.tabId === tabId) return { ok: true };
  await ensureOffscreen();
  const settings = await getSettings();
  const res = await sendOffscreen({ type: "OFFSCREEN_START_TAB", streamId, settings });
  if (!res?.ok) {
    const error = res?.error || "Could not capture this tab.";
    await setCapture({ ...NO_CAPTURE, error });
    return { ok: false, error };
  }
  if (prev.tabId && prev.tabId !== tabId) notifyTab(prev.tabId, false);
  await setCapture({ tabId, title: title || "This tab", error: null });
  notifyTab(tabId, true);
  return { ok: true };
}

async function stopCapture(error = null) {
  const prev = await getCapture();
  await setCapture({ ...NO_CAPTURE, error });
  notifyTab(prev.tabId, false);
  if (await hasOffscreen()) {
    await sendOffscreen({ type: "OFFSCREEN_STOP" });
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* already closed */
    }
  }
  return { ok: true };
}

async function captureTab(tab) {
  if (!tab?.id || blockedUrl(tab.url)) return { ok: false, error: "Chrome pages can't be captured." };
  const cap = await getCapture();
  if (cap.tabId === tab.id) return { ok: true };
  try {
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    return await startCapture({ tabId: tab.id, streamId, title: tab.title });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Tab capture was blocked.";
    await setCapture({ ...NO_CAPTURE, error });
    return { ok: false, error };
  }
}

// ---- messages --------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string" || message.target === "offscreen") return;

  (async () => {
    switch (message.type) {
      case "HR_HELLO": {
        const cap = await getCapture();
        sendResponse({ captured: Boolean(sender.tab && cap.tabId === sender.tab.id) });
        return;
      }
      case "CAPTURE_STATE":
        sendResponse({ ok: true, capture: await getCapture() });
        return;
      case "CAPTURE_START":
        sendResponse(await startCapture(message));
        return;
      case "CAPTURE_STOP":
        sendResponse(await stopCapture());
        return;
      case "CAPTURE_METERS": {
        const res = await sendOffscreen({ type: "OFFSCREEN_METERS" });
        sendResponse(res?.ok ? res : { ok: false, meters: ZERO_METERS });
        return;
      }
      case "TRACK_ENDED":
        await stopCapture("Captured audio ended. It will be captured again next time you open Headroom.");
        sendResponse({ ok: true });
        return;
      default:
        sendResponse({ ok: false, error: "Unknown message." });
    }
  })();
  return true;
});

// Settings are the single source of truth: popup writes, everyone reacts.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEY]) return;
  const settings = normalizeSettings(changes[STORAGE_KEY].newValue);
  void updateBadge(settings);
  if (await hasOffscreen()) await sendOffscreen({ type: "OFFSCREEN_SETTINGS", settings });
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === "toggle-boost") {
    const s = await getSettings();
    s.enabled = !s.enabled;
    await setSettings(s);
    return;
  }
  if (command === "deep-capture") {
    const target = tab || (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    const cap = await getCapture();
    if (target && cap.tabId === target.id) await stopCapture();
    else await captureTab(target);
  }
});

chrome.tabs.onRemoved.addListener(async (id) => {
  const cap = await getCapture();
  if (cap.tabId === id) await stopCapture();
});

chrome.tabs.onUpdated.addListener(async (id, info) => {
  if (!info.title && info.status !== "complete") return;
  const cap = await getCapture();
  if (cap.tabId !== id) return;
  if (info.title) await setCapture({ ...cap, title: info.title });
  if (info.status === "complete") notifyTab(id, true); // new page in a captured tab: stay neutral
});

// Inject the auto engine into tabs that were already open, so it works without reloading them.
async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  await Promise.all(
    tabs
      .filter((t) => !t.discarded && !blockedUrl(t.url))
      .map(async (t) => {
        const target = { tabId: t.id, allFrames: true };
        try {
          await chrome.scripting.executeScript({ target, files: ["bridge.js"], world: "MAIN" });
          await chrome.scripting.executeScript({ target, files: ["dsp.js", "content.js"] });
        } catch {
          /* tab not scriptable */
        }
      }),
  );
}

chrome.runtime.onInstalled.addListener(async () => {
  await setSettings(await getSettings()); // migrate older settings
  await updateBadge();
  await injectIntoOpenTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void updateBadge();
});
