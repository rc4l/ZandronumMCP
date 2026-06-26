#!/usr/bin/env bash
#
# package-macos-engine.sh -- verify and zip the bridge-patched Zandronum.app that
# zandronum-macos-compile's build.sh produced, as the release asset.
#
# build.sh (make_app_bundle) is the single source of truth for the bundle: it
# emits a relocatable, ad-hoc-signed Zandronum.app with the binary, game data, and
# every non-system dylib under Contents/MacOS (load paths rewritten to
# @loader_path, following the full link graph). We do NOT re-bundle here -- we
# just gate on "is this actually shippable" and zip it:
#   * the MCP bridge is compiled into the binary (else the MCP can't drive it),
#   * the binary carries a valid (ad-hoc) signature,
#   * no absolute build-machine paths leaked in (else it breaks on a user's Mac).
#
# Usage: package-macos-engine.sh <engine-root> <out-zip>
#   <engine-root>  a zandronum-macos-compile checkout (build.sh has run, so
#                  build/Zandronum.app exists)
#   <out-zip>      absolute path of the .zip to write
#
set -euo pipefail

ENGINE_ROOT="${1:?usage: package-macos-engine.sh <engine-root> <out-zip>}"
OUT_ZIP="${2:?usage: package-macos-engine.sh <engine-root> <out-zip>}"
BUILD="$ENGINE_ROOT/build"
APP="$BUILD/Zandronum.app"
BIN="$APP/Contents/MacOS/zandronum"

[[ -d "$APP" ]] || { echo "ERROR: $APP missing -- build.sh did not produce the bundle (old build harness?)" >&2; exit 1; }
[[ -x "$BIN" ]] || { echo "ERROR: $BIN missing or not executable" >&2; exit 1; }

# The bridge must actually be compiled in, else the MCP can't drive this engine.
grep -q ZANDRONUM_BRIDGE_PORT "$BIN" \
  || { echo "ERROR: $BIN has no MCP bridge marker -- overlay was not compiled in" >&2; exit 1; }

# The ad-hoc signature is what lets the binary execute (incl. under Rosetta).
codesign --verify "$BIN" 2>/dev/null \
  || { echo "ERROR: $BIN is not validly signed" >&2; exit 1; }

# Nothing may point back at the build machine, or it won't load on a user's Mac.
# Inspect only the actual dependency load commands: `otool -L` also prints header
# lines for the file (and one per slice on a fat binary) that legitimately carry
# the build dir; the real deps are the lines tagged "(compatibility version ...)".
bad=0
for f in "$BIN" "$APP/Contents/MacOS"/*.dylib; do
  refs="$(otool -L "$f" | grep 'compatibility version' | grep -E '/Users/|/deps/x86/' || true)"
  if [[ -n "$refs" ]]; then
    echo "  non-portable refs in $(basename "$f"):" >&2
    echo "$refs" | sed 's/^/    /' >&2
    bad=1
  fi
done
[[ $bad -eq 0 ]] || { echo "ERROR: absolute build paths remain in the bundle (not portable)" >&2; exit 1; }

# Zip the .app as-is (preserve +x and symlinks).
rm -f "$OUT_ZIP"
( cd "$BUILD" && zip -r -y -X "$OUT_ZIP" Zandronum.app >/dev/null )
echo "Packaged macOS engine app -> $OUT_ZIP"
ls -lh "$OUT_ZIP"
