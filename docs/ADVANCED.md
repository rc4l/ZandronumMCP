# Advanced

Everything beyond the happy path: building the engine yourself, launching
manually, Linux/macOS, and working on this server. If you just want to use it, the
[main README](../README.md) is all you need.

## Build the engine yourself

Only needed if you're not grabbing a prebuilt binary from
[Releases](https://github.com/rc4l/ZandronumMCP/releases) — e.g. on Linux/macOS, or
if you want a custom build.

Patch your Zandronum source tree (your AI agent can run this for you):

```bash
node engine-bridge/apply-bridge.mjs --src path/to/zandronum
```

It copies in the overlay files and adds a few one-line, idempotent hooks;
`--revert` undoes it.

Then build Zandronum its normal way — this is Zandronum's own CMake build, not ours.
New to it? Start from the official guides at <https://wiki.zandronum.com/>
("Compiling Zandronum") to get the toolchain set up.

- Windows: however you normally build it.
- Linux / macOS: `cmake -B build -DCMAKE_BUILD_TYPE=Release . && cmake --build build`
  from the source tree.

The bridge builds on all three (Winsock on Windows, BSD sockets elsewhere).

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
