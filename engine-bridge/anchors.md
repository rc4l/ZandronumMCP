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
| 5 | `src/CMakeLists.txt` | end of file (append) | `target_sources( zdoom PRIVATE mcp_bridge.cpp )` | compile the overlay into the `zdoom` target |

Notes:
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
