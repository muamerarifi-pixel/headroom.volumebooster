/*
 * Headroom page engine.
 * Runs in every frame of every page. When an <audio>/<video> starts playing it
 * is routed through the limiter graph automatically — no clicks needed.
 * Nothing happens (no AudioContext, no CPU) on pages that never play media.
 */
(() => {
  // State shared across re-injections (e.g. after the extension updates), so a
  // newer copy can adopt elements an older copy already routed.
  const S = (globalThis.__headroomState ||= {
    gen: 0,
    ctx: null,
    graph: null,
    hooked: [],
    hookedSet: new WeakSet(),
  });
  const gen = ++S.gen;
  const live = () => gen === S.gen;

  const watchedSet = new WeakSet();
  const watched = new Set();
  const busy = new WeakSet();
  const skipped = new Map(); // element -> reason

  let settings = normalizeSettings();
  let settingsLoaded = false;
  let captured = false; // this tab is under Deep capture: stay neutral
  let helloPromise = null;
  let waitingGesture = false;
  let idleTimer = 0;
  const topHost = getTopHost();

  function getTopHost() {
    try {
      const ao = location.ancestorOrigins;
      const origin = ao && ao.length ? ao[ao.length - 1] : location.origin;
      return new URL(origin).hostname;
    } catch {
      return location.hostname;
    }
  }

  const isExcluded = () => settings.excludedSites.includes(topHost);

  function boostActive() {
    return (
      settings.enabled &&
      !captured &&
      !isExcluded() &&
      (settings.scope !== "active" || document.visibilityState === "visible")
    );
  }

  function apply() {
    if (!S.graph) return;
    S.graph.applySettings(boostActive() ? settings : { ...settings, enabled: false });
  }

  // Can this element be routed without going silent?
  function classify(el) {
    if (el.srcObject) return "stream"; // WebRTC / calls → Deep capture
    if (el.mediaKeys) return "protected"; // DRM (Netflix, Spotify…) → Deep capture
    const src = el.currentSrc || el.src;
    if (!src) return "pending";
    let url;
    try {
      url = new URL(src, location.href);
    } catch {
      return "pending";
    }
    if (url.protocol === "blob:" || url.protocol === "data:") return "ok";
    if (url.origin === location.origin) return "ok";
    if (el.crossOrigin !== null) return "ok"; // CORS-enabled media is readable
    return "cross-origin"; // Chrome would output silence → Deep capture
  }

  function hello() {
    if (!helloPromise) {
      helloPromise = Promise.race([
        chrome.runtime
          .sendMessage({ type: "HR_HELLO" })
          .then((r) => {
            if (r && typeof r.captured === "boolean") captured = r.captured;
          })
          .catch(() => {}),
        new Promise((r) => setTimeout(r, 400)),
      ]);
    }
    return helloPromise;
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise((r) => setTimeout(r, ms))]);
  }

  async function ensureContext() {
    if (!S.ctx || S.ctx.state === "closed") {
      S.ctx = new AudioContext({ latencyHint: "interactive" });
      S.graph = createGraph(S.ctx);
      S.graph.output.connect(S.ctx.destination);
      apply();
    }
    if (S.ctx.state !== "running") {
      try {
        await withTimeout(S.ctx.resume(), 500);
      } catch {
        /* blocked by autoplay policy */
      }
    }
    return S.ctx.state === "running";
  }

  function waitForGesture() {
    if (waitingGesture) return;
    waitingGesture = true;
    const retry = () => {
      window.removeEventListener("pointerdown", retry, true);
      window.removeEventListener("keydown", retry, true);
      waitingGesture = false;
      if (!live()) return;
      for (const el of watched) void consider(el);
    };
    window.addEventListener("pointerdown", retry, true);
    window.addEventListener("keydown", retry, true);
  }

  function wake() {
    clearTimeout(idleTimer);
    if (S.ctx && S.ctx.state === "suspended") S.ctx.resume().catch(() => {});
  }

  // Suspend the audio thread when nothing has played for a while (saves CPU/battery).
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!live() || !S.ctx || S.ctx.state !== "running") return;
      if (S.hooked.some((el) => !el.paused)) return;
      S.ctx.suspend().catch(() => {});
    }, 15000);
  }

  function onElementEvent(e) {
    if (!live()) return;
    const el = e.currentTarget;
    if (e.type === "play") {
      if (S.hookedSet.has(el)) wake();
      return;
    }
    if (e.type === "pause" || e.type === "ended") {
      if (S.hookedSet.has(el)) scheduleIdle();
      return;
    }
    void consider(el);
  }

  function watch(el) {
    if (watchedSet.has(el)) return;
    watchedSet.add(el);
    watched.add(el);
    for (const type of ["playing", "volumechange", "play", "pause", "ended"]) {
      el.addEventListener(type, onElementEvent);
    }
  }

  async function consider(el) {
    if (!live() || !(el instanceof HTMLMediaElement)) return;
    watch(el);
    if (S.hookedSet.has(el)) {
      if (!el.paused) wake();
      return;
    }
    if (busy.has(el) || !settingsLoaded || !boostActive()) return;
    // Only route once audio is actually flowing (also guarantees DRM keys are attached).
    if (el.paused || el.readyState < 3 || el.muted || el.volume === 0) return;

    const kind = classify(el);
    if (kind !== "ok") {
      if (kind !== "pending") skipped.set(el, kind);
      return;
    }

    busy.add(el);
    try {
      await hello();
      if (!boostActive()) return;
      const running = await ensureContext();
      if (!live() || S.hookedSet.has(el)) return;
      if (!running) {
        waitForGesture();
        return;
      }
      if (classify(el) !== "ok") return;
      let source;
      try {
        source = S.ctx.createMediaElementSource(el);
      } catch {
        skipped.set(el, "in-use"); // the page already routes it through its own Web Audio
        return;
      }
      source.connect(S.graph.input);
      S.hookedSet.add(el);
      S.hooked.push(el);
      skipped.delete(el);
      apply();
    } finally {
      busy.delete(el);
    }
  }

  function scan() {
    if (!live()) return;
    document.querySelectorAll("audio,video").forEach((el) => void consider(el));
    for (const el of watched) void consider(el);
  }

  function prune() {
    S.hooked = S.hooked.filter((el) => el.isConnected || !el.paused);
    for (const el of watched) {
      if (!el.isConnected && el.paused && !S.hookedSet.has(el)) {
        watched.delete(el);
        skipped.delete(el);
      }
    }
  }

  function report() {
    prune();
    const reasons = {};
    let skippedPlaying = 0;
    for (const [el, reason] of skipped) {
      if (el.paused) continue;
      skippedPlaying++;
      reasons[reason] = (reasons[reason] || 0) + 1;
    }
    return {
      ok: true,
      hooked: S.hooked.length,
      playing: S.hooked.filter((el) => !el.paused).length,
      skippedPlaying,
      reasons,
      waitingGesture,
      active: boostActive(),
      captured,
      meters: S.graph ? S.graph.meters() : ZERO_METERS,
    };
  }

  // ---- event wiring -------------------------------------------------------

  const docHandler = (e) => {
    if (live() && e.target instanceof HTMLMediaElement) void consider(e.target);
  };
  for (const type of ["playing", "volumechange", "loadeddata"]) {
    document.addEventListener(type, docHandler, true);
  }

  document.addEventListener(
    "headroom:media",
    (e) => {
      const el = e.relatedTarget;
      if (live() && el instanceof HTMLMediaElement) void consider(el);
    },
    true,
  );

  document.addEventListener("visibilitychange", () => {
    if (!live()) return;
    apply();
    if (boostActive()) scan();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!live() || area !== "local" || !changes[STORAGE_KEY]) return;
    settings = normalizeSettings(changes[STORAGE_KEY].newValue);
    apply();
    if (boostActive()) scan();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!live() || !msg) return;
    if (msg.type === "HR_CAPTURE_STATE") {
      captured = Boolean(msg.captured);
      helloPromise = Promise.resolve();
      apply();
      if (boostActive()) scan();
      return;
    }
    if (msg.type === "HR_QUERY") {
      prune();
      if (!S.hooked.length && !skipped.size && !watched.size) return; // let other frames answer
      // Frames with audio actually playing answer first.
      const r = report();
      const delay = r.playing ? 0 : r.skippedPlaying ? 25 : r.hooked ? 50 : 80;
      setTimeout(() => sendResponse(r), delay);
      return true;
    }
  });

  chrome.storage.local
    .get(STORAGE_KEY)
    .then((stored) => {
      if (!live()) return;
      settings = normalizeSettings(stored[STORAGE_KEY]);
      settingsLoaded = true;
      apply();
      scan();
    })
    .catch(() => {
      settingsLoaded = true;
    });

  // Adopted an existing graph from an older copy: re-apply current settings.
  if (S.graph) apply();
})();
