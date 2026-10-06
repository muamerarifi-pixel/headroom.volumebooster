/* Loads HeadroomLimiter.dll the way Equalizer APO does and checks the result.
 * Build with mingw and run under Windows or Wine: host_test.exe HeadroomLimiter.dll */
#include <windows.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct AEffect AEffect;
typedef intptr_t(__cdecl* HostCb)(AEffect*, int32_t, int32_t, intptr_t, void*, float);
struct AEffect {
  int32_t magic;
  intptr_t(__cdecl* dispatcher)(AEffect*, int32_t, int32_t, intptr_t, void*, float);
  void* process;
  void(__cdecl* setParameter)(AEffect*, int32_t, float);
  float(__cdecl* getParameter)(AEffect*, int32_t);
  int32_t numPrograms, numParams, numInputs, numOutputs, flags;
  intptr_t r1, r2;
  int32_t initialDelay, rq, oq;
  float ioRatio;
  void *object, *user;
  int32_t uniqueID, version;
  void(__cdecl* processReplacing)(AEffect*, float**, float**, int32_t);
  void(__cdecl* processDoubleReplacing)(AEffect*, double**, double**, int32_t);
  char future[56];
};

static intptr_t __cdecl host(AEffect* e, int32_t op, int32_t i, intptr_t v, void* p, float f) {
  (void)e; (void)i; (void)v; (void)p; (void)f;
  return op == 1 ? 2400 : 0; /* audioMasterVersion */
}

static int set_by_name(AEffect* fx, const char* name, float v) {
  for (int i = 0; i < fx->numParams; i++) {
    char buf[256] = "";
    fx->dispatcher(fx, 8, i, 0, buf, 0);
    if (strcmp(buf, name) == 0) { fx->setParameter(fx, i, v); return 1; }
  }
  return 0;
}

static double run(AEffect* fx, double amp, double* peak, int useFloat) {
  enum { N = 480 };
  static double inL[N], inR[N], outL[N], outR[N];
  static float finL[N], finR[N], foutL[N], foutR[N];
  double si = 0, so = 0;
  *peak = 0;
  for (int blk = 0; blk < 200; blk++) {
    for (int i = 0; i < N; i++) {
      double t = (blk * N + i) / 48000.0;
      inL[i] = inR[i] = amp * sin(2 * 3.14159265358979 * 440 * t);
      finL[i] = finR[i] = (float)inL[i];
    }
    if (useFloat) {
      float* in[2] = {finL, finR}; float* out[2] = {foutL, foutR};
      fx->processReplacing(fx, in, out, N);
      for (int i = 0; i < N; i++) { outL[i] = foutL[i]; outR[i] = foutR[i]; }
    } else {
      double* in[2] = {inL, inR}; double* out[2] = {outL, outR};
      fx->processDoubleReplacing(fx, in, out, N);
    }
    for (int i = 0; i < N; i++) {
      if (fabs(outL[i]) > *peak) *peak = fabs(outL[i]);
      if (blk >= 100) { si += inL[i] * inL[i]; so += outL[i] * outL[i]; }
    }
  }
  return 20 * log10(sqrt(so / si));
}

int main(int argc, char** argv) {
  HMODULE m = LoadLibraryA(argc > 1 ? argv[1] : "HeadroomLimiter.dll");
  if (!m) { printf("FAIL: LoadLibrary %lu\n", GetLastError()); return 1; }
  AEffect* (*entry)(HostCb) = (AEffect * (*)(HostCb)) GetProcAddress(m, "VSTPluginMain");
  if (!entry) { printf("FAIL: no VSTPluginMain\n"); return 1; }
  int fails = 0;
  for (int useFloat = 0; useFloat < 2; useFloat++) {
    AEffect* fx = entry(host);
    if (!fx || fx->magic != 0x56737450) { printf("FAIL: bad magic\n"); return 1; }
    char name[64] = "";
    fx->dispatcher(fx, 45, 0, 0, name, 0);
    fx->dispatcher(fx, 0, 0, 0, NULL, 0);           /* effOpen */
    fx->dispatcher(fx, 10, 0, 0, NULL, 48000.0f);   /* sample rate */
    fx->dispatcher(fx, 11, 0, 480, NULL, 0);        /* block size */
    /* exactly what Headroom.exe writes for +12 dB Transparent */
    fails += !set_by_name(fx, "Boost", 0.5f);
    fails += !set_by_name(fx, "Style", 0.0f);
    fails += !set_by_name(fx, "Enabled", 1.0f);
    fx->dispatcher(fx, 12, 0, 1, NULL, 0);          /* mains on */
    fx->dispatcher(fx, 71, 0, 0, NULL, 0);          /* start process */
    double pk, g = run(fx, 0.05, &pk, useFloat);
    printf("%s '%s' %s: quiet sine gain %+.2f dB, peak %.3f\n", useFloat ? "float " : "double", name,
           "+12 dB", g, pk);
    if (fabs(g - 12) > 0.1) { printf("FAIL: expected +12 dB\n"); fails++; }
    g = run(fx, 0.9, &pk, useFloat);
    printf("        loud sine: gain %+.2f dB, peak %.4f (ceiling 0.8913)\n", g, pk);
    if (pk > 0.8913) { printf("FAIL: over ceiling\n"); fails++; }
    fx->dispatcher(fx, 1, 0, 0, NULL, 0);           /* effClose frees */
  }
  printf(fails ? "host test FAILED\n" : "host test passed\n");
  return fails != 0;
}
