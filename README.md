<p align="center">
  <img src="assets/zandromcp.png" alt="zandronum-mcp" width="200">
</p>

# zandronum-mcp

Let an AI assistant supercharge Zandronum development from your editor: Write C++ code, ACS, DECORATE, fix bugs, the works.


## Setup

**Easiest:** grab a prebuilt, bridge-patched engine from
[Releases](https://github.com/rc4l/ZandronumMCP/releases) (Windows for now), set
`ZANDRONUM_EXE` to it, and add the server with `npx` (see "Add it to your client").
No source build.

To build it yourself — one-time, in order (redo only when you update Zandronum):

1. You: Clone the Zandronum source.
2. You: Compile and build Zandronum.
3. You: Build this server — `npm run build` (needs Node 20+).
4. You: Point your MCP client at it (see below).
5. Your AI Agent: applies the bridge patch and rebuilds the engine.
6. You: Tell your agent to launch the game and start working.

## Patch Zandronum

Point the patch script at your Zandronum source tree:

```bash
node engine-bridge/apply-bridge.mjs --src path/to/zandronum
```

It copies the overlay files in and adds a few one-line, idempotent hooks; re-running
skips anything already applied. `--revert` removes the overlay files.

## Build Zandronum

Compiling Zandronum is Zandronum's own build, not something this repo provides — the
patch just adds source files to its existing CMake build. If you've never built it,
start from the official guides at <https://wiki.zandronum.com/> ("Compiling
Zandronum") to get the toolchain set up.

Then build as usual:

- Windows: however you normally build it.
- Linux / macOS: `cmake -B build -DCMAKE_BUILD_TYPE=Release . && cmake --build build`
  from the source tree.

The bridge builds on all three (Winsock on Windows, BSD sockets elsewhere).

## Build this server

```bash
npm install
npm run build
```

That creates `dist/server.js`, which is what your MCP client runs.

## Add it to your client

Most clients (Claude Code, Claude Desktop, Cursor, ...) take a JSON block. Using the
published package (no clone needed):

```json
{
  "mcpServers": {
    "zandronum": {
      "command": "npx",
      "args": ["-y", "zandronum-mcp"],
      "env": {
        "ZANDRONUM_BRIDGE_HOST": "127.0.0.1",
        "ZANDRONUM_BRIDGE_PORT": "7777",
        "ZANDRONUM_EXE": "C:/path/to/zandronum.exe"
      }
    }
  }
}
```

Claude Code one-liner: `claude mcp add zandronum -- npx -y zandronum-mcp`.

From a local build instead? Use `"command": "node"` with the path to your
`dist/server.js`. Either way, set `ZANDRONUM_EXE` to the patched binary if you want
the assistant to launch the game itself. Restart the client to pick up the server.

## Run

Launch the patched build with the bridge on:

```powershell
# Windows
$env:ZANDRONUM_BRIDGE_PORT = "7777"; ./zandronum.exe -iwad freedoom2.wad
```

```bash
# Linux / macOS
ZANDRONUM_BRIDGE_PORT=7777 ./zandronum -iwad freedoom2.wad
```

The bridge only starts when that variable is set, so a normal launch is unaffected.
Instance 1 uses 7777, instance 2 uses 7778, and so on.

Then ask the assistant to do things. Some of the tools:

- run_command — run any console command
- list_actor_classes — list the actors the game knows about
- summon — spawn an actor
- give — give yourself an item
- load_map — load a map by name (MAP01, E1M1, ...)

## Dev

```bash
npm test
npm run coverage
```
