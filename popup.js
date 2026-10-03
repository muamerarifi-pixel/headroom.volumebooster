const $ = (id) => document.getElementById(id);

const ui = {
  enabled: $("enabled"),
  enabledLabel: $("enabled-label"),
  live: $("live"),
  mode: $("mode"),
  status: $("status"),
  site: $("site"),
  siteHost: $("site-host"),
  capture: $("capture"),
  stop: $("stop"),
  tabLabel: $("tab-label"),
  error: $("error"),
  boost: $("boost"),
  boostDb: $("boost-db"),
  boostPct: $("boost-pct"),
  bypass: $("bypass"),
  inFill: $("in-fill"),
  outFill: $("out-fill"),
  grFill: $("gr-fill"),
  inHold: $("in-hold"),
  outHold: $("out-hold"),
  inRead: $("in-read"),
  outRead: $("out-read"),
  grRead: $("gr-read"),
  lFill: $("l-fill"),
  rFill: $("r-fill"),
  clip: $("clip"),
};

let settings = normalizeSettings();
let tab = null;
let host = "";
let capture = { tabId: null, title: "", error: null };
let report = null; // what the page engine says about this tab
let lastMeters = ZERO_METERS;
let autoCaptureTried = false;
let capturing = false;

const isBlocked = (url) =>
  !url ||
  /^(chrome|chrome-extension|edge|about|devtools|chrome-untrusted|view-source):/i.test(url) ||
  /^https:\/\/chrome(webstore)?\.google\.com\/webstore/i.test(url);

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

const siteExcluded = () => Boolean(host) && settings.excludedSites.includes(host);
const capturedHere = () => Boolean(tab) && capture.tabId === tab.id;

function showError(message) {
  ui.error.hidden = !message;
  ui.error.textContent = message || "";
}

function formatPeak(peak) {
  if (peak < 0.0001) return "–∞";
  const db = gainToDb(peak);
  return `${db >= 0 ? "+" : ""}${db.toFixed(1)}`;
}

// ---- persistence (coalesced: one write in flight, latest value wins) --------

let writing = false;
let dirty = false;
async function persist() {
  dirty = true;
  if (writing) return;
  writing = true;
  try {
    while (dirty) {
      dirty = false;
      await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    }
  } finally {
    writing = false;
  }
}

// ---- rendering --------------------------------------------------------------

function renderSettings() {
  ui.enabled.checked = settings.enabled;
  ui.enabledLabel.textContent = settings.enabled ? "On" : "Off";
  ui.boost.value = String(settings.boostDb);
  ui.boostDb.textContent = formatDb(settings.boostDb);
  ui.boostPct.textContent = `${Math.round(dbToGain(settings.boostDb) * 100)}%`;
  ui.bypass.classList.toggle("active", settings.bypass);
  document.querySelectorAll("[data-style]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-style") === settings.style);
  });
  document.querySelectorAll("[data-scope]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-scope") === settings.scope);
  });
}

function setStatus(text, tone, mode, modeTone) {
  ui.status.textContent = text;
  ui.status.dataset.tone = tone;
  ui.mode.textContent = mode;
  ui.mode.dataset.tone = modeTone || tone;
}

