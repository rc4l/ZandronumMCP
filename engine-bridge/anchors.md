# Engine bridge anchors

The bridge logic lives entirely in the overlay file `overlay/mcp_bridge.cpp`.
Only the **call sites** below touch existing upstream files, and each is a
single line. If an upstream update moves one, `apply-bridge` fails loudly
naming the file + anchor; re-locate the landmark here, fix it, then regenerate.

All insertions are idempotent (guarded by a marker string) and re-applied on top
of a pristine `hg` checkout at build time — see the project README.

| # | File | Landmark (regex) | We insert | Why there |
|---|------|------------------|-----------|-----------|
| 1 | `src/d_main.cpp` | first `#include` | `#include "mcp_bridge.h"` | make the hooks visible |
| 2 | `src/d_main.cpp` | `switch \( NETWORK_GetState\( \)\)` *(scoped to after `void D_DoomLoop`)* | `MCP_Bridge_Poll();` before the switch | runs every frame in **all** modes (single/client/server) |
| 3 | `src/c_console.cpp` | first `#include` | `#include "mcp_bridge.h"` | make the hooks visible |
| 4 | `src/c_console.cpp` | `I_PrintStr \(outlinecopy\)` | `MCP_Bridge_TeeOutput( outlinecopy );` after it | mirrors every console line the engine prints |
| 4a | `src/c_console.cpp` | `C_AddNotifyString \(printlevel, outlinecopy\);` | `if ( MCP_Bridge_ShowInNotify( outlinecopy ) )` before it | bridge replies skip only the notify area; console, logfile and tee remain intact; synchronous game scripts and gameplay callbacks suspend the reply guard |
| 4b | `src/c_console.cpp` | `const int length = static_cast<int>\(strlen \(outlinecopy\)\);` *(scoped to after `For servers, dump message to console window`)* | `MCP_Bridge_TeeOutput( outlinecopy );` before it | a `-host` server returns before #4, so without this its replies never reach the bridge. Runs after #4, whose marker this line contains |
| 5 | `src/CMakeLists.txt` | end of file (append) | `target_sources( zdoom PRIVATE mcp_bridge.cpp ... )`, every overlay `.cpp` | compile the overlay into the `zdoom` target. The line is rebuilt from `OVERLAY_FILES`, so a re-apply adds a new `.cpp` in place |
| 6 | `src/g_game.cpp` | first `#include` | `#include "mcp_bridge.h"` | make the hook visible |
| 7 | `src/g_game.cpp` | `// check for turbo cheats` *(scoped to after `void G_Ticker`)* | `MCP_Input_Override( i, cmd );` before it | the tic's real cmd was just copied into `players[i].cmd` (after `oldbuttons` and the demo read), so an armed `mcp_input` timeline replaces it for that tic only |

Notes:
- **No new anchors for the crash handler.** `overlay/mcp_crash.cpp` (the fatal-signal
  backtrace writer, read back by the `get_crash` tool) is armed from within
  `mcp_bridge.cpp` (`MCP_Crash_Init()` called from `MCP_Bridge_TeeOutput`/`Poll`), so
  it rides the existing anchors #2 and #4 — only the `target_sources` list in #5 gains
  `mcp_crash.cpp`. It is generic (applies to stock Zandronum or any fork) and opt-in
  (arms only when `ZANDRONUM_BRIDGE_PORT` is set).
- **ACS CCMD blocks.** Each `overlay/*.inc` is appended to `src/p_acs.cpp` (for its
  file-static ACS arrays and `P_GetScriptGoing`) between a `// ==== NAME (...) ====`
  line and a `// ==== end NAME ====` line. A re-apply replaces a block whose overlay
  copy changed, so an edited `.inc` reaches the tree; it throws if the end line is gone.
  `#include "mcp_bridge.h"` goes in at `p_acs.cpp`'s first `#include` first, since the blocks
  call its helpers (`MCP_ScriptNumber`, `MCPBridgeReplySuspendGuard`).
- The CMake executable target is named **`zdoom`** (output is renamed to
  `zandronum.exe`), confirmed at `CMakeLists.txt: add_executable( zdoom WIN32 ...`.
- The bridge is **cross-platform**: `mcp_bridge.cpp` builds on Windows (Winsock)
  and POSIX (BSD sockets), and uses `std::thread`/`std::mutex` for one shared code
  path. On Windows `ws2_32` is already linked by the engine and the overlay also
  carries `#pragma comment(lib, "ws2_32.lib")`, so no link-line change is needed;
  that pragma is a harmless no-op under GCC/Clang. The only build dependency to
  confirm on Linux is a threads library (`-lpthread` / `Threads::Threads`), which
  the engine already links.
- Anchors verified against **ZA_3.2.1**.
