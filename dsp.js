/*
 * Headroom shared DSP + settings (v2.2).
 * Loaded by the service worker, the offscreen processor, the popup and the
 * page engine (content script). Uses `var`/function declarations only so it can
 * be evaluated more than once in the same world without throwing.
 */

var STORAGE_KEY = "headroom.v1";

var STYLE_PARAMS = {
  transparent: {
    // Hidden makeup gain Chrome's DynamicsCompressor adds; trimmed off so the
    // boost readout is honest and peaks sit cleanly at limThreshold (-0.8 dBFS).
    // In transparent mode the first compressor is true-bypassed completely.
    compBypass: true,
    compMakeupDb: 0,
    limMakeupDb: 0.38,
    compThreshold: 0,
    compKnee: 0,
    compRatio: 1,
    compAttack: 0.003,
    compRelease: 0.12,
    limThreshold: -0.8,
    limKnee: 0,
    limRatio: 20,
    limAttack: 0.002,
    limRelease: 0.08,
  },
  balanced: {
    compBypass: false,
    compMakeupDb: 3.8,
    limMakeupDb: 0.36,
    compThreshold: -16,
    compKnee: 8,
    compRatio: 2.4,
    compAttack: 0.01,
    compRelease: 0.18,
    limThreshold: -0.8,
    limKnee: 0.2,
    limRatio: 20,
    limAttack: 0.0025,
    limRelease: 0.1,
  },
  night: {
    compBypass: false,
    compMakeupDb: 9.2,
    limMakeupDb: 0.45,
    compThreshold: -26,
    compKnee: 12,
    compRatio: 5,
    compAttack: 0.018,
    compRelease: 0.28,
    limThreshold: -1.0,
    limKnee: 0.4,
    limRatio: 20,
    limAttack: 0.003,
    limRelease: 0.12,
  },
};

var STYLE_DESCRIPTIONS = {
  transparent: "True-bypassed compressor into a clean brickwall. Least color.",
  balanced: "Light compression into the limiter for everyday listening.",
  night: "Heavier compression to tame loud scenes for late listening.",
};

var BOOST_MIN = 0;
var BOOST_MAX = 24;
var BOOST_STEP = 0.5;

// Continuous Auto-Level (gated loudness rider) constants.
var AUTO_TARGET_RMS = 0.15; // ~ -16.5 dBFS K-weighted RMS
var AUTO_GATE_RMS = 0.0063; // ~ -44 dBFS silence gate (holds gain on pauses)
var AUTO_TICK_MS = 60;
var AUTO_WINDOW_SEC = 1.5;

var ZERO_METERS = {
  peakIn: 0,
  peakOut: 0,
  peakInL: 0,
  peakInR: 0,
  rmsIn: 0,
  rmsOut: 0,
  grDb: 0,
  peakHoldIn: 0,
  peakHoldOut: 0,
  clipped: false,
  autoGainDb: null,
};

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function gainToDb(g) {
  if (g <= 0.0000001) return -120;
  return 20 * Math.log10(g);
}

function peakToWidth(peak) {
  if (peak <= 0.0001) return 0;
  const db = gainToDb(peak);
  return Math.max(0, Math.min(100, ((db + 48) / 48) * 100));
}

function formatDb(db) {
  const sign = db >= 0 ? "+" : "";
  return `${sign}${db.toFixed(1)}`;
}

function normalizeHost(host) {
  if (typeof host !== "string") return "";
  return host.trim().toLowerCase().replace(/^www\./, "");
}

function hostOfUrl(url) {
  if (!url) return "";
  try {
    return normalizeHost(new URL(url).hostname);
  } catch {
    return "";
  }
}

function clampBoost(val, fallback) {
  const db = Number(val);
  return Number.isFinite(db) ? Math.min(BOOST_MAX, Math.max(BOOST_MIN, db)) : fallback;
}

function defaultSettings() {
  return {
    enabled: true,
    bypass: false,
    boostDb: 8,
    style: "balanced",
    params: { ...STYLE_PARAMS.balanced },
    autoLevel: false,
    voiceClarity: false,
    mono: false,
    scope: "all", // "all" = every tab, "active" = only the tab you're looking at
    excludedSites: [],
    siteOverrides: {},
  };
}

