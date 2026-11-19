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
| 7 | `src/g_game.cpp` | `^\s*if \(demorecording\)\s*$` *(scoped to after `void G_Ticker`)* | `newcmd = MCP_Input_Override( i, newcmd );` before it | after `RunNetSpecs`, before the demo write and the copy into `players[i].cmd`, so an armed `mcp_input` timeline replaces the tic's cmd and a recording demo holds the injected input. The hook returns a copy when it overrides: the next tic's net cmd is delta-decoded over this slot, so writing it in place replayed the last injected cmd after a disarm. A tree patched by an older overlay has `MCP_Input_Override( i, cmd );` before `// check for turbo cheats` or `MCP_Input_Override( i, newcmd );` here; that line is deleted first (`~ migrated`) |
| 8 | `src/p_tick.cpp`, `src/p_mobj.cpp`, `src/p_interaction.cpp` | first `#include` | `#include "mcp_bridge.h"` | make the `mcp_rec` hooks visible (forward-declared types only, so this early spot is safe); `src/p_acs.cpp` already has it from the ACS blocks (below) |
| 8a | `src/p_pspr.cpp` | first `#include` | `#include "mcp_bridge.h"` | make the psprite recorder hooks visible |
| 8b | `src/p_pspr.cpp` | `^\s*psp->state = NULL;` *(scoped to `^void P_SetPsprite \(`)* | `MCP_Rec_PspriteClear( player->mo, position );` after it | report a cleared layer rather than its former state |
| 8c | `src/p_pspr.cpp` | `^\s*// \[BB\] Some action functions` *(same scope, before)* | `MCP_Rec_PspriteSet( player->mo, NULL, position );` | after state/tics are assigned and before action functions can recurse; dedupe unchanged states |
| 8d | `src/g_game.cpp` | `^\{` *(scoped to `^void GAME_ResetMap`)* | `MCP_Rec_Reset();` after it | disarm before reset destroys actors; passive host recording ends with `map_reset` |
| 9 | `src/p_tick.cpp` | `^\s*level\.maptime\+\+;` *(scoped to after `void P_Ticker`)* | `MCP_Rec_Tick();` after it | runs once per simulated tic, after players, thinkers and ACS; a `paused = 1` here stops the very next tic |
| 10 | `src/p_mobj.cpp` | `^\s*return actor;` *(scoped to after `AActor *AActor::StaticSpawn`)* | `MCP_Rec_Spawn( actor );` before it | every spawn, on its exact tic; a spawn `BeginPlay` destroyed returned NULL earlier. tid, special and args are set after this returns |
| 11 | `src/p_mobj.cpp` | `g_ActorNetIDList\.freeID \( NetID \);` *(scoped to after `void AActor::Destroy ()`, exactly)* | `MCP_Rec_Destroy( this );` before it | the first line of `Destroy`, while the actor is intact. A looser scope matches `DestroyAllInventory` first and then `FreeNetID`'s `freeID`, which compiles and fires on live actors |
| 12 | `src/p_mobj.cpp` | `tics = GetTics\(newstate\);` *(scoped to after `bool AActor::SetState (`)* | `MCP_Rec_State( this );` after it | `state` and `tics` are the new state's; once per state in a zero-tic chain. Weapon psprites don't go through `SetState` |
| 13 | `src/p_interaction.cpp` | `target->DamageTypeReceived = mod;` | `MCP_Rec_Damage( target, inflictor, source, damage, mod );` after it | after both health subtractions (player and actor), so `hp=` is the health after the hit. Vetoed or fully absorbed damage returns earlier |
| 14 | `src/p_interaction.cpp` | `bool wasgibbed` *(scoped to after `void AActor::Die (`)* | `MCP_Rec_Death( this, source, inflictor );` before it | the top of `Die` |
| 15 | `src/p_acs.cpp` | `DPrintf\("%s started\.` *(scoped to after `DLevelScript::DLevelScript (AActor`)* | `MCP_Rec_ScriptStart( this, num, module->GetModuleName(), activator );` after it | the end of the starting constructor; `DLevelScript`'s members are protected, so the hook gets plain values. A suspended script `P_GetScriptGoing` resumes fires no start |
| 16 | `src/p_acs.cpp` | `^\s*if \(state == SCRIPT_PleaseRemove\)` | `if (state == SCRIPT_PleaseRemove) MCP_Rec_ScriptEnd( this, script );` before it | a script's normal end in `RunScript`; scripts a map reset or level exit kills fire none |
| 17 | `src/d_net.cpp`, `src/sdl/i_system.cpp`, `src/win32/i_system.cpp`, `src/gl/scene/gl_scene.cpp` | first `#include` | `#include "mcp_bridge.h"` | make the frozen-clock hooks visible |
| 18 | `src/d_net.cpp` | `^\s*bool doWait = ` *(scoped to after `void TryRunTics`)* | `if ( MCP_Clock_Hold() ) return;` before it | a frozen frame with no step queued runs no tic and skips the waits, the `lowtic` loop and the counts logic, whose only exits read the clock; with a step queued it advances the virtual tic by one and falls through |
| 19 | `src/d_net.cpp` | `^\s*counts = 1;` *(scoped to after `void TryRunTics`)* | `MCP_Clock_Clamp( counts );` after it | after the unbraced `if (counts < 1)`, so a frozen frame runs one tic at most |
| 20 | `src/sdl/i_system.cpp` | `^\s*if \(ms\) \*ms = ` *(scoped to after `fixed_t I_GetTimeFrac`)* | `if ( MCP_ClockFrozen ) return MCP_ClockFracValue;` after it | the held frac while frozen; #24 inserts between the write and this return |
| 21 | `src/win32/i_system.cpp` | `^\s*DWORD step = TicNext - TicStart;` *(scoped to after `fixed_t I_GetTimeFrac`)* | the same line as #20, before it | the Win32 copy, after its `*ms` write. Compiled only by the Windows build, so it stays identical to #20 |
| 22 | `src/d_main.cpp` | `^\s*D_Display \(\);` *(scoped to after `void D_DoomLoop`)* | `MCP_Clock_AfterDisplay();` after it | the single-player branch's call (the client branch spells it `D_Display( );`): runs the clock's job queue once per presented frame, so a shot reads the frame just drawn |
| 23 | `src/sdl/i_system.cpp`, `src/win32/i_system.cpp` | `^\{` *(scoped to after `^unsigned int I_FPSTime\(\)`)* | guarded `return MCP_Clock_FrameTime( MCP_FRAME_FPS, SDL_GetTicks() );` (Win32: `timeGetTime()`) | opt-in frame time for animation, fps, voxels and HOM; never-held is stock |
| 24 | `src/sdl/i_system.cpp` | `^\s*if \(ms\) \*ms = ` *(scoped to after `fixed_t I_GetTimeFrac`)* | `if ( ms && MCP_ClockFrameUsed ) *ms = MCP_Clock_FrameTime( MCP_FRAME_TICMS, *ms );` after it | before #20 even on re-apply, so warp time advances with held steps |
| 25 | `src/win32/i_system.cpp` | `^\s*\*ms = TicNext;` *(scoped to after `fixed_t I_GetTimeFrac`)* | guarded `*ms = MCP_Clock_FrameTime( MCP_FRAME_TICMS, *ms );` after it | inside the non-null block and before #21, not a second insertion before `DWORD step`; compiled only by the Windows build |
| 26 | `src/gl/scene/gl_scene.cpp` | `^\s*gl_frameMS = I_MSTime\(\);` | guarded `gl_frameMS = MCP_Clock_FrameTime( MCP_FRAME_GLMS, gl_frameMS );` after it | sky scroll, shader timers and GL warp checks share a slot distinct from the raw fps and tic-ms bases |

