<p align="center">
  <img src="assets/zandromcp.png" alt="zandronum-mcp" width="200">
</p>

# zandronum-mcp

Let an AI assistant supercharge Zandronum development from your editor: Write C++ code, ACS, DECORATE, fix bugs, the works.


## Setup

1. Get a bridge-patched Zandronum engine — download one from
   [Releases](https://github.com/rc4l/ZandronumMCP/releases) (Windows for now), or
   build it yourself (see "Build the engine yourself").
2. Add the server to your MCP client with `npx` (below) and point `ZANDRONUM_EXE` at
   that engine.
3. Tell your agent to launch the game and start working.

## Add it to your client

Most clients (Claude Code, Claude Desktop, Cursor, ...) take a JSON block:

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

Set `ZANDRONUM_EXE` to your patched engine if you want the assistant to launch the
game itself. Restart the client to pick up the server.

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

## Build the engine yourself

Only needed if you're not using a prebuilt binary from Releases.

Patch your Zandronum source tree (your AI agent can run this for you):

```bash
node engine-bridge/apply-bridge.mjs --src path/to/zandronum
```

It adds a few one-line, idempotent hooks; `--revert` undoes it.

Then build Zandronum its normal way — this is Zandronum's own CMake build, not ours.
New to it? Start from the official guides at <https://wiki.zandronum.com/>
("Compiling Zandronum") to get the toolchain set up.

- Windows: however you normally build it.
- Linux / macOS: `cmake -B build -DCMAKE_BUILD_TYPE=Release . && cmake --build build`
  from the source tree.

The bridge builds on all three (Winsock on Windows, BSD sockets elsewhere).

## Dev

Working on this server itself:

```bash
npm install
npm run build      # -> dist/server.js
npm test
npm run coverage
```
