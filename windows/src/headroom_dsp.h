/*
 * Headroom DSP: gain -> optional compressor -> look-ahead peak limiter.
 *
 * Header-only so the same code runs in the VST plugin (inside the Windows
 * audio engine) and in the native unit test. No allocation, no locks, no
 * system calls in hr_process(): it is called on the real-time audio thread.
 */
#ifndef HEADROOM_DSP_H
#define HEADROOM_DSP_H

#include <math.h>
#include <string.h>

#define HR_BOOST_MAX_DB 24.0
#define HR_LA_MAX 2048 /* look-ahead samples; 2 ms needs 1536 at 768 kHz */

enum { HR_STYLE_TRANSPARENT = 0, HR_STYLE_BALANCED = 1, HR_STYLE_NIGHT = 2 };

typedef struct {
  double compThresholdDb, compKneeDb, compRatio, compAttack, compRelease, compMakeupDb;
  double ceilingDb, limRelease;
} HrStyle;

/* Mirrors STYLE_PARAMS in dsp.js. The compressor keeps the makeup gain that
 * Chrome's DynamicsCompressor applies (measured there as compMakeupDb), so
 * Balanced and Night lift quiet passages instead of only taming loud ones.
 * The limiter releases are slower than Chrome's because this limiter is a
 * true brickwall and a fast release would distort bass. */
static const HrStyle HR_STYLES[3] = {
  /* transparent */ { 0.0, 0.0, 1.0, 0.003, 0.12, 0.0, -1.0, 0.20 },
  /* balanced    */ { -16.0, 8.0, 2.4, 0.010, 0.18, 4.266, -1.0, 0.25 },
  /* night       */ { -26.0, 12.0, 5.0, 0.018, 0.28, 9.798, -1.2, 0.30 },
};

typedef struct {
  /* settings */
  int enabled;
  double boostDb;
  int style;

  /* derived */
  double fs;
  double gainTarget, gain, gainCoef;
  double compEnvDb, compAtk, compRel;
  double ceiling, limRelCoef;
  int la;

  /* limiter state */
  double delay[2][HR_LA_MAX];
  int dpos;
  double dqVal[HR_LA_MAX + 1];
  long long dqIdx[HR_LA_MAX + 1];
  int dqHead, dqLen;
  long long n;
  double relEnv;
  double box[HR_LA_MAX];
  int bpos;
  double boxSum;
  int boxRecalc;
} HrDsp;

static inline double hr_db_to_gain(double db) { return pow(10.0, db / 20.0); }

static inline double hr_coef(double seconds, double fs) {
  if (seconds <= 0.0) return 0.0;
  return exp(-1.0 / (seconds * fs));
}

static void hr_reset(HrDsp* d) {
  memset(d->delay, 0, sizeof(d->delay));
  memset(d->box, 0, sizeof(d->box));
  d->dpos = 0;
  d->dqHead = 0;
  d->dqLen = 0;
  d->n = 0;
  d->relEnv = 1.0;
  d->bpos = 0;
  d->boxSum = (double)d->la; /* box holds 1.0 everywhere */
  for (int i = 0; i < d->la; i++) d->box[i] = 1.0;
  d->boxRecalc = 0;
  d->compEnvDb = 0.0;
  d->gain = d->gainTarget;
}

/* Recomputes everything derived from settings + sample rate. Not real-time. */
static void hr_configure(HrDsp* d, double fs) {
  if (!(fs > 1000.0)) fs = 48000.0;
  d->fs = fs;
  if (d->style < 0 || d->style > 2) d->style = HR_STYLE_BALANCED;
  if (!(d->boostDb >= 0.0)) d->boostDb = 0.0;
  if (d->boostDb > HR_BOOST_MAX_DB) d->boostDb = HR_BOOST_MAX_DB;

  const HrStyle* s = &HR_STYLES[d->style];
  d->gainTarget = d->enabled ? hr_db_to_gain(d->boostDb) : 1.0;
  d->gainCoef = hr_coef(0.02, fs);
  d->compAtk = hr_coef(s->compAttack, fs);
  d->compRel = hr_coef(s->compRelease, fs);
  d->ceiling = hr_db_to_gain(s->ceilingDb);
  d->limRelCoef = hr_coef(s->limRelease, fs);

  int la = (int)(0.002 * fs + 0.5);
  if (la < 1) la = 1;
  if (la > HR_LA_MAX) la = HR_LA_MAX;
  d->la = la;
  hr_reset(d);
}