function renderTab() {
  const blocked = !tab || isBlocked(tab.url);
  ui.tabLabel.textContent = tab?.title || "This tab";
  ui.siteHost.textContent = host || "this site";
  ui.site.checked = !siteExcluded();
  ui.site.disabled = blocked || !host;
  ui.capture.hidden = capturedHere();
  ui.capture.disabled = blocked || capturing || !settings.enabled || siteExcluded();
  ui.stop.hidden = !capturedHere();

  let liveNow = false;
  if (blocked) {
    setStatus("Chrome's own pages can't be boosted. Open a site with sound.", "idle", "—");
  } else if (!settings.enabled) {
    setStatus("Headroom is off. Switch it on (top right) to boost every tab.", "idle", "Off");
  } else if (siteExcluded()) {
    setStatus(`Boost is turned off for ${host}.`, "idle", "Off here");
  } else if (capturedHere()) {
    liveNow = true;
    setStatus("Deep capture is boosting this tab.", "ok", "Deep capture", "warn");
  } else if (capturing) {
    setStatus("Starting deep capture…", "idle", "Deep capture", "warn");
  } else if (report?.playing) {
    liveNow = true;
    const n = report.playing;
    setStatus(`Boosting ${n === 1 ? "the player" : `${n} players`} on this page automatically.`, "ok", "Auto");
  } else if (report?.waitingGesture) {
    setStatus("Click once anywhere on the page. Chrome needs that before Headroom can take over the audio.", "warn", "Waiting");
  } else if (report?.skippedPlaying) {
    setStatus("This player is protected or served from another site. Use Deep capture.", "warn", "Needs capture");
  } else if (settings.scope === "active" && report && !report.active) {
    setStatus("Waiting for this tab to be in front.", "idle", "Auto");
  } else {
    setStatus("Ready. Boost starts by itself as soon as this tab plays audio.", "idle", "Auto");
  }
  ui.live.hidden = !liveNow;
  if (!capturedHere() && capture.error) showError(capture.error);
}

function renderMeters(m) {
  lastMeters = m;
  ui.inFill.style.transform = `scaleX(${peakToWidth(m.peakIn) / 100})`;
  ui.outFill.style.transform = `scaleX(${peakToWidth(m.peakOut) / 100})`;
  ui.grFill.style.transform = `scaleX(${Math.min(100, (m.grDb / 18) * 100) / 100})`;
  ui.inHold.style.left = `${peakToWidth(m.peakHoldIn)}%`;
  ui.outHold.style.left = `${peakToWidth(m.peakHoldOut)}%`;
  ui.inRead.textContent = formatPeak(m.peakIn);
  ui.outRead.textContent = formatPeak(m.peakOut);
  ui.grRead.textContent = m.grDb < 0.15 ? "0.0" : m.grDb.toFixed(1);
  ui.lFill.style.setProperty("--w", String(peakToWidth(m.peakInL) / 100));
  ui.rFill.style.setProperty("--w", String(peakToWidth(m.peakInR) / 100));
  ui.clip.classList.toggle("on", m.clipped);
}

// ---- talking to the page engine and the background --------------------------

async function queryPage() {
  if (!tab || isBlocked(tab.url)) return null;
  try {
    const r = await chrome.tabs.sendMessage(tab.id, { type: "HR_QUERY" });
    return r?.ok ? r : null;
  } catch {
    return null; // no media in any frame yet, or the engine isn't in this tab
  }
}

async function refreshCapture() {
  try {
    const r = await chrome.runtime.sendMessage({ type: "CAPTURE_STATE" });
    if (r?.ok) capture = r.capture;
  } catch {
    /* worker waking up */
  }
}

async function startCapture({ auto } = {}) {
  if (!tab || capturing || capturedHere()) return;
  capturing = true;
  showError("");
  renderTab();
  try {
    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    } catch (err) {
      if (!auto) showError(err instanceof Error ? err.message : "Tab capture was blocked.");
      return;
    }
    const res = await chrome.runtime.sendMessage({
      type: "CAPTURE_START",
      tabId: tab.id,
      streamId,
      title: tab.title,
    });
    if (!res?.ok && !auto) showError(res?.error || "Could not capture this tab.");
  } finally {
    capturing = false;
    await refreshCapture();
    renderTab();
  }
}

// Opening the popup counts as a click on this tab, which is the one moment Chrome
// lets us capture it. If audio is playing that the page engine can't reach, take it.
async function maybeAutoCapture() {
  if (autoCaptureTried || !tab || isBlocked(tab.url)) return;
  if (!settings.enabled || siteExcluded() || capturedHere() || capturing) return;
  const fresh = await chrome.tabs.get(tab.id).catch(() => null);
  if (!fresh?.audible) return;
  if (report?.playing) return; // already boosted automatically
  autoCaptureTried = true;
  await startCapture({ auto: true });
}