function normalizeOverride(raw, fallback) {
  const base = fallback || defaultSettings();
  const o = raw && typeof raw === "object" ? raw : {};
  const style = STYLE_PARAMS[o.style] ? o.style : base.style;
  return {
    boostDb: clampBoost(o.boostDb, base.boostDb),
    style,
    autoLevel: typeof o.autoLevel === "boolean" ? o.autoLevel : Boolean(base.autoLevel),
    voiceClarity: typeof o.voiceClarity === "boolean" ? o.voiceClarity : Boolean(base.voiceClarity),
    mono: typeof o.mono === "boolean" ? o.mono : Boolean(base.mono),
  };
}

function normalizeSettings(raw) {
  const s = Object.assign(defaultSettings(), raw && typeof raw === "object" ? raw : {});
  s.enabled = s.enabled !== false;
  s.bypass = Boolean(s.bypass);
  s.boostDb = clampBoost(s.boostDb, 8);
  if (!STYLE_PARAMS[s.style]) s.style = "balanced";
  s.params = { ...STYLE_PARAMS[s.style] };
  s.autoLevel = Boolean(s.autoLevel);
  s.voiceClarity = Boolean(s.voiceClarity);
  s.mono = Boolean(s.mono);
  s.scope = s.scope === "active" ? "active" : "all";
  s.excludedSites = Array.isArray(s.excludedSites)
    ? [...new Set(s.excludedSites.map(normalizeHost).filter(Boolean))]
    : [];
  const overrides = {};
  if (raw && raw.siteOverrides && typeof raw.siteOverrides === "object") {
    for (const [rawHost, val] of Object.entries(raw.siteOverrides)) {
      const h = normalizeHost(rawHost);
      if (h && val && typeof val === "object") {
        overrides[h] = normalizeOverride(val, s);
      }
    }
  }
  s.siteOverrides = overrides;
  return s;
}

function resolveSettingsForHost(raw, host) {
  const s = normalizeSettings(raw);
  const h = normalizeHost(host);
  const excluded = Boolean(h && s.excludedSites.includes(h));
  const ov = h && s.siteOverrides[h] ? s.siteOverrides[h] : null;
  if (!ov) {
    return { ...s, excluded, pinned: false };
  }
  return {
    ...s,
    boostDb: ov.boostDb,
    style: ov.style,
    params: { ...STYLE_PARAMS[ov.style] },
    autoLevel: ov.autoLevel,
    voiceClarity: ov.voiceClarity,
    mono: ov.mono,
    excluded,
    pinned: true,
  };
}

/*
 * Safety clipper: bit-exact linear up to 0.92 (-0.72 dBFS), safely above the
 * limiter ceiling (-0.8 dBFS ≈ 0.912), so normal limited material passes with
 * zero harmonic distortion. Extreme sub-millisecond overshoots hit a smooth
 * tanh knee capped strictly below 0.99 (-0.09 dBFS).
 */
function makeSafetyCurve(n) {
  const size = n || 8192;
  const t = 0.92;
  const ceiling = 0.99;
  const headroom = ceiling - t;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / (size - 1) - 1;
    const a = Math.abs(x);
    const y = a <= t ? a : t + headroom * Math.tanh((a - t) / headroom);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

var SAFETY_CURVE = makeSafetyCurve(8192);

function peakRms(analyser, buf) {
  analyser.getFloatTimeDomainData(buf);
  let p = 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    const a = v < 0 ? -v : v;
    if (a > p) p = a;
    sum += v * v;
  }
  return { peak: p, rms: Math.sqrt(sum / buf.length) };
}