static void hr_init(HrDsp* d) {
  memset(d, 0, sizeof(*d));
  d->enabled = 1;
  d->boostDb = 8.0;
  d->style = HR_STYLE_BALANCED;
  hr_configure(d, 48000.0);
}

/* Compressor static curve: gain change in dB (<= 0) for a level in dBFS. */
static inline double hr_comp_curve(const HrStyle* s, double levelDb) {
  double over = levelDb - s->compThresholdDb;
  double slope = 1.0 / s->compRatio - 1.0;
  double knee = s->compKneeDb;
  if (knee > 0.0 && 2.0 * fabs(over) <= knee) {
    double x = over + knee / 2.0;
    return slope * x * x / (2.0 * knee);
  }
  return over > 0.0 ? slope * over : 0.0;
}

/* Sliding-window minimum over the last `la` values (monotonic deque). */
static inline double hr_window_min(HrDsp* d, double v) {
  const int cap = HR_LA_MAX + 1;
  while (d->dqLen > 0) {
    int back = (d->dqHead + d->dqLen - 1) % cap;
    if (d->dqVal[back] >= v) d->dqLen--;
    else break;
  }
  int slot = (d->dqHead + d->dqLen) % cap;
  d->dqVal[slot] = v;
  d->dqIdx[slot] = d->n;
  d->dqLen++;
  while (d->dqIdx[d->dqHead] <= d->n - d->la) {
    d->dqHead = (d->dqHead + 1) % cap;
    d->dqLen--;
  }
  return d->dqVal[d->dqHead];
}

/*
 * Process one stereo frame in place. Look-ahead limiter design: the gain each
 * sample needs is held as a sliding minimum over `la` samples, released
 * smoothly, then averaged with an `la`-long box filter. Because the audio is
 * delayed by la-1 samples, the averaged gain at any peak is guaranteed to be
 * at or below what that peak needs, so the output never exceeds the ceiling.
 */
static inline void hr_frame(HrDsp* d, double* l, double* r) {
  const HrStyle* s = &HR_STYLES[d->style];

  d->gain = d->gainTarget + d->gainCoef * (d->gain - d->gainTarget);
  double xl = *l * d->gain;
  double xr = *r * d->gain;

  if (s->compRatio > 1.0) {
    double peak = fmax(fabs(xl), fabs(xr));
    double levelDb = peak > 1e-9 ? 20.0 * log10(peak) : -180.0;
    double target = hr_comp_curve(s, levelDb);
    double c = target < d->compEnvDb ? d->compAtk : d->compRel;
    d->compEnvDb = target + c * (d->compEnvDb - target);
    double g = hr_db_to_gain(d->compEnvDb + s->compMakeupDb);
    xl *= g;
    xr *= g;
  }

  double peak = fmax(fabs(xl), fabs(xr));
  double need = peak > d->ceiling ? d->ceiling / peak : 1.0;
  double held = hr_window_min(d, need);

  d->relEnv = 1.0 + d->limRelCoef * (d->relEnv - 1.0);
  if (held < d->relEnv) d->relEnv = held;

  d->boxSum += d->relEnv - d->box[d->bpos];
  d->box[d->bpos] = d->relEnv;
  if (++d->bpos >= d->la) d->bpos = 0;
  if (++d->boxRecalc >= 65536) { /* cancel floating-point drift */
    double sum = 0.0;
    for (int i = 0; i < d->la; i++) sum += d->box[i];
    d->boxSum = sum;
    d->boxRecalc = 0;
  }
  double g = d->boxSum / d->la;

  /* delay line of la-1 samples (la == 1 means no delay) */
  double outL, outR;
  if (d->la > 1) {
    int len = d->la - 1;
    outL = d->delay[0][d->dpos];
    outR = d->delay[1][d->dpos];
    d->delay[0][d->dpos] = xl;
    d->delay[1][d->dpos] = xr;
    if (++d->dpos >= len) d->dpos = 0;
  } else {
    outL = xl;
    outR = xr;
  }
  d->n++;

  outL *= g;
  outR *= g;
  /* Belt and braces against rounding: never above the ceiling. */
  if (outL > d->ceiling) outL = d->ceiling;
  else if (outL < -d->ceiling) outL = -d->ceiling;
  if (outR > d->ceiling) outR = d->ceiling;
  else if (outR < -d->ceiling) outR = -d->ceiling;
  /* flush denormals */
  if (fabs(outL) < 1e-30) outL = 0.0;
  if (fabs(outR) < 1e-30) outR = 0.0;
  *l = outL;
  *r = outR;
}

#endif
