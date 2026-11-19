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

### Engine config, IWAD and gamelog locations

Launched engines run on `zandronum-mcp.ini` beside the engine binary, so a clean
rebuild of a build folder resets it. To keep one config across builds, point
`ZANDRONUM_CONFIG` at an ini anywhere else (`config: "isolated"` copies sit beside
it). `ZANDRONUM_IWAD` is the IWAD a launch uses when the call names none; without
it the engine searches for one itself. Each launch logs the console to a timestamped
gamelog (the bridge log `read_marks` and log waits read is rewritten each launch;
`read_marks gamelog=` reads an earlier session's marks from these), by default under a per-user folder in
the system temp dir; `ZANDRONUM_BRIDGE_GAMELOG` sets the path prefix instead. Set it
to keep playtest marks across reboots (temp dirs get cleaned), and on Windows when the
temp path has non-ASCII characters (the engine can't open those):

```json
"env": { "ZANDRONUM_EXE": "...", "ZANDRONUM_CONFIG": "/path/to/zandronum-mcp.ini", "ZANDRONUM_IWAD": "/path/to/DOOM2.WAD", "ZANDRONUM_BRIDGE_GAMELOG": "/path/to/logs/zagamelog" }
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

## ACS compilers

`run_acs` compiles its snippet on the host before loading it into the game, so it needs
[zt-bcc](https://github.com/zeta-group/zt-bcc) (the default) or
[acc](https://github.com/ZDoom/acc) (`compiler: "acc"`) installed. The map-var tools'
`sourceFile` builds the named source with zt-bcc too. Nothing else needs a
compiler: without one, the server and every other tool work as usual, and these calls return
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

### Per-project profiles

One server usually serves every mod, so per-project settings go in a profile file kept in
that project, not in the server's env. `ZANDRONUM_RUNACS_PROFILES` lists the profile files,
separated like `PATH` (`:` on Linux and macOS, `;` on Windows):

```json
"env": { "ZANDRONUM_RUNACS_PROFILES": "/path/to/mymod/scripts/mcp-run-acs.json" }
```

A profile applies itself to a snippet that `#import`s one of the libraries it lists (compared
by file name, in any case), so no call needs an extra argument and a snippet for another mod
never picks it up. The files are read on every call, so an edit applies right away.

```json
{ "imports": ["mylib.acs"],
  "includeDirs": ["."],
  "rawDefines": true,
  "defineFiles": ["mydefs.acs"],
  "defines": { "MCP_PROBE": "1" } }
```

- `imports` (required): library file names that select the profile.
- `includeDirs`: added after the call's own `includeDirs`, before zt-bcc's `lib/`.
- `defineFiles`: headers whose `#define` and `#libdefine` lines are copied ahead of the
  snippet. `#import` doesn't carry a library's `#define`s, and including the header again
  fails on its enums, so the server copies only the define lines. A define inside an `#if`
  block (other than the header's include guard) is refused, since the server can't evaluate
  conditionals.
- `defines`: extra `NAME: value` defines. A name a defineFile also defines is an error.
- `rawDefines`: puts `#pragma raw define on` first (zt-bcc only), for libraries whose
  headers use it. Raw defines are case-sensitive, and so are the snippet's own `#define`s
  while such a profile applies.

Relative paths resolve against the profile file's folder. The reply names each profile it
applied (`profile: <file>`), and a compile error in a copied define points at its own file
and line, not at the generated prelude.

### Map vars by source (`sourceFile`)

How the map-var tools find a var the module doesn't export, and why that fails closed: PROTOCOL.md, ACS.

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
npm run e2e          # drives a real bridge build through the tools; needs ZANDRONUM_EXE, ZANDRONUM_IWAD and a display
```

The `docs:tools` scripts load TypeScript with `node --import`, which needs Node 20.6 or newer.
`npm run e2e` reads `dist/`, so build first; it ends with `all checks passed`.
