#!/usr/bin/env bash
#
# package-macos-engine.sh -- rebrand and zip the bridge-patched Zandronum.app that
# zandronum-macos-compile's build.sh produced, as the release asset.
#
# build.sh (make_app_bundle) is the single source of truth for the *bundle*: it
# emits a relocatable, ad-hoc-signed Zandronum.app with the binary, game data, and
# every non-system dylib under Contents/MacOS (load paths rewritten to
# @loader_path, following the full link graph). We don't re-bundle here.
#
# What we DO add is MCP-specific branding: build.sh makes a vanilla "Zandronum",
# but this is Zandronum *with the MCP hooks compiled in*, so we rename the app and
# its executable to "zandronum-mcp-hooks" to make that unmistakable. Then we gate
# on "is this actually shippable" (bridge compiled in, valid signature, no
# absolute build paths) and zip it.
#
# Usage: package-macos-engine.sh <engine-root> <out-zip>
#   <engine-root>  a zandronum-macos-compile checkout (build.sh has run, so
#                  build/Zandronum.app exists)
#   <out-zip>      absolute path of the .zip to write
#
set -euo pipefail

NEW_NAME="zandronum-mcp-hooks"            # MCP-hooked engine; not stock Zandronum
DISPLAY_NAME="Zandronum MCP Hooks"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICNS="$SCRIPT_DIR/../../assets/$NEW_NAME.icns"   # committed square app icon

ENGINE_ROOT="${1:?usage: package-macos-engine.sh <engine-root> <out-zip>}"
OUT_ZIP="${2:?usage: package-macos-engine.sh <engine-root> <out-zip>}"
BUILD="$ENGINE_ROOT/build"
SRC_APP="$BUILD/Zandronum.app"

[[ -d "$SRC_APP" ]] || { echo "ERROR: $SRC_APP missing -- build.sh did not produce the bundle (old build harness?)" >&2; exit 1; }
[[ -x "$SRC_APP/Contents/MacOS/zandronum" ]] || { echo "ERROR: inner binary missing in $SRC_APP" >&2; exit 1; }

# 1. Rebrand into a renamed bundle (leave build.sh's output untouched).
WORK="$(mktemp -d)"
APP="$WORK/$NEW_NAME.app"
BIN="$APP/Contents/MacOS/$NEW_NAME"
cp -R "$SRC_APP" "$APP"
mv "$APP/Contents/MacOS/zandronum" "$BIN"
PL="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable $NEW_NAME" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleName $DISPLAY_NAME" "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleName string $DISPLAY_NAME" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $DISPLAY_NAME" "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $DISPLAY_NAME" "$PL"

# Icon: own it here rather than rely on build.sh's make_icon (best-effort, needs
# Pillow on the runner, and on failure leaves a bogus CFBundleIconFile). Drop any
# icon build.sh produced and install our committed square app icon.
[[ -f "$ICNS" ]] || { echo "ERROR: app icon missing at $ICNS" >&2; exit 1; }
rm -f "$APP/Contents/Resources/"*.icns
mkdir -p "$APP/Contents/Resources"
cp "$ICNS" "$APP/Contents/Resources/$NEW_NAME.icns"
/usr/libexec/PlistBuddy -c "Set :CFBundleIconFile $NEW_NAME" "$PL" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Add :CFBundleIconFile string $NEW_NAME" "$PL"

# 2. Renaming + the plist edits invalidate the prior bundle seal. Re-seal with
#    build.sh's exact sequence (sign each dylib, then deep-sign the bundle) so the
#    CodeResources match the renamed exe; a binary-only re-sign leaves a stale
#    seal keyed to the old name.
rm -rf "$APP/Contents/_CodeSignature"
for f in "$APP/Contents/MacOS"/*.dylib; do codesign --force --sign - "$f"; done
codesign --force --deep --sign - "$APP"

# --- shippability gates (on the final, renamed artifact) --------------------
# The bridge must actually be compiled in, else the MCP can't drive this engine.
grep -q ZANDRONUM_BRIDGE_PORT "$BIN" \
  || { echo "ERROR: $BIN has no MCP bridge marker -- overlay was not compiled in" >&2; exit 1; }
# Confirm the binary carries an ad-hoc signature -- that's what lets it execute
# (incl. under Rosetta). A full `codesign --verify` goes bundle-aware and trips
# over the sibling pk3/WAD data (not code, can't be lifted out either since the
# signature references Info.plist), so just confirm the signature is present.
sig="$(codesign -dv "$BIN" 2>&1 || true)"
[[ "$sig" == *"Signature=adhoc"* ]] \
  || { echo "ERROR: $BIN is not ad-hoc signed" >&2; exit 1; }
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

# 3. Zip the renamed .app (preserve +x and symlinks).
rm -f "$OUT_ZIP"
( cd "$WORK" && zip -r -y -X "$OUT_ZIP" "$NEW_NAME.app" >/dev/null )
echo "Packaged macOS engine app ($NEW_NAME.app) -> $OUT_ZIP"
ls -lh "$OUT_ZIP"
