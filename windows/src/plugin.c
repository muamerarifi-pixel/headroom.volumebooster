/*
 * HeadroomLimiter.dll: a VST 2.4-compatible effect hosted by Equalizer APO
 * inside the Windows audio engine (audiodg.exe), so the boost applies to
 * every sound the PC plays.
 *
 * Only the small, stable part of the VST 2 ABI that Equalizer APO uses is
 * declared here; no Steinberg SDK is needed.
 *
 * Parameters (normalized 0..1, set by name from the Equalizer APO config line
 * written by Headroom.exe):
 *   Boost    0..1  ->  0..24 dB in 0.5 dB steps
 *   Style    0 / 0.5 / 1  ->  Transparent / Balanced / Night
 *   Enabled  0 or 1
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "headroom_dsp.h"

#define VST_CALL __cdecl
#define FOURCC(a, b, c, d) (((int32_t)(a) << 24) | ((int32_t)(b) << 16) | ((int32_t)(c) << 8) | (int32_t)(d))

typedef struct AEffect AEffect;
typedef intptr_t(VST_CALL* HostCallback)(AEffect*, int32_t, int32_t, intptr_t, void*, float);
typedef intptr_t(VST_CALL* DispatcherProc)(AEffect*, int32_t, int32_t, intptr_t, void*, float);
typedef void(VST_CALL* ProcessProc)(AEffect*, float**, float**, int32_t);
typedef void(VST_CALL* ProcessDoubleProc)(AEffect*, double**, double**, int32_t);
typedef void(VST_CALL* SetParameterProc)(AEffect*, int32_t, float);
typedef float(VST_CALL* GetParameterProc)(AEffect*, int32_t);

struct AEffect {
  int32_t magic;
  DispatcherProc dispatcher;
  ProcessProc process; /* deprecated accumulating process */
  SetParameterProc setParameter;
  GetParameterProc getParameter;
  int32_t numPrograms;
  int32_t numParams;
  int32_t numInputs;
  int32_t numOutputs;
  int32_t flags;
  intptr_t resvd1;
  intptr_t resvd2;
  int32_t initialDelay;
  int32_t realQualities;
  int32_t offQualities;
  float ioRatio;
  void* object;
  void* user;
  int32_t uniqueID;
  int32_t version;
  ProcessProc processReplacing;
  ProcessDoubleProc processDoubleReplacing;
  char future[56];
};

enum {
  effOpen = 0,
  effClose = 1,
  effGetProgram = 3,
  effGetProgramName = 5,
  effGetParamLabel = 6,
  effGetParamDisplay = 7,
  effGetParamName = 8,
  effSetSampleRate = 10,
  effSetBlockSize = 11,
  effMainsChanged = 12,
  effGetPlugCategory = 35,
  effGetEffectName = 45,
  effGetVendorString = 47,
  effGetProductString = 48,
  effGetVendorVersion = 49,
  effCanDo = 51,
  effGetTailSize = 52,
  effGetVstVersion = 58,
  effStartProcess = 71,
};

enum {
  effFlagsCanReplacing = 1 << 4,
  effFlagsCanDoubleReplacing = 1 << 12,
};

enum { kPlugCategEffect = 1 };
enum { P_BOOST = 0, P_STYLE = 1, P_ENABLED = 2, P_COUNT = 3 };

typedef struct {
  AEffect fx;
  HostCallback host;
  float params[P_COUNT];
  double sampleRate;
  HrDsp dsp;
} Plugin;

static void copy_str(void* dst, const char* src, size_t cap) {
  if (!dst) return;
  strncpy((char*)dst, src, cap - 1);
  ((char*)dst)[cap - 1] = '\0';
}

static double param_boost_db(const Plugin* p) {
  double db = p->params[P_BOOST] * HR_BOOST_MAX_DB;
  return floor(db * 2.0 + 0.5) / 2.0;
}

static int param_style(const Plugin* p) {
  int s = (int)floor(p->params[P_STYLE] * 2.0 + 0.5);
  return s < 0 ? 0 : s > 2 ? 2 : s;
}

/* Applies parameters to the DSP. Equalizer APO only sets parameters while the
 * stream is stopped (it rebuilds the filter chain on every config change), so
 * this never races the audio thread in practice. */
static void apply(Plugin* p) {
  p->dsp.boostDb = param_boost_db(p);
  p->dsp.style = param_style(p);
  p->dsp.enabled = p->params[P_ENABLED] >= 0.5f;
  hr_configure(&p->dsp, p->sampleRate);
}

