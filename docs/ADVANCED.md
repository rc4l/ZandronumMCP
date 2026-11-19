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
  `SOUND=1 ./build.sh` again. That harness's `build.sh` assembles a relocatable,
  ad-hoc-signed `build/Zandronum.app` (binary + game data + dylibs under
  `Contents/MacOS`, load paths rewritten to `@loader_path`). Our
  `.github/scripts/package-macos-engine.sh` verifies that bundle (bridge compiled
  in, no absolute paths), **rebrands it to `zandronum-mcp-hooks.app`** (it's
  Zandronum *with the MCP hooks*, not stock), and zips it — `build.sh` owns the
  bundling, we own the branding.
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

On macOS the prebuilt engine ships as **`zandronum-mcp-hooks.app`** (an Intel build,
launched under Rosetta 2; the SDL/FMOD dylibs and game data live in `Contents/MacOS`
alongside the binary). Point `ZANDRONUM_EXE` at the `.app` — the MCP resolves it to
`Contents/MacOS/zandronum-mcp-hooks` and sets `DYLD_LIBRARY_PATH` for you. To launch
by hand, run the inner binary directly so the bridge env is in scope:

```bash
ZANDRONUM_BRIDGE_PORT=7777 zandronum-mcp-hooks.app/Contents/MacOS/zandronum-mcp-hooks -iwad freedoom2.wad
```

### Linux / X11: `DISPLAY`

On Linux the game needs `DISPLAY` to reach your X server, but IDEs often spawn the
MCP server (over stdio) without it — so the launched game can't open a window and
never starts (see [issue #6](https://github.com/rc4l/ZandronumMCP/issues/6)). The
server now defaults `DISPLAY` to `:0` for the game it launches, which covers the
common single-display case. If your X server is elsewhere (e.g. `:1`, or a remote
display), set it explicitly in the MCP env:

```json
"env": { "ZANDRONUM_BRIDGE_PORT": "7777", "ZANDRONUM_EXE": "...", "DISPLAY": ":1" }
```

(An explicit `DISPLAY` is always respected; the `:0` default only fills it in when
it's missing.)

### Linux / X11: window position on a specific monitor

By default the launched window lands wherever the window manager places it. To
pin it to a specific spot (e.g. a second monitor), set `ZANDRONUM_WINDOW_POS` in
the MCP env — the server passes it through as SDL's windowed-mode position hint.
Find your monitor's origin with `xrandr --listmonitors` (the `+X+Y` in each
line):

```json
"env": { "ZANDRONUM_BRIDGE_PORT": "7777", "ZANDRONUM_EXE": "...", "ZANDRONUM_WINDOW_POS": "1920,0" }
```

There is no default here — unlike `DISPLAY`, a fixed position isn't safe for
every setup (it would push a single-monitor user's window off-screen), so
nothing moves unless you opt in. As with `DISPLAY`, an explicit
`SDL_VIDEO_WINDOW_POS` already in the launching environment is always respected
over `ZANDRONUM_WINDOW_POS`.

### Engine config and IWAD locations

Launched engines run on `zandronum-mcp.ini` beside the engine binary, so a clean
rebuild of a build folder resets it. To keep one config across builds, point
`ZANDRONUM_CONFIG` at an ini anywhere else. `ZANDRONUM_IWAD` is the IWAD a launch
uses when the call names none; without it the engine searches for one itself:

```json
"env": { "ZANDRONUM_EXE": "...", "ZANDRONUM_CONFIG": "/path/to/zandronum-mcp.ini", "ZANDRONUM_IWAD": "/path/to/DOOM2.WAD" }
```

### Gatekeeper / "Apple could not verify…"

The app is ad-hoc signed but **not notarized** (a paid Apple Developer ID would be
required — stock Zandronum isn't notarized either), so a *downloaded* copy carries
the `com.apple.quarantine` flag and Gatekeeper refuses it. This also kills it when
spawned, not just when double-clicked. The MCP clears the flag automatically before
launching (`launch_instance` runs `xattr -dr com.apple.quarantine` on the engine
folder). To run it yourself, do it once:

```bash
xattr -dr com.apple.quarantine /path/to/zandronum-mcp-hooks.app
```

The ad-hoc signature is enough to *execute* once quarantine is gone; the flag is
the only thing Gatekeeper gates. A self-built engine is never quarantined, so this
only affects downloads. (For a no-friction download you'd sign with a Developer ID
and notarize the app in CI — not wired up here.)

## ACS compilers for `run_acs`

`run_acs` compiles its snippet on the host before loading it into the game, so it needs
[zt-bcc](https://github.com/zeta-group/zt-bcc) (the default) or
[acc](https://github.com/ZDoom/acc) (`compiler: "acc"`) installed. Nothing else needs a
compiler: without one, the server and every other tool work as usual, and `run_acs` returns
an error naming what to install and which variable to set, without touching the game.

The server looks for `zt-bcc`, then `bcc`, on `PATH` (and `acc` for acc). To use a binary
that isn't on `PATH`, set its path in the MCP env:

```json
"env": { "ZANDRONUM_EXE": "...", "ZANDRONUM_BCC": "/path/to/zt-bcc", "ZANDRONUM_ACC": "/path/to/acc" }
```

`#include "zcommon.acs"` needs zt-bcc's `lib/` folder. zt-bcc finds a `lib/` next to its
own binary when it's started by full path, which the server always does, and the server
also adds a `lib/` one folder up (a binary in a source checkout's `build/`), following
symlinks to the real binary. Otherwise pass the folder in the call's `includeDirs`.
Relative `includeDirs` and `ZANDRONUM_BCC`/`ZANDRONUM_ACC` paths are resolved against the
server's working directory; a bare name there (no folder) is looked up on `PATH`.

On Windows the server only runs `.exe` files: a `.cmd` or `.bat` wrapper can't be used.

acc usually finds `zcommon.acs` in its own install; if it doesn't, pass its folder in
`includeDirs` the same way.

The compiled snippet goes in the system temp folder. On Windows the game can't open it there
if that path has non-ASCII characters (a user folder like `C:\Users\José`). If `run_acs`
refuses its temp folder, set `TEMP` in the MCP env to an existing plain-ASCII folder, e.g.
`"TEMP": "C:\\mcp-temp"` (`TMPDIR` on Linux and macOS).

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
npm run docs:tools   # after adding or re-describing a tool (CI runs docs:tools:check)
```