// ---- loops: meters every frame (no overlapping requests), status ~4×/s -------

let inflight = false;
async function meterTick() {
  if (!inflight && document.visibilityState === "visible") {
    inflight = true;
    try {
      if (capturedHere()) {
        const r = await chrome.runtime.sendMessage({ type: "CAPTURE_METERS" }).catch(() => null);
        renderMeters(r?.ok ? r.meters : ZERO_METERS);
      } else {
        report = await queryPage();
        renderMeters(report?.meters || ZERO_METERS);
      }
    } finally {
      inflight = false;
    }
  }
  requestAnimationFrame(meterTick);
}

async function statusTick() {
  await refreshCapture();
  renderTab();
  await maybeAutoCapture();
}

// ---- controls -----------------------------------------------------------------

ui.capture.addEventListener("click", () => void startCapture());

ui.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
  autoCaptureTried = true; // don't immediately re-capture what the user just stopped
  await refreshCapture();
  renderTab();
});

ui.site.addEventListener("change", async () => {
  if (!host) return;
  const set = new Set(settings.excludedSites);
  if (ui.site.checked) set.delete(host);
  else set.add(host);
  settings.excludedSites = [...set];
  void persist();
  if (!ui.site.checked && capturedHere()) {
    await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
    await refreshCapture();
  }
  renderTab();
});

ui.enabled.addEventListener("change", () => {
  settings.enabled = ui.enabled.checked;
  if (!settings.enabled) settings.bypass = false;
  renderSettings();
  renderTab();
  void persist();
});

ui.boost.addEventListener("input", () => {
  settings.boostDb = Number(ui.boost.value);
  settings.enabled = true;
  renderSettings();
  void persist();
});

ui.bypass.addEventListener("click", () => {
  settings.bypass = !settings.bypass;
  renderSettings();
  void persist();
});

document.querySelectorAll("[data-boost]").forEach((btn) => {
  btn.addEventListener("click", () => {
    settings.boostDb = Number(btn.getAttribute("data-boost"));
    settings.enabled = true;
    renderSettings();
    void persist();
  });
});

document.querySelector("[data-boost-auto]").addEventListener("click", () => {
  if (lastMeters.rmsIn < 0.004) return;
  const needed = 20 * Math.log10(0.12 / lastMeters.rmsIn);
  settings.boostDb = Math.round(Math.min(BOOST_MAX, Math.max(BOOST_MIN, needed)) * 2) / 2;
  settings.enabled = true;
  renderSettings();
  void persist();
});

document.querySelectorAll("[data-style]").forEach((btn) => {
  btn.addEventListener("click", () => {
    settings.style = btn.getAttribute("data-style");
    settings.params = { ...STYLE_PARAMS[settings.style] };
    renderSettings();
    void persist();
  });
});

document.querySelectorAll("[data-scope]").forEach((btn) => {
  btn.addEventListener("click", () => {
    settings.scope = btn.getAttribute("data-scope");
    renderSettings();
    void persist();
  });
});

// ---- start ----------------------------------------------------------------------

(async () => {
  const [stored, tabs] = await Promise.all([
    chrome.storage.local.get(STORAGE_KEY),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  settings = normalizeSettings(stored[STORAGE_KEY]);
  tab = tabs[0] || null;
  host = hostOf(tab?.url);
  renderSettings();
  [report] = await Promise.all([queryPage(), refreshCapture()]);
  renderTab();
  if (report?.meters) renderMeters(report.meters);
  await maybeAutoCapture();
  requestAnimationFrame(meterTick);
  setInterval(() => void statusTick(), 250);
})();
