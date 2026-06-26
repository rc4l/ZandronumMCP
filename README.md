<p align="center">
  <img src="assets/zandromcp.png" alt="zandronum-mcp" width="200">
</p>

# zandronum-mcp

Let an AI assistant supercharge Zandronum development from your editor: Write C++ code, ACS, DECORATE, fix bugs, the works.


## Setup

1. **Download the engine.** Grab `zandronum-mcp-engine-windows-x64.zip` from
   [Releases](https://github.com/rc4l/ZandronumMCP/releases) and unzip it anywhere.
   (Windows for now — other platforms:
   [build it yourself](https://github.com/rc4l/ZandronumMCP/blob/main/docs/ADVANCED.md).)

2. **Add the server.** In VS Code, put this in `.vscode/mcp.json` (Cursor, Claude
   Desktop, Windsurf, etc. use the same block but with `"mcpServers"` instead of
   `"servers"`):

   ```json
   {
     "servers": {
       "zandronum": {
         "command": "npx",
         "args": ["-y", "zandronum-mcp"],
         "env": {
           "ZANDRONUM_BRIDGE_PORT": "7777",
           "ZANDRONUM_EXE": "C:/path/to/zandronum.exe"
         }
       }
     }
   }
   ```

   Point `ZANDRONUM_EXE` at the `zandronum.exe` you just unzipped, then restart.
   (Claude Code is simplest — skip the JSON: `claude mcp add zandronum -- npx -y zandronum-mcp`.)

3. **Go.** Ask your agent to launch the game and start working.

## What it can do

Some of the tools your agent gets:

- run_command — run any console command
- summon — spawn an actor
- give — give yourself an item
- load_map — load a map (MAP01, E1M1, ...)
- list_actor_classes — list the actors the game knows about

## Advanced

Building the engine yourself, Linux/macOS, launching manually, running the server
from source, contributing →
**[docs/ADVANCED.md](https://github.com/rc4l/ZandronumMCP/blob/main/docs/ADVANCED.md)**.
