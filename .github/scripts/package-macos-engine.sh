#!/usr/bin/env bash
#
# package-macos-engine.sh -- turn a bridge-patched zandronum-macos-compile build
# into a portable, relocatable .zip release asset.
#
# Why this exists: zandronum-macos-compile's build.sh links sdl12-compat
# (libSDL-1.2.0.dylib) by an ABSOLUTE build-machine path and never stages that
# dylib next to the binary; sdl12-compat in turn dlopen()s libSDL2 at runtime.
# Left as-is the build only runs with DYLD_LIBRARY_PATH pointing back at
# deps/x86/lib, so a downloaded copy is broken. This script gathers the binary,
# the engine game data, and every required dylib into one folder and rewrites all
# load paths to @loader_path, so the unzipped folder runs anywhere with no env.
#
# Usage: package-macos-engine.sh <engine-root> <out-zip>
#   <engine-root>  a zandronum-macos-compile checkout (has build/ and deps/x86/lib)
#   <out-zip>      absolute path of the .zip to write
#
set -euo pipefail

ENGINE_ROOT="${1:?usage: package-macos-engine.sh <engine-root> <out-zip>}"
OUT_ZIP="${2:?usage: package-macos-engine.sh <engine-root> <out-zip>}"
BUILD="$ENGINE_ROOT/build"
DEPLIB="$ENGINE_ROOT/deps/x86/lib"
WORK="$(mktemp -d)"
PAYLOAD="$WORK/zandronum"
mkdir -p "$PAYLOAD"

bin="$BUILD/zandronum"
[[ -x "$bin" ]] || { echo "ERROR: $bin missing -- patched build failed" >&2; exit 1; }
# The bridge must actually be compiled in, else the MCP can't drive this engine.
grep -q ZANDRONUM_BRIDGE_PORT "$bin" \
  || { echo "ERROR: $bin has no MCP bridge marker -- overlay was not compiled in" >&2; exit 1; }

# 1. Gather the runtime payload (binary + game data), skipping CMake build junk.
cp "$bin" "$PAYLOAD/"
cp "$BUILD"/*.pk3 "$PAYLOAD/"
cp "$BUILD"/*.wad "$PAYLOAD/" 2>/dev/null || true   # freedoom WADs, if staged

# 2. Gather the dylibs. build.sh stages fmod + SDL2 next to the binary but NOT
#    sdl12-compat, so pull that one from the dependency prefix.
cp "$BUILD/libfmodex.dylib"      "$PAYLOAD/"
cp "$BUILD/libSDL2-2.0.0.dylib"  "$PAYLOAD/"
cp "$DEPLIB/libSDL-1.2.0.dylib"  "$PAYLOAD/"

# 3. Make every load path relative to the binary's own folder (@loader_path) so
#    the bundle is position-independent.
install_name_tool -id @loader_path/libfmodex.dylib      "$PAYLOAD/libfmodex.dylib"
install_name_tool -id @loader_path/libSDL2-2.0.0.dylib  "$PAYLOAD/libSDL2-2.0.0.dylib"
install_name_tool -id @loader_path/libSDL-1.2.0.dylib   "$PAYLOAD/libSDL-1.2.0.dylib"
# Rewrite whatever absolute sdl12-compat path the linker baked into the binary.
# (libfmodex is already @loader_path via build.sh; libSDL2 is dlopen'd by leaf name.)
oldsdl="$(otool -L "$PAYLOAD/zandronum" | awk '/libSDL-1\.2\.0\.dylib/{print $1; exit}')"
[[ -n "$oldsdl" ]] \
  && install_name_tool -change "$oldsdl" @loader_path/libSDL-1.2.0.dylib "$PAYLOAD/zandronum"

# 4. install_name_tool invalidates code signatures; re-sign ad-hoc so Rosetta /
#    Gatekeeper will load the images.
for f in "$PAYLOAD/zandronum" "$PAYLOAD"/*.dylib; do
  codesign --remove-signature "$f" 2>/dev/null || true
  codesign --force --sign - "$f"
done

# 5. Fail loudly if any absolute build-machine path survived -- that would load a
#    library that does not exist on a user's Mac.
if otool -L "$PAYLOAD/zandronum" "$PAYLOAD"/*.dylib | grep -E '/Users/|/deps/x86/'; then
  echo "ERROR: absolute build paths remain in the packaged binaries (not portable)" >&2
  exit 1
fi

# 6. Zip with a single top-level zandronum/ folder (preserves +x and symlinks).
rm -f "$OUT_ZIP"
( cd "$WORK" && zip -r -y -X "$OUT_ZIP" zandronum >/dev/null )
echo "Packaged portable macOS engine -> $OUT_ZIP"
ls -lh "$OUT_ZIP"
