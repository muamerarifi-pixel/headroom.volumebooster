/* Native test for the Headroom DSP. Build: cc -O2 -o dsp_test dsp_test.c -lm */
#include <stdio.h>
#include <stdlib.h>
#include "../src/headroom_dsp.h"

static int failures = 0;
#define CHECK(cond, ...)            \
  do {                              \
    if (!(cond)) {                  \
      printf("FAIL: " __VA_ARGS__); \
      printf("\n");                 \
      failures++;                   \
    }                               \
  } while (0)

static double rnd(unsigned* s) {
  *s = *s * 1664525u + 1013904223u;
  return ((*s >> 8) / 8388608.0) - 1.0;
}

/* Runs `secs` of a signal through the DSP; returns output peak and RMS of the last half. */
static void run(HrDsp* d, int kind, double amp, double secs, double* peakOut, double* rmsIn, double* rmsOut) {
  unsigned seed = 1234;
  long total = (long)(secs * d->fs);
  double pk = 0, si = 0, so = 0;
  long cnt = 0;
  for (long i = 0; i < total; i++) {
    double t = i / d->fs, l, r;
    switch (kind) {
      case 0: l = r = amp * sin(2 * M_PI * 1000 * t); break;               /* sine */
      case 1: l = amp * rnd(&seed); r = amp * rnd(&seed); break;           /* noise */
      case 2: l = r = (i % 4800 == 0) ? amp : 0.0; break;                   /* clicks */
      default: l = r = amp * sin(2 * M_PI * 50 * t) * (0.5 + 0.5 * sin(2 * M_PI * 0.7 * t)); /* bass */
    }
    double il = l;
    hr_frame(d, &l, &r);
    if (fabs(l) > pk) pk = fabs(l);
    if (fabs(r) > pk) pk = fabs(r);
    if (i > total / 2) {
      si += il * il;
      so += l * l;
      cnt++;
    }
  }
  *peakOut = pk;
  *rmsIn = sqrt(si / cnt);
  *rmsOut = sqrt(so / cnt);
}

int main(void) {
  double rates[] = {44100, 48000, 96000, 192000};
  for (int style = 0; style < 3; style++) {
    for (int ri = 0; ri < 4; ri++) {
      for (int kind = 0; kind < 4; kind++) {
        double boosts[] = {0, 6, 12, 24};
        for (int bi = 0; bi < 4; bi++) {
          HrDsp* d = malloc(sizeof(HrDsp));
          hr_init(d);
          d->style = style;
          d->boostDb = boosts[bi];
          hr_configure(d, rates[ri]);
          double pk, ri_, ro;
          run(d, kind, 1.0, 2.0, &pk, &ri_, &ro);
          CHECK(pk <= d->ceiling + 1e-12, "style %d fs %.0f kind %d boost %.0f: peak %.6f > ceiling %.6f",
                style, rates[ri], kind, boosts[bi], pk, d->ceiling);
          CHECK(isfinite(pk), "non-finite output");
          free(d);
        }
      }
    }
  }

  /* Quiet material gets the full boost (transparent style, well below the ceiling). */
  {
    HrDsp* d = malloc(sizeof(HrDsp));
    hr_init(d);
    d->style = HR_STYLE_TRANSPARENT;
    d->boostDb = 12;
    hr_configure(d, 48000);
    double pk, in, out;
    run(d, 0, 0.05, 2.0, &pk, &in, &out);
    double gainDb = 20 * log10(out / in);
    printf("quiet sine, +12 dB transparent: measured %+.2f dB\n", gainDb);
    CHECK(fabs(gainDb - 12.0) < 0.05, "expected +12 dB, got %+.2f", gainDb);
    free(d);
  }

  /* Loud material: louder than input but capped. */
  for (int style = 0; style < 3; style++) {
    HrDsp* d = malloc(sizeof(HrDsp));
    hr_init(d);
    d->style = style;
    d->boostDb = 12;
    hr_configure(d, 48000);
    double pk, in, out;
    run(d, 1, 0.3, 3.0, &pk, &in, &out);
    printf("noise 0.3, +12 dB style %d: rms %+.2f dB, peak %.3f\n", style, 20 * log10(out / in), pk);
    CHECK(out > in * (style == 0 ? 2.0 : 1.1), "loud material should still get louder");
    free(d);
  }

  /* Disabled: unity gain apart from the limiter. */
  {
    HrDsp* d = malloc(sizeof(HrDsp));
    hr_init(d);
    d->enabled = 0;
    d->style = HR_STYLE_TRANSPARENT;
    hr_configure(d, 48000);
    double pk, in, out;
    run(d, 0, 0.1, 1.0, &pk, &in, &out);
    CHECK(fabs(20 * log10(out / in)) < 0.01, "disabled should be unity");
    free(d);
  }

  if (failures) {
    printf("%d failure(s)\n", failures);
    return 1;
  }
  printf("all DSP checks passed\n");
  return 0;
}