Notes:
- Frame-time markers name their slot, not the shared helper, because the marker check is file-wide. Each slot anchors on its first held read and rebases on release; cached tic-ms rebases again after the original saved timer read resumes. `framems` reports only the latest fps-slot read, not software-warp continuity.
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
- The six ACS blocks are `MCP_ACSVARS`, `MCP_MAPVARS`, `MCP_MAPSLOT`, `MCP_ACSREF`,
  `MCP_SCRIPTS` and `MCP_RUNACS`, in that order. `MCP_ACSREF` follows the shared digest/slot
  helpers so recorder vars resolve against the same module and array bounds as map-slot reads.
- The CMake executable target is named **`zdoom`** (output is renamed to
  `zandronum.exe`), confirmed at `CMakeLists.txt: add_executable( zdoom WIN32 ...`.
- The bridge is **cross-platform**: `mcp_bridge.cpp` builds on Windows (Winsock)
  and POSIX (BSD sockets), and uses `std::thread`/`std::mutex` for one shared code
  path. On Windows `ws2_32` is already linked by the engine and the overlay also
  carries `#pragma comment(lib, "ws2_32.lib")`, so no link-line change is needed;
  that pragma is a harmless no-op under GCC/Clang. The only build dependency to
  confirm on Linux is a threads library (`-lpthread` / `Threads::Threads`), which
  the engine already links.
- Anchors verified against **ZA_3.2.1** and upstream 3.3-alpha: every row applies to both, and the Linux build compiles every file they touch except `src/win32/i_system.cpp`, which only the Windows build compiles.
