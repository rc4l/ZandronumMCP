#!/usr/bin/env bash
#
# package-macos-engine.sh -- turn a bridge-patched zandronum-macos-compile build
# into a portable, relocatable macOS .app bundle, zipped as a release asset.
#
# Two problems this solves:
#   1. Relocatability. zandronum-macos-compile's build.sh links sdl12-compat
#      (libSDL-1.2.0.dylib) by an ABSOLUTE build-machine path and never stages
#      that dylib next to the binary; sdl12-compat in turn dlopen()s libSDL2 at
#      runtime. Left as-is the build only runs with DYLD_LIBRARY_PATH pointing at
#      deps/x86/lib. We gather the binary, game data, and every dylib into the
#      bundle and rewrite all load paths to @loader_path so it runs anywhere.
#   2. App identity / lifecycle. A bare Unix binary shows up as "exec" in the dock
#      and gets a half-baked Cocoa lifecycle (quitting can leave a stray process).
#      Wrapping it in a .app with an Info.plist gives macOS a real app: proper dock
#      name and normal Cmd-Q / window-close termination -- the same shape the
#      official Zandronum.app ships in.
#
# We stage + sign the Mach-O files FLAT first (codesign goes "bundle-aware" and
# trips over sibling files once they sit inside a .app), then assemble the bundle
# from the already-signed files -- ad-hoc signatures are embedded in the Mach-O,
# so relocating them into the bundle keeps them valid.
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
STAGE="$WORK/stage"                  # flat scratch: surgery + signing happen here
mkdir -p "$STAGE"

bin="$BUILD/zandronum"
[[ -x "$bin" ]] || { echo "ERROR: $bin missing -- patched build failed" >&2; exit 1; }
# The bridge must actually be compiled in, else the MCP can't drive this engine.
grep -q ZANDRONUM_BRIDGE_PORT "$bin" \
  || { echo "ERROR: $bin has no MCP bridge marker -- overlay was not compiled in" >&2; exit 1; }

# 1. Gather the runtime payload (binary + game data), skipping CMake build junk.
cp "$bin" "$STAGE/"
cp "$BUILD"/*.pk3 "$STAGE/"
cp "$BUILD"/*.wad "$STAGE/" 2>/dev/null || true   # freedoom WADs, if staged

# 2. Gather the dylibs. build.sh stages fmod + SDL2 next to the binary but NOT
#    sdl12-compat, so pull that one from the dependency prefix.
cp "$BUILD/libfmodex.dylib"      "$STAGE/"
cp "$BUILD/libSDL2-2.0.0.dylib"  "$STAGE/"
cp "$DEPLIB/libSDL-1.2.0.dylib"  "$STAGE/"

# 3. Make every load path relative to the binary's own folder (@loader_path) so
#    the bundle is position-independent.
install_name_tool -id @loader_path/libfmodex.dylib      "$STAGE/libfmodex.dylib"
install_name_tool -id @loader_path/libSDL2-2.0.0.dylib  "$STAGE/libSDL2-2.0.0.dylib"
install_name_tool -id @loader_path/libSDL-1.2.0.dylib   "$STAGE/libSDL-1.2.0.dylib"
# Rewrite whatever absolute sdl12-compat path the linker baked into the binary.
# (libfmodex is already @loader_path via build.sh; libSDL2 is dlopen'd by leaf name.)
oldsdl="$(otool -L "$STAGE/zandronum" | awk '/libSDL-1\.2\.0\.dylib/{print $1; exit}')"
[[ -n "$oldsdl" ]] \
  && install_name_tool -change "$oldsdl" @loader_path/libSDL-1.2.0.dylib "$STAGE/zandronum"

# 4. Re-sign the Mach-O files ad-hoc (install_name_tool invalidated them). Flat
#    location => codesign treats each as a standalone object, no bundle subcomponent
#    checks. Ad-hoc is enough to execute under Rosetta; the build is un-notarized
#    regardless, so a bundle-level seal would add nothing.
for f in "$STAGE/zandronum" "$STAGE"/*.dylib; do
  codesign --remove-signature "$f" 2>/dev/null || true
  codesign --force --sign - "$f"
done
codesign --verify "$STAGE/zandronum" || { echo "ERROR: binary failed codesign verify" >&2; exit 1; }

# 5. Fail loudly if any absolute build-machine path survived -- that would load a
#    library that does not exist on a user's Mac.
if otool -L "$STAGE/zandronum" "$STAGE"/*.dylib | grep -E '/Users/|/deps/x86/'; then
  echo "ERROR: absolute build paths remain in the packaged binaries (not portable)" >&2
  exit 1
fi

# 6. Assemble the .app around the signed files. Game data lives next to the binary
#    in MacOS/ (Zandronum resolves pk3s/WADs relative to the executable), so the
#    bundle behaves exactly like the flat layout that already works.
APP="$WORK/Zandronum.app"
MACOS="$APP/Contents/MacOS"
mkdir -p "$MACOS"
mv "$STAGE"/* "$MACOS/"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>           <string>zandronum</string>
	<key>CFBundleIdentifier</key>           <string>com.rc4l.zandronum-mcp-engine</string>
	<key>CFBundleName</key>                 <string>Zandronum</string>
	<key>CFBundleDisplayName</key>          <string>Zandronum (MCP)</string>
	<key>CFBundlePackageType</key>          <string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleShortVersionString</key>   <string>3.2.1</string>
	<key>CFBundleVersion</key>              <string>3.2.1</string>
	<key>LSMinimumSystemVersion</key>       <string>10.13</string>
	<key>LSArchitecturePriority</key>       <array><string>x86_64</string></array>
	<key>NSHighResolutionCapable</key>      <true/>
	<key>NSPrincipalClass</key>             <string>NSApplication</string>
</dict>
</plist>
PLIST
plutil -lint "$APP/Contents/Info.plist" >/dev/null || { echo "ERROR: bad Info.plist" >&2; exit 1; }

# 7. Zip the .app (preserve +x and symlinks).
rm -f "$OUT_ZIP"
( cd "$WORK" && zip -r -y -X "$OUT_ZIP" Zandronum.app >/dev/null )
echo "Packaged macOS engine app -> $OUT_ZIP"
ls -lh "$OUT_ZIP"
