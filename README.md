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

2. Learn how to add MCP Servers to your preferred editor. In VS Code, put this in `.vscode/mcp.json` (Cursor, Claude
   Desktop, Windsurf, etc. uses something similar. Go look it up yourself or have your AI agent do it for you)

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

   Point `ZANDRONUM_EXE` at the `zandronum.exe` you just unzipped, then restart your chat session.

3. You're done. You can now ask your agent to start working on the engine or start making mods.

## Advanced

Building the engine yourself, Linux/macOS, launching manually, running the server
from source, contributing →
**[docs/ADVANCED.md](https://github.com/rc4l/ZandronumMCP/blob/main/docs/ADVANCED.md)**.
