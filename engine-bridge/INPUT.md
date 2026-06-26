# Input injection (menu driving + verification)

## Goal
Let the MCP server post input events so it can drive and verify menus — custom
MENUDEF menus and in-engine menus modified by KEYCONF/other lumps — and, later,
gameplay input and menu text entry.

## How input works (from the engine source)
- Inject via `D_PostEvent(const event_t*)` (`d_main.cpp:336`), called from the
  bridge poll (runs on the game thread in `D_DoomLoop`, same place
  `D_ProcessEvents` consumes events — safe).
- `event_t { BYTE type; BYTE subtype; SWORD data1; SWORD data2; SWORD data3; int x,y; }`.
- Menus read **GUI events**, not raw keys (`DMenu::Responder` `menu.cpp:123`):
  `type=EV_GUI_Event(4)`, `subtype=EV_GUI_KeyDown(1)`, `data1=GK_*`.
  `GK_UP=11 GK_DOWN=10 GK_LEFT=5 GK_RIGHT=6 GK_RETURN=13 GK_ESCAPE=27 GK_BACKSPACE=8`.
- Gameplay reads raw keys: `type=EV_KeyDown(1)/EV_KeyUp(2)`, `data1=` DirectInput
  scancode (`KEY_*` in `doomdef.h`).

## Design — one dumb primitive
The bridge gains a generic "post this event" capability. It fills an `event_t`
from the numbers it's handed and calls `D_PostEvent`. All meaning (which event
type/code, sequencing, timing) lives in the MCP server.

- Engine: a second overlay file `mcp_event.cpp` owns `MCP_PostInputEvent(type,
  subtype, data1, data2)` (it includes the doom headers; kept separate from the
  winsock code in `mcp_bridge.cpp` to avoid `windows.h` vs engine-header
  clashes). `mcp_bridge.cpp` queues inbound `event` messages and calls it from
  the poll. No new call-site hooks.
- Protocol: new inbound message `{v,t:"event",evtype,subtype,data1,data2}`. The
  `hello` advertises `caps:["cmd","event"]` so the client can detect support and
  degrade; old bridges simply ignore unknown messages (no version bump).

## MCP server
- `src/input/keys.ts`: engine constants + `menuKeyEvent(key)` mapping (pure).
- `transport.sendEvent(...)` (fire-and-forget) + `supports(cap)` from hello caps.
- Tools: `menu_key`, `menu_nav([...])` (small inter-key delay), `verify_menu`
  (open → nav → screenshot).

## Coverage
Pure + tested: `menuKeyEvent`, caps handling, `sendEvent`. The C++ addition stays
untested (consistent with the bridge), covered by a live smoke.

## Phases
1. Generic event primitive + `menu_key`/`menu_nav`/`verify_menu`. (this)
2. Menu text entry (`EV_GUI_Char`).
3. Gameplay input (held keys + timing).

## Risk to confirm live
Post `EV_GUI_Event/EV_GUI_KeyDown/GK_DOWN` and screenshot to confirm the menu
cursor actually moves (vs. needing a matching KeyUp/modifier). Quick probe once
the primitive exists; if menus want more, it's an MCP-side mapping tweak.