function createGraph(ctx) {
  const input = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();

  // Click-free stereo <-> mono fold-down stage.
  // monoPath explicitly downmixes to 1 channel using Web Audio's speakers rule
  // ((L + R) * 0.5) and upmixes cleanly to both channels into hpf.
  const stereoPath = ctx.createGain();
  const monoPath = ctx.createGain();
  monoPath.channelCount = 1;
  monoPath.channelCountMode = "explicit";
  monoPath.channelInterpretation = "speakers";

  // Pre-boost conditioning: 25 Hz infrasonic DC/rumble filter (always on in wet
  // path to prevent sub-20 Hz rumble from pumping the limiter), shifting to 90 Hz
  // + gentle mud cut & presence lift when Voice Clarity is enabled.
  const hpf = ctx.createBiquadFilter();
  hpf.type = "highpass";
  hpf.frequency.value = 25;
  hpf.Q.value = 0.707;

  const mudCut = ctx.createBiquadFilter();
  mudCut.type = "peaking";
  mudCut.frequency.value = 250;
  mudCut.Q.value = 0.9;
  mudCut.gain.value = 0;

  const presence = ctx.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2800;
  presence.Q.value = 0.8;
  presence.gain.value = 0;

  const boost = ctx.createGain();

  // True-bypassable first compressor stage (skipped cleanly in Transparent mode).
  const compDry = ctx.createGain();
  const compWet = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  const compTrim = ctx.createGain();
  const compSum = ctx.createGain();

  const limiter = ctx.createDynamicsCompressor();
  const limTrim = ctx.createGain();
  const safety = ctx.createWaveShaper();
  const output = ctx.createGain();

  const analyserPre = ctx.createAnalyser();
  const analyserPost = ctx.createAnalyser();
  const splitter = ctx.createChannelSplitter(2);
  const analyserL = ctx.createAnalyser();
  const analyserR = ctx.createAnalyser();

  // Lightweight K-weighted-ish sense branch for continuous Auto-Level.
  const senseHp = ctx.createBiquadFilter();
  senseHp.type = "highpass";
  senseHp.frequency.value = 120;
  senseHp.Q.value = 0.707;

  const senseShelf = ctx.createBiquadFilter();
  senseShelf.type = "highshelf";
  senseShelf.frequency.value = 1500;
  senseShelf.gain.value = 3;

  const analyserSense = ctx.createAnalyser();

  for (const a of [analyserPre, analyserPost, analyserL, analyserR, analyserSense]) {
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0;
  }

  safety.curve = SAFETY_CURVE;
  safety.oversample = "4x";
  dry.gain.value = 0;
  wet.gain.value = 1;
  stereoPath.gain.value = 1;
  monoPath.gain.value = 0;
  compDry.gain.value = 0;
  compWet.gain.value = 1;

  input.connect(analyserPre);
  input.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  input.connect(senseHp);
  senseHp.connect(senseShelf);
  senseShelf.connect(analyserSense);

  // Dry path (bypass / disabled) and wet path both feed the OUT meter.
  input.connect(dry);
  dry.connect(analyserPost);

  input.connect(wet);
  wet.connect(stereoPath);
  wet.connect(monoPath);
  stereoPath.connect(hpf);
  monoPath.connect(hpf);

  hpf.connect(mudCut);
  mudCut.connect(presence);
  presence.connect(boost);

  // Parallel true-bypass around the first compressor.
  boost.connect(compDry);
  compDry.connect(compSum);
  boost.connect(compWet);
  compWet.connect(compressor);
  compressor.connect(compTrim);
  compTrim.connect(compSum);

  compSum.connect(limiter);
  limiter.connect(limTrim);
  limTrim.connect(safety);
  safety.connect(analyserPost);
  analyserPost.connect(output);

  const preBuf = new Float32Array(analyserPre.fftSize);
  const postBuf = new Float32Array(analyserPost.fftSize);
  const lBuf = new Float32Array(analyserL.fftSize);
  const rBuf = new Float32Array(analyserR.fftSize);
  const senseBuf = new Float32Array(analyserSense.fftSize);

  let peakHoldIn = 0;
  let peakHoldOut = 0;
  let clipUntil = 0;
  let compBypassed = false;

  // Continuous Auto-Level state.
  let autoActive = false;
  let autoCeilingDb = 16;
  let autoGainDb = 0;
  let avgPower = 0;
  let autoTimer = 0;
  const autoAlpha = Math.exp(-(AUTO_TICK_MS / 1000) / AUTO_WINDOW_SEC);

  function ramp(param, value, tc) {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, tc);
  }

  function autoTick() {
    if (!autoActive || ctx.state !== "running") return;
    const sense = peakRms(analyserSense, senseBuf);
    if (sense.rms < AUTO_GATE_RMS) return; // silence gate: hold gain during pauses
    const p = sense.rms * sense.rms;
    avgPower = avgPower === 0 ? p : autoAlpha * avgPower + (1 - autoAlpha) * p;
    const avgRms = Math.sqrt(avgPower);
    const rawNeeded = 20 * Math.log10(AUTO_TARGET_RMS / Math.max(avgRms, 1e-5));
    const targetDb = Math.min(autoCeilingDb, Math.max(BOOST_MIN, rawNeeded));
    // Duck faster when audio gets loud; swell gently when audio gets quiet.
    const tc = targetDb < autoGainDb ? 0.25 : 0.95;
    const k = 1 - Math.exp(-(AUTO_TICK_MS / 1000) / tc);
    autoGainDb += (targetDb - autoGainDb) * k;
    ramp(boost.gain, dbToGain(autoGainDb), 0.08);
  }

  function setAutoTimer(run) {
    if (run && !autoTimer) {
      autoTimer = setInterval(autoTick, AUTO_TICK_MS);
    } else if (!run && autoTimer) {
      clearInterval(autoTimer);
      autoTimer = 0;
    }
  }

  function applySettings(raw) {
    const settings = normalizeSettings(raw);
    const active = settings.enabled && !settings.bypass;
    const wantAuto = active && settings.autoLevel;
    const wasAuto = autoActive;
    autoActive = wantAuto;
    autoCeilingDb = settings.boostDb;

    if (wantAuto) {
      if (!wasAuto) {
        avgPower = 0;
        autoGainDb = Math.min(autoCeilingDb, Math.max(BOOST_MIN, autoGainDb || Math.min(8, autoCeilingDb)));
      } else {
        autoGainDb = Math.min(autoCeilingDb, Math.max(BOOST_MIN, autoGainDb));
      }
      ramp(boost.gain, dbToGain(autoGainDb), 0.04);
      setAutoTimer(true);
    } else {
      setAutoTimer(false);
      autoGainDb = active ? settings.boostDb : 0;
      ramp(boost.gain, active ? dbToGain(settings.boostDb) : 1, 0.015);
    }

    ramp(wet.gain, active ? 1 : 0, 0.01);
    ramp(dry.gain, active ? 0 : 1, 0.01);

    // Stereo / Mono fold-down.
    ramp(stereoPath.gain, settings.mono ? 0 : 1, 0.012);
    ramp(monoPath.gain, settings.mono ? 1 : 0, 0.012);

    // Pre-boost conditioning & Voice Clarity EQ.
    ramp(hpf.frequency, settings.voiceClarity ? 90 : 25, 0.02);
    ramp(mudCut.gain, settings.voiceClarity ? -1.5 : 0, 0.02);
    ramp(presence.gain, settings.voiceClarity ? 2.5 : 0, 0.02);

    const p = settings.params;
    compBypassed = Boolean(p.compBypass);
    ramp(compDry.gain, compBypassed ? 1 : 0, 0.012);
    ramp(compWet.gain, compBypassed ? 0 : 1, 0.012);

    ramp(compressor.threshold, p.compThreshold, 0.03);
    ramp(compressor.knee, p.compKnee, 0.03);
    ramp(compressor.ratio, p.compRatio, 0.03);
    compressor.attack.value = p.compAttack;
    compressor.release.value = p.compRelease;
    ramp(limiter.threshold, p.limThreshold, 0.03);
    ramp(limiter.knee, p.limKnee, 0.03);
    ramp(limiter.ratio, p.limRatio, 0.03);
    limiter.attack.value = p.limAttack;
    limiter.release.value = p.limRelease;
    ramp(compTrim.gain, dbToGain(-(p.compMakeupDb || 0)), 0.03);
    ramp(limTrim.gain, dbToGain(-(p.limMakeupDb || 0)), 0.03);
  }

  function meters() {
    const pre = peakRms(analyserPre, preBuf);
    const post = peakRms(analyserPost, postBuf);
    const l = peakRms(analyserL, lBuf);
    const r = peakRms(analyserR, rBuf);
    const decay = 0.985;
    peakHoldIn = Math.max(pre.peak, peakHoldIn * decay);
    peakHoldOut = Math.max(post.peak, peakHoldOut * decay);
    if (post.peak >= 0.97) clipUntil = performance.now() + 420;
    const compGr = compBypassed ? 0 : Math.abs(compressor.reduction) * 0.35;
    return {
      peakIn: pre.peak,
      peakOut: post.peak,
      peakInL: l.peak,
      peakInR: r.peak,
      rmsIn: pre.rms,
      rmsOut: post.rms,
      grDb: Math.abs(limiter.reduction) + compGr,
      peakHoldIn,
      peakHoldOut,
      clipped: performance.now() < clipUntil,
      autoGainDb: autoActive ? autoGainDb : null,
    };
  }

  function destroy() {
    autoActive = false;
    setAutoTimer(false);
  }

  return { input, output, applySettings, meters, destroy, limiter, compressor };
}
