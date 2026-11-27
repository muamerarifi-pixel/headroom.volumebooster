const $ = (id) => document.getElementById(id);

const ui = {
  enabled: $("enabled"),
  enabledLabel: $("enabled-label"),
  live: $("live"),
  sitesBtn: $("sites-btn"),
  mainView: $("main-view"),
  sitesView: $("sites-view"),
  sitesBack: $("sites-back"),
  sitesClear: $("sites-clear"),
  sitesEmpty: $("sites-empty"),
  pinnedSection: $("pinned-section"),
  pinnedList: $("pinned-list"),
  excludedSection: $("excluded-section"),
  excludedList: $("excluded-list"),
  mode: $("mode"),
  status: $("status"),
  site: $("site"),
  siteHost: $("site-host"),
  pin: $("pin"),
  captureFull: $("capture-full"),
  captureSubtle: $("capture-subtle"),
  captureLink: $("capture-link"),
  capture: $("capture"),
  stop: $("stop"),
  tabLabel: $("tab-label"),
  error: $("error"),
  boostPanel: $("boost-panel"),
  boost: $("boost"),
  boostDb: $("boost-db"),
  boostUnit: $("boost-unit"),
  boostPct: $("boost-pct"),
  profileBadge: $("profile-badge"),
  faderMid: $("fader-mid"),
  faderMax: $("fader-max"),
  autoLevel: $("auto-level"),
  voice: $("voice"),
  mono: $("mono"),
  bypass: $("bypass"),
  styleHint: $("style-hint"),
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
let capture = { tabId: null, title: "", url: "", error: null, errorTabId: null };
let report = null; // what the page engine says about this tab
let lastMeters = ZERO_METERS;
let autoCaptureTried = false;
let capturing = false;
let localError = "";
let showingSites = false;

const isBlocked = (url) =>
  !url ||
  /^(chrome|chrome-extension|edge|about|devtools|chrome-untrusted|view-source):/i.test(url) ||
  /^https:\/\/chrome(webstore)?\.google\.com\/webstore/i.test(url);

const effective = () => resolveSettingsForHost(settings, host);
const siteExcluded = () => Boolean(host) && settings.excludedSites.includes(host);
const sitePinned = () => Boolean(host) && Boolean(settings.siteOverrides[host]);
const capturedHere = () => Boolean(tab) && capture.tabId === tab.id;

function showError(message) {
  localError = message || "";
  renderError();
}

function renderError() {
  const capErr =
    !capturedHere() &&
    capture.error &&
    (!capture.errorTabId || (tab && capture.errorTabId === tab.id))
      ? capture.error
      : "";
  const msg = localError || capErr;
  ui.error.hidden = !msg;
  ui.error.textContent = msg;
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

function updateAudioProfile(mutator) {
  if (sitePinned()) {
    const ov = normalizeOverride(settings.siteOverrides[host], settings);
    mutator(ov);
    settings.siteOverrides[host] = normalizeOverride(ov, settings);
  } else {
    mutator(settings);
    settings = normalizeSettings(settings);
  }
}

// ---- rendering --------------------------------------------------------------

function renderFaderTrack(boostDb) {
  const pct = ((boostDb - BOOST_MIN) / (BOOST_MAX - BOOST_MIN)) * 100;
  ui.boost.style.setProperty("--fill", `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
  ui.boost.classList.toggle("dim", !settings.enabled || settings.bypass || siteExcluded());
}

function renderReadout() {
  const eff = effective();
  renderFaderTrack(eff.boostDb);
  if (eff.autoLevel) {
    const liveAuto = typeof lastMeters.autoGainDb === "number";
    ui.boostDb.textContent = liveAuto ? formatDb(lastMeters.autoGainDb) : "Auto";
    ui.boostUnit.textContent = liveAuto ? "dB" : "";
    ui.boostPct.textContent = `Max ${formatDb(eff.boostDb)} dB`;
    ui.faderMid.textContent = "+12 max";
    ui.faderMax.textContent = "+24";
  } else {
    ui.boostDb.textContent = formatDb(eff.boostDb);
    ui.boostUnit.textContent = "dB";
    ui.boostPct.textContent = `${Math.round(dbToGain(eff.boostDb) * 100)}%`;
    ui.faderMid.textContent = "+12";
    ui.faderMax.textContent = "+24";
  }
}

function savedSitesCount() {
  return Object.keys(settings.siteOverrides).length + settings.excludedSites.length;
}

function renderSitesButton() {
  const count = savedSitesCount();
  ui.sitesBtn.classList.toggle("active", showingSites);
  if (showingSites) {
    ui.sitesBtn.textContent = "Done";
  } else {
    ui.sitesBtn.textContent = count > 0 ? `Sites · ${count}` : "Sites";
  }
}

function describeOverride(ov) {
  const parts = [];
  if (ov.autoLevel) parts.push(`Auto ≤${formatDb(ov.boostDb)} dB`);
  else parts.push(`${formatDb(ov.boostDb)} dB`);
  const styleLabel = ov.style.charAt(0).toUpperCase() + ov.style.slice(1);
  parts.push(styleLabel);
  if (ov.voiceClarity) parts.push("Voice");
  if (ov.mono) parts.push("Mono");
  return parts.join(" · ");
}

function renderSitesView() {
  renderSitesButton();
  ui.mainView.hidden = showingSites;
  ui.sitesView.hidden = !showingSites;
  if (!showingSites) return;

  const pinnedEntries = Object.entries(settings.siteOverrides).sort(([a], [b]) => a.localeCompare(b));
  const excludedHosts = [...settings.excludedSites].sort((a, b) => a.localeCompare(b));
  const total = pinnedEntries.length + excludedHosts.length;

  ui.sitesEmpty.hidden = total > 0;
  ui.sitesClear.hidden = total === 0;

  ui.pinnedSection.hidden = pinnedEntries.length === 0;
  ui.pinnedList.textContent = "";
  for (const [h, ov] of pinnedEntries) {
    const li = document.createElement("li");
    li.className = "site-item";
    const info = document.createElement("div");
    info.className = "site-item-info";
    const title = document.createElement("span");
    title.className = "site-item-host";
    title.textContent = h;
    const meta = document.createElement("span");
    meta.className = "site-item-meta";
    meta.textContent = describeOverride(ov);
    info.append(title, meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "site-item-action";
    btn.textContent = "Reset";
    btn.addEventListener("click", () => {
      delete settings.siteOverrides[h];
      renderSettings();
      renderTab();
      renderSitesView();
      void persist();
    });

    li.append(info, btn);
    ui.pinnedList.append(li);
  }

  ui.excludedSection.hidden = excludedHosts.length === 0;
  ui.excludedList.textContent = "";
  for (const h of excludedHosts) {
    const li = document.createElement("li");
    li.className = "site-item";
    const info = document.createElement("div");
    info.className = "site-item-info";
    const title = document.createElement("span");
    title.className = "site-item-host";
    title.textContent = h;
    const meta = document.createElement("span");
    meta.className = "site-item-meta";
    meta.textContent = "Boost turned off";
    info.append(title, meta);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "site-item-action";
    btn.textContent = "Enable";
    btn.addEventListener("click", () => {
      settings.excludedSites = settings.excludedSites.filter((x) => x !== h);
      renderSettings();
      renderTab();
      renderSitesView();
      void persist();
    });

    li.append(info, btn);
    ui.excludedList.append(li);
  }
}

function renderSettings() {
  const eff = effective();
  const pinned = sitePinned();
  ui.enabled.checked = settings.enabled;
  ui.enabledLabel.textContent = settings.enabled ? "On" : "Off";
  ui.boost.value = String(eff.boostDb);
  ui.profileBadge.textContent = pinned ? `Pinned · ${host}` : "Global profile";
  ui.profileBadge.classList.toggle("pinned", pinned);
  renderReadout();
  renderSitesButton();

  ui.autoLevel.classList.add("tone-ok");
  ui.autoLevel.classList.toggle("active", eff.autoLevel);
  ui.voice.classList.add("tone-ok");
  ui.voice.classList.toggle("active", eff.voiceClarity);
  ui.mono.classList.add("tone-ok");
  ui.mono.classList.toggle("active", eff.mono);
  ui.bypass.classList.toggle("active", settings.bypass);

  document.querySelectorAll("[data-boost]").forEach((btn) => {
    const val = Number(btn.getAttribute("data-boost"));
    btn.classList.toggle("active", !eff.autoLevel && Math.abs(eff.boostDb - val) < 0.01);
  });

  document.querySelectorAll("[data-style]").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-style") === eff.style);
  });
  ui.styleHint.textContent = STYLE_DESCRIPTIONS[eff.style] || "";

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
  const pinned = sitePinned();
  ui.tabLabel.textContent = tab?.title || "This tab";
  ui.siteHost.textContent = host || "this site";
  ui.site.checked = !siteExcluded();
  ui.site.disabled = blocked || !host;

  ui.pin.disabled = blocked || !host || siteExcluded();
  ui.pin.classList.toggle("active", pinned);
  ui.pin.textContent = pinned ? "Pinned ×" : "Pin site";
  ui.pin.title = pinned
    ? `Unpin ${host} and return to your Global profile`
    : `Save a separate boost & limiter profile for ${host || "this site"}`;

  const autoLive =
    !blocked && settings.enabled && !siteExcluded() && !capturedHere() && !capturing && Boolean(report?.playing);

  ui.captureFull.hidden = autoLive;
  ui.captureSubtle.hidden = !autoLive;
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
    setStatus("Click once anywhere on the page so Chrome allows Headroom to boost audio.", "warn", "Waiting");
  } else if (report?.skippedPlaying) {
    setStatus("This player is protected or cross-origin. Use Deep capture.", "warn", "Needs capture");
  } else if (settings.scope === "active" && report && !report.active) {
    setStatus("Waiting for this tab to be in front.", "idle", "Auto");
  } else {
    setStatus("Ready. Boost starts automatically as soon as this tab plays audio.", "idle", "Auto");
  }
  ui.live.hidden = !liveNow;
  renderError();
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
  if (effective().autoLevel) renderReadout();
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
      url: tab.url,
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

// ---- adaptive meter loop (25 fps when live, 3 Hz when idle) -----------------

function nextMeterDelay() {
  if (showingSites) return 350;
  if (capturedHere() || report?.playing) return 40;
  if (report?.hooked || report?.skippedPlaying) return 150;
  return 350;
}

async function meterTick() {
  if (document.visibilityState === "visible" && !showingSites) {
    try {
      if (capturedHere()) {
        const r = await chrome.runtime.sendMessage({ type: "CAPTURE_METERS" }).catch(() => null);
        renderMeters(r?.ok ? r.meters : ZERO_METERS);
      } else {
        report = await queryPage();
        renderMeters(report?.meters || ZERO_METERS);
      }
    } catch {
      /* ignore transient IPC failure */
    }
  }
  setTimeout(() => void meterTick(), nextMeterDelay());
}

async function statusTick() {
  await refreshCapture();
  renderTab();
  await maybeAutoCapture();
}

// ---- controls -----------------------------------------------------------------

ui.sitesBtn.addEventListener("click", () => {
  showingSites = !showingSites;
  renderSitesView();
});

ui.sitesBack.addEventListener("click", () => {
  showingSites = false;
  renderSitesView();
});

ui.sitesClear.addEventListener("click", () => {
  settings.siteOverrides = {};
  settings.excludedSites = [];
  renderSettings();
  renderTab();
  renderSitesView();
  void persist();
});

ui.capture.addEventListener("click", () => void startCapture());
ui.captureLink.addEventListener("click", () => void startCapture());

ui.stop.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CAPTURE_STOP" });
  autoCaptureTried = true; // don't immediately re-capture what the user just stopped
  await refreshCapture();
  renderTab();
});

ui.error.addEventListener("click", async () => {
  localError = "";
  capture.error = null;
  capture.errorTabId = null;
  renderError();
  await chrome.runtime.sendMessage({ type: "CAPTURE_CLEAR_ERROR" }).catch(() => {});
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
  renderSettings();
  renderTab();
});

ui.pin.addEventListener("click", () => {
  if (!host || siteExcluded()) return;
  if (sitePinned()) {
    delete settings.siteOverrides[host];
  } else {
    settings.siteOverrides[host] = normalizeOverride(
      {
        boostDb: settings.boostDb,
        style: settings.style,
        autoLevel: settings.autoLevel,
        voiceClarity: settings.voiceClarity,
        mono: settings.mono,
      },
      settings,
    );
  }
  renderSettings();
  renderTab();
  void persist();
});

ui.enabled.addEventListener("change", () => {
  settings.enabled = ui.enabled.checked;
  if (!settings.enabled) settings.bypass = false;
  renderSettings();
  renderTab();
  void persist();
});

ui.boost.addEventListener("input", () => {
  const val = Number(ui.boost.value);
  updateAudioProfile((p) => {
    p.boostDb = val;
  });
  settings.enabled = true;
  renderSettings();
  void persist();
});

// Mouse-wheel fine nudge (±0.5 dB) on the fader / boost panel.
ui.boostPanel.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaY) < 1) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? BOOST_STEP : -BOOST_STEP;
    updateAudioProfile((p) => {
      const next = Math.round((p.boostDb + delta) / BOOST_STEP) * BOOST_STEP;
      p.boostDb = clampBoost(next, p.boostDb);
    });
    settings.enabled = true;
    renderSettings();
    void persist();
  },
  { passive: false },
);

ui.autoLevel.addEventListener("click", () => {
  updateAudioProfile((p) => {
    p.autoLevel = !p.autoLevel;
    // Give Auto-Level reasonable headroom if the ceiling was sitting near 0 dB.
    if (p.autoLevel && p.boostDb < 4) p.boostDb = 16;
  });
  settings.enabled = true;
  renderSettings();
  void persist();
});

ui.voice.addEventListener("click", () => {
  updateAudioProfile((p) => {
    p.voiceClarity = !p.voiceClarity;
  });
  settings.enabled = true;
  renderSettings();
  void persist();
});

ui.mono.addEventListener("click", () => {
  updateAudioProfile((p) => {
    p.mono = !p.mono;
  });
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
    const val = Number(btn.getAttribute("data-boost"));
    updateAudioProfile((p) => {
      p.boostDb = val;
      if (val === 0) p.autoLevel = false; // 0 dB (Unity) should actually play at 0 dB
    });
    settings.enabled = true;
    renderSettings();
    void persist();
  });
});

document.querySelectorAll("[data-style]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const style = btn.getAttribute("data-style");
    updateAudioProfile((p) => {
      p.style = style;
    });
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
  host = hostOfUrl(tab?.url);
  renderSettings();
  [report] = await Promise.all([queryPage(), refreshCapture()]);
  renderTab();
  if (report?.meters) renderMeters(report.meters);
  await maybeAutoCapture();
  void meterTick();
  setInterval(() => void statusTick(), 300);
})();
