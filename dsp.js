/*
 * Headroom shared DSP + settings.
 * Loaded by the service worker, the offscreen processor, the popup and the
 * page engine (content script). Uses `var`/function declarations only so it can
 * be evaluated more than once in the same world without throwing.
 */

var STORAGE_KEY = "headroom.v1";

var STYLE_PARAMS = {
  transparent: {
    // Hidden makeup gain Chrome's DynamicsCompressor adds (measured); trimmed off
    // so the boost readout is the real gain and the ceiling sits at limThreshold.
    compMakeupDb: 0,
    limMakeupDb: 0.57,
    compThreshold: 0,
    compKnee: 0,
    compRatio: 1,
    compAttack: 0.003,
    compRelease: 0.12,
    limThreshold: -1,
    limKnee: 0,
    limRatio: 20,
    limAttack: 0.002,
    limRelease: 0.08,
  },
  balanced: {
    // Hidden makeup gain Chrome's DynamicsCompressor adds (measured); trimmed off
    // so the boost readout is the real gain and the ceiling sits at limThreshold.
    compMakeupDb: 4.266,
    limMakeupDb: 0.537,
    compThreshold: -16,
    compKnee: 8,
    compRatio: 2.4,
    compAttack: 0.01,
    compRelease: 0.18,
    limThreshold: -1,
    limKnee: 0.2,
    limRatio: 20,
    limAttack: 0.0025,
    limRelease: 0.1,
  },
  night: {
    // Hidden makeup gain Chrome's DynamicsCompressor adds (measured); trimmed off
    // so the boost readout is the real gain and the ceiling sits at limThreshold.
    compMakeupDb: 9.798,
    limMakeupDb: 0.619,
    compThreshold: -26,
    compKnee: 12,
    compRatio: 5,
    compAttack: 0.018,
    compRelease: 0.28,
    limThreshold: -1.2,
    limKnee: 0.4,
    limRatio: 20,
    limAttack: 0.003,
    limRelease: 0.12,
  },
};

var BOOST_MIN = 0;
var BOOST_MAX = 24;
var BOOST_STEP = 0.5;

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

function defaultSettings() {
  return {
    enabled: true,
    bypass: false,
    boostDb: 8,
    style: "balanced",
    params: { ...STYLE_PARAMS.balanced },
    scope: "all", // "all" = every tab, "active" = only the tab you're looking at
    excludedSites: [],
  };
}

function normalizeSettings(raw) {
  const s = Object.assign(defaultSettings(), raw && typeof raw === "object" ? raw : {});
  s.enabled = s.enabled !== false;
  s.bypass = Boolean(s.bypass);
  const db = Number(s.boostDb);
  s.boostDb = Number.isFinite(db) ? Math.min(BOOST_MAX, Math.max(BOOST_MIN, db)) : 8;
  if (!STYLE_PARAMS[s.style]) s.style = "balanced";
  s.params = { ...STYLE_PARAMS[s.style] };
  s.scope = s.scope === "active" ? "active" : "all";
  s.excludedSites = Array.isArray(s.excludedSites)
    ? s.excludedSites.filter((h) => typeof h === "string" && h)
    : [];
  return s;
}

/*
 * Safety clipper: exactly linear up to 0.8 (-1.9 dBFS) so normal material is
 * untouched, then a smooth tanh knee that can never exceed ~0.95 (-0.4 dBFS).
 * (The old curve added ~3 dB of gain and harmonic colour to everything.)
 */
function makeSafetyCurve(n) {
  const size = n || 4096;
  const t = 0.8;
  const curve = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = (i * 2) / (size - 1) - 1;
    const a = Math.abs(x);
    const y = a <= t ? a : t + (1 - t) * Math.tanh((a - t) / (1 - t));
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

var SAFETY_CURVE = makeSafetyCurve(4096);

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
  const boost = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  const compTrim = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  const limTrim = ctx.createGain();
  const safety = ctx.createWaveShaper();
  const output = ctx.createGain();
  const analyserPre = ctx.createAnalyser();
  const analyserPost = ctx.createAnalyser();
  const splitter = ctx.createChannelSplitter(2);
  const analyserL = ctx.createAnalyser();
  const analyserR = ctx.createAnalyser();

  for (const a of [analyserPre, analyserPost, analyserL, analyserR]) {
    a.fftSize = 1024;
    a.smoothingTimeConstant = 0;
  }

  safety.curve = SAFETY_CURVE;
  safety.oversample = "2x";
  dry.gain.value = 0;
  wet.gain.value = 1;

  input.connect(analyserPre);
  input.connect(splitter);
  splitter.connect(analyserL, 0);
  splitter.connect(analyserR, 1);

  // Dry path (bypass / disabled) and wet path both feed the OUT meter.
  input.connect(dry);
  dry.connect(analyserPost);

  input.connect(wet);
  wet.connect(boost);
  boost.connect(compressor);
  compressor.connect(compTrim);
  compTrim.connect(limiter);
  limiter.connect(limTrim);
  limTrim.connect(safety);
  safety.connect(analyserPost);
  analyserPost.connect(output);

  const preBuf = new Float32Array(analyserPre.fftSize);
  const postBuf = new Float32Array(analyserPost.fftSize);
  const lBuf = new Float32Array(analyserL.fftSize);
  const rBuf = new Float32Array(analyserR.fftSize);

  let peakHoldIn = 0;
  let peakHoldOut = 0;
  let clipUntil = 0;

  function ramp(param, value, tc) {
    const t = ctx.currentTime;
    param.cancelScheduledValues(t);
    param.setTargetAtTime(value, t, tc);
  }

  function applySettings(raw) {
    const settings = normalizeSettings(raw);
    const active = settings.enabled && !settings.bypass;
    ramp(boost.gain, active ? dbToGain(settings.boostDb) : 1, 0.015);
    ramp(wet.gain, active ? 1 : 0, 0.01);
    ramp(dry.gain, active ? 0 : 1, 0.01);
    const p = settings.params;
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
    if (post.peak >= 0.94) clipUntil = performance.now() + 420;
    return {
      peakIn: pre.peak,
      peakOut: post.peak,
      peakInL: l.peak,
      peakInR: r.peak,
      rmsIn: pre.rms,
      rmsOut: post.rms,
      grDb: Math.abs(limiter.reduction) + Math.abs(compressor.reduction) * 0.35,
      peakHoldIn,
      peakHoldOut,
      clipped: performance.now() < clipUntil,
    };
  }

  return { input, output, applySettings, meters, limiter, compressor };
}
