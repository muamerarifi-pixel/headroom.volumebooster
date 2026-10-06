#!/usr/bin/env bash
# Builds Headroom for Windows from Linux (or WSL / MSYS2) with mingw-w64 and NSIS.
#   Ubuntu/Debian: sudo apt install mingw-w64 nsis
# Output: dist/Headroom-Setup.exe
set -euo pipefail
cd "$(dirname "$0")"

CC=${CC:-x86_64-w64-mingw32-gcc}
WINDRES=${WINDRES:-x86_64-w64-mingw32-windres}
MAKENSIS=${MAKENSIS:-makensis}
CFLAGS="-O2 -Wall -Wextra -Wno-missing-field-initializers -municode -D_WIN32_WINNT=0x0601 -DWINVER=0x0601"

ENGINE=EqualizerAPO-x64-1.4.2.exe
ENGINE_URL=https://downloads.sourceforge.net/project/equalizerapo/1.4.2/$ENGINE
ENGINE_SHA256=7403be7427bbe1936a40dded082829b6e217fc4f5990fee5cba501f0ae055afa

mkdir -p build dist third_party

echo "== DSP unit test (native)"
cc -O2 -Wall -Wextra -o build/dsp_test tests/dsp_test.c -lm
./build/dsp_test

echo "== HeadroomLimiter.dll"
$CC -O2 -Wall -Wextra -shared -static-libgcc -o build/HeadroomLimiter.dll src/plugin.c -lm

echo "== Plugin ABI test (runs if Wine is installed)"
$CC -O2 -Wall -o build/host_test.exe tests/host_test.c -lm
if command -v wine >/dev/null 2>&1; then
  (cd build && WINEDEBUG=-all wine host_test.exe HeadroomLimiter.dll)
fi

echo "== Headroom.exe"
$WINDRES -I src res/app.rc -O coff -o build/app.res
$CC $CFLAGS -mwindows -static -o build/Headroom.exe src/app.c build/app.res \
  -lole32 -lshell32 -lshlwapi -lcomctl32 -luser32 -lgdi32 -ladvapi32

echo "== Equalizer APO installer"
if [ ! -f "third_party/$ENGINE" ]; then
  curl -fsSL -o "third_party/$ENGINE.part" "$ENGINE_URL"
  mv "third_party/$ENGINE.part" "third_party/$ENGINE"
fi
echo "$ENGINE_SHA256  third_party/$ENGINE" | sha256sum -c -

echo "== Installer"
$MAKENSIS -V2 installer/headroom.nsi
ls -la dist
