# Advanced

Everything beyond the happy path: building the engine yourself, launching
manually, Linux/macOS, and working on this server. If you just want to use it, the
[main README](../README.md) is all you need.

## Build the engine yourself

Prebuilt, bridge-patched engines for **Windows** (`zandronum-mcp-engine-windows-x64.zip`)
and **macOS** (`zandronum-mcp-engine-macos-x64.zip`) are attached to every
[Release](https://github.com/rc4l/ZandronumMCP/releases) — grab one and skip this
section. Build it yourself only on Linux, or if you want a custom build.

Patch your Zandronum source tree (your AI agent can run this for you):

```bash
node engine-bridge/apply-bridge.mjs --src path/to/zandronum
```

It copies in the overlay files and adds a few one-line, idempotent hooks;
`--revert` undoes it. The bridge builds on all platforms (Winsock on Windows, BSD
sockets elsewhere).

Then build Zandronum for your OS:

- **Windows / Linux:** build Zandronum its normal way — this is Zandronum's own
  CMake build, not ours. New to it? Start from the official guides at
  <https://wiki.zandronum.com/> ("Compiling Zandronum"). On Linux that's roughly
  `cmake -B build -DCMAKE_BUILD_TYPE=Release . && cmake --build build` from the
  source tree.
- **macOS:** a plain `cmake` build does **not** work — FMOD Ex is x86_64-only (so
  the engine builds for Intel and runs under Rosetta 2) and several deps must be
  built from source. Use the turnkey harness
  [rc4l/zandronum-macos-compile](https://github.com/rc4l/zandronum-macos-compile):
  run `SOUND=1 ./build.sh`, apply the overlay to its `src/zandronum`, then
  `SOUND=1 ./build.sh` again. The build links some dylibs by absolute path, so to
  get a portable folder run `.github/scripts/package-macos-engine.sh <engine-root>
  out.zip` (it bundles the dylibs and rewrites their load paths to `@loader_path`).
  This is exactly what CI does — see [`.github/workflows/release.yml`](../.github/workflows/release.yml).

## Launch the game manually

With `ZANDRONUM_EXE` set, the agent launches the game for you. To do it yourself,
launch the patched build with the bridge turned on:

```bash
# Linux / macOS
ZANDRONUM_BRIDGE_PORT=7777 ./zandronum -iwad freedoom2.wad
```

```powershell
# Windows
$env:ZANDRONUM_BRIDGE_PORT = "7777"; ./zandronum.exe -iwad freedoom2.wad
```

The bridge only starts when that variable is set, so a normal launch is unaffected.
Instance 1 uses 7777, instance 2 uses 7778, and so on.

On macOS the prebuilt engine ships as **`Zandronum.app`** (an Intel build, launched
under Rosetta 2; the SDL/FMOD dylibs and game data live in `Contents/MacOS`
alongside the binary). Point `ZANDRONUM_EXE` at the `.app` — the MCP resolves it to
`Contents/MacOS/zandronum` and sets `DYLD_LIBRARY_PATH` for you. To launch by hand,
run the inner binary directly so the bridge env is in scope:

```bash
ZANDRONUM_BRIDGE_PORT=7777 Zandronum.app/Contents/MacOS/zandronum -iwad freedoom2.wad
```

### Gatekeeper / "Apple could not verify…"

The app is ad-hoc signed but **not notarized** (a paid Apple Developer ID would be
required — stock Zandronum isn't notarized either), so a *downloaded* copy carries
the `com.apple.quarantine` flag and Gatekeeper refuses it. This also kills it when
spawned, not just when double-clicked. The MCP clears the flag automatically before
launching (`launch_instance` runs `xattr -dr com.apple.quarantine` on the engine
folder). To run it yourself, do it once:

```bash
xattr -dr com.apple.quarantine /path/to/Zandronum.app
```

The ad-hoc signature is enough to *execute* once quarantine is gone; the flag is
the only thing Gatekeeper gates. A self-built engine is never quarantined, so this
only affects downloads. (For a no-friction download you'd sign with a Developer ID
and notarize the app in CI — not wired up here.)

## Run the server from source

Instead of the published `npx` package, you can point your client at a local build:

```bash
npm install
npm run build      # -> dist/server.js
```

Then in your client config use `"command": "node"` with the path to your
`dist/server.js` instead of the `npx` form.

## Dev

```bash
npm test
npm run coverage
```