static intptr_t VST_CALL dispatcher(AEffect* fx, int32_t op, int32_t index, intptr_t value, void* ptr, float opt) {
  Plugin* p = (Plugin*)fx->object;
  (void)value;
  switch (op) {
    case effOpen:
      return 0;
    case effClose:
      free(p);
      return 0;
    case effSetSampleRate:
      p->sampleRate = opt;
      apply(p);
      return 0;
    case effSetBlockSize:
      return 0;
    case effMainsChanged:
    case effStartProcess:
      hr_reset(&p->dsp);
      return 0;
    case effGetParamName: {
      static const char* names[P_COUNT] = {"Boost", "Style", "Enabled"};
      if (index >= 0 && index < P_COUNT) copy_str(ptr, names[index], 64);
      return 0;
    }
    case effGetParamLabel: {
      static const char* labels[P_COUNT] = {"dB", "", ""};
      if (index >= 0 && index < P_COUNT) copy_str(ptr, labels[index], 64);
      return 0;
    }
    case effGetParamDisplay: {
      char buf[64] = "";
      static const char* styles[3] = {"Transparent", "Balanced", "Night"};
      if (index == P_BOOST) snprintf(buf, sizeof buf, "+%.1f", param_boost_db(p));
      else if (index == P_STYLE) snprintf(buf, sizeof buf, "%s", styles[param_style(p)]);
      else if (index == P_ENABLED) snprintf(buf, sizeof buf, "%s", p->params[P_ENABLED] >= 0.5f ? "On" : "Off");
      copy_str(ptr, buf, 64);
      return 0;
    }
    case effGetProgram:
      return 0;
    case effGetProgramName:
      copy_str(ptr, "Default", 24);
      return 0;
    case effGetPlugCategory:
      return kPlugCategEffect;
    case effGetEffectName:
      copy_str(ptr, "Headroom Limiter", 32);
      return 1;
    case effGetProductString:
      copy_str(ptr, "Headroom", 64);
      return 1;
    case effGetVendorString:
      copy_str(ptr, "Headroom", 64);
      return 1;
    case effGetVendorVersion:
      return 1000;
    case effGetVstVersion:
      return 2400;
    case effGetTailSize:
      return 1;
    case effCanDo:
      return 0;
  }
  return 0;
}

static void VST_CALL set_parameter(AEffect* fx, int32_t index, float v) {
  Plugin* p = (Plugin*)fx->object;
  if (index < 0 || index >= P_COUNT) return;
  if (!(v >= 0.0f)) v = 0.0f;
  if (v > 1.0f) v = 1.0f;
  p->params[index] = v;
  apply(p);
}

static float VST_CALL get_parameter(AEffect* fx, int32_t index) {
  Plugin* p = (Plugin*)fx->object;
  return (index >= 0 && index < P_COUNT) ? p->params[index] : 0.0f;
}

static void VST_CALL process_double(AEffect* fx, double** in, double** out, int32_t frames) {
  Plugin* p = (Plugin*)fx->object;
  if (!p->dsp.enabled) {
    for (int c = 0; c < 2; c++)
      if (in[c] != out[c]) memmove(out[c], in[c], (size_t)frames * sizeof(double));
    return;
  }
  for (int32_t i = 0; i < frames; i++) {
    double l = in[0][i], r = in[1][i];
    hr_frame(&p->dsp, &l, &r);
    out[0][i] = l;
    out[1][i] = r;
  }
}

static void VST_CALL process_float(AEffect* fx, float** in, float** out, int32_t frames) {
  Plugin* p = (Plugin*)fx->object;
  if (!p->dsp.enabled) {
    for (int c = 0; c < 2; c++)
      if (in[c] != out[c]) memmove(out[c], in[c], (size_t)frames * sizeof(float));
    return;
  }
  for (int32_t i = 0; i < frames; i++) {
    double l = in[0][i], r = in[1][i];
    hr_frame(&p->dsp, &l, &r);
    out[0][i] = (float)l;
    out[1][i] = (float)r;
  }
}

/* Old hosts call the accumulating process(); Equalizer APO uses the replacing ones. */
static void VST_CALL process_accumulate(AEffect* fx, float** in, float** out, int32_t frames) {
  Plugin* p = (Plugin*)fx->object;
  for (int32_t i = 0; i < frames; i++) {
    double l = in[0][i], r = in[1][i];
    if (p->dsp.enabled) hr_frame(&p->dsp, &l, &r);
    out[0][i] += (float)l;
    out[1][i] += (float)r;
  }
}

__declspec(dllexport) AEffect* VSTPluginMain(HostCallback host) {
  Plugin* p = (Plugin*)calloc(1, sizeof(Plugin));
  if (!p) return NULL;
  p->host = host;
  p->fx.magic = FOURCC('V', 's', 't', 'P');
  p->fx.dispatcher = dispatcher;
  p->fx.process = process_accumulate;
  p->fx.setParameter = set_parameter;
  p->fx.getParameter = get_parameter;
  p->fx.numPrograms = 1;
  p->fx.numParams = P_COUNT;
  p->fx.numInputs = 2;
  p->fx.numOutputs = 2;
  p->fx.flags = effFlagsCanReplacing | effFlagsCanDoubleReplacing;
  p->fx.initialDelay = 0; /* ~2 ms of look-ahead; too small to matter for A/V sync */
  p->fx.ioRatio = 1.0f;
  p->fx.object = p;
  p->fx.uniqueID = FOURCC('H', 'd', 'R', 'm');
  p->fx.version = 1000;
  p->fx.processReplacing = process_float;
  p->fx.processDoubleReplacing = process_double;

  p->params[P_BOOST] = (float)(8.0 / HR_BOOST_MAX_DB);
  p->params[P_STYLE] = 0.5f;
  p->params[P_ENABLED] = 1.0f;
  p->sampleRate = 48000.0;
  hr_init(&p->dsp);
  apply(p);
  return &p->fx;
}

