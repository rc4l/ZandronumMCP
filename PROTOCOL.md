# Bridge protocol (v1)

The single source of truth for the wire contract between the **engine bridge**
(`engine-bridge/overlay/mcp_bridge.cpp`) and the **MCP server** (`src/`).

- **Transport:** loopback TCP, `127.0.0.1` only. Instance _N_ listens on
  `<PREFIX>_BRIDGE_PORT + (N - 1)`, where `<PREFIX>` is the engine's env prefix
  (`ZANDRONUM`).
- **Framing:** newline-delimited JSON (NDJSON). One JSON object per line.
- **Versioning:** every message carries `"v"`. The client checks the `hello`
  version and refuses to proceed on mismatch. Bump `v` ONLY when this contract
  changes (independent of npm semver and of the engine tag).

## Messages

### engine → MCP

`hello` — sent once, immediately on connect. `caps` lists what the bridge
supports so the client can degrade gracefully:
```json
{"v":1,"t":"hello","engine":"<id>","bridge":"<version>","pid":12345,"caps":["cmd","event","time","status"]}
```

`engine` is the engine adapter's `id` (`zandronum`); `bridge` is that
overlay's own version (e.g. `0.5.0`). `pid` is the engine process ID.
The bridge serves one client at a time: a second connection waits unanswered in
the listen backlog until the first closes.

`caps` values: `cmd` (console commands), `event` (input events), `time` (the
`setpause` control below), `status` (the `mcp_status` CCMD used for the
engine-state note described under Correlation).

`out` — one line of console output, streamed asynchronously:
```json
{"v":1,"t":"out","level":0,"text":"Unknown actor 'DoomImp'"}
```

### MCP → engine

`cmd` — a console command to execute:
```json
{"v":1,"t":"cmd","text":"summon DoomImp ; echo __MCPDONE_a1__"}
```

`event` — a raw input event posted via `D_PostEvent` (requires the `event` cap).
Fire-and-forget; the engine sends no reply. Menus read GUI key events
(`evtype=4` EV_GUI_Event, `subtype=1` EV_GUI_KeyDown, `data1=GK_*`):
```json
{"v":1,"t":"event","evtype":4,"subtype":1,"data1":10,"data2":0}
```

`setpause` — set the engine's master pause flag directly (requires the `time`
cap). Fire-and-forget; no reply. `paused` is `1` to pause, `0` to resume.
A single-player game can force-pause on window defocus, so the MCP drives the
flag itself to keep a backgrounded instance ticking:
```json
{"v":1,"t":"setpause","paused":0}
```

## Correlation

The bridge is intentionally dumb — it does not match output to commands. The MCP
server appends `; echo <sentinel>` to each command, then collects every `out`
line until it sees the sentinel echoed back. Because console output is a single
shared stream, **commands must be issued serially per instance.**

The bridge's only job: feed `text` to `AddCommandString`, and mirror every
printed line back as an `out` message. Everything else is the server's problem
(which is exactly why almost all of the code — and the tests — live in TS).

On a bridge advertising the `status` cap, the client uses `mcp_status <sentinel>`
as the correlator instead of `echo <sentinel>` — the same sentinel value, but the
CCMD echoes it back as the leading token of a single line also carrying the
engine's state (`<sentinel> paused=0 menu=off console=up gamestate=level
player=alive spectating=0 demo=0 automap=0 chat=0 demorec=0 pending=0 maptime=35
acstemp=0 health=100 armor=0 cheats=0`, with `health`/`armor`/`cheats`/`menuclass`
present only when there's a live player actor / an open menu). `pending` comes before `maptime`, and an overlay
may also send the optional `pauseext` after it. The host acts on `pending` and
`pauseext` only when present, so a line without them reads as no pending load and no
focus-loss pause.

| Field | Values | Meaning |
|---|---|---|
| `paused` | `0`, nonzero | the engine's `paused` flag. Zandronum's single-player focus-loss pause sets it (`paused=-1`), which `set_pause false` clears |
| `menu` | `off`, `on`, `waitkey`, `onnopause` | menu state |
| `console` | `up`, `down`, `falling`, `rising` | console state |
| `gamestate` | `level`, `intermission`, `finale`, `demoscreen`, `fullconsole`, `hideconsole`, `startup`, `titlelevel` | game state. Anything but `level` is a "not in a level" blocker |
| `player` | `alive`, `dead`, `none` | console player's actor (`none`: no actor) |
| `spectating` | `0`, `1` | console player is spectating |
| `demo` / `demorec` | `0`, `1` | playing back / recording a demo |
| `automap` / `chat` | `0`, `1` | automap open / chat input open |
| `pending` | `0`, `1` | A map, savegame or demo load (`map`, `load`, `playdemo`) is queued for the next tic, so the other fields still describe the state before it. Other queued actions (screenshot, automap toggle, autosave, quicksave, level exit) don't count |
| `maptime` | integer | tics run on the current map; `ensure_live`/`step_until` watch it move |
| `pauseext` | `0`, `1` | Optional, from an overlay whose engine has a separate focus-loss pause: while set no tic runs, so queued CCMDs and a pending load wait; `mcp_unblock` clears it |
| `acstemp` | integer | `run_acs` snippet modules loaded in this level; `save_game` refuses while nonzero |
| `health` / `armor` | integers | console player's health and armor amount |
| `cheats` | integer | console player's `cheats` bits (`CF_GODMODE`, `CF_NOTARGET`, ...), read by `set_cheat` |
| `menuclass` | class name | the open menu's class |

That line is excluded from command output
exactly like the plain echo sentinel is, and the client caches its fields as
`lastStatus`. **Without the `status` cap the client always falls back to the
plain `echo` form** — on an
older bridge the sentinel would never come back from `mcp_status`, hanging every
command to its timeout instead of degrading.

The client can also send a bare `mcp_status <sentinel>` with no preceding
command, to refresh `lastStatus` between commands (e.g. after an input-only
tool call that ran no console command). That line is self-correlating and needs
no host command riding alongside it. A probe the engine was too busy to answer
in time (e.g. mid map load) is abandoned; when its line arrives later, inside
another command's output, the client drops it (a line that *starts* with a
sentinel other than the current one). The load tools (`load_map`, `load_game`,
`play_demo`) send such probes until `pending=0`, except while `pauseext=1`,
when no tic would run the load. An engine that sends no `pending` field never
makes them wait.

A live tool's reply ends with an `Engine state: ...` note built from
`lastStatus` only when that note differs from the one the same client's last
reply was built from, so a missing note means unchanged, not normal. A return
to normal is said once (`Engine state: back to normal.`), an error reply always
carries the current note, and a new client (a launch, a re-attach) starts
with nothing remembered. A reply with `structuredContent` carries the same text
there as `engineState`, since some MCP clients show the model only the
structured half; the key is absent whenever the text note is. For the same
reason a structured reply's caveat lines go into a `notes` array, absent when
there are none.

The bridge keeps these correlator lines (anything starting with `__MCPDONE_`)
out of the on-screen notify area; the console, logfile and `out` tee still get
them.

## Console commands

The overlay CCMDs the host sends through `cmd`, and the stock ones whose output
it parses. `test/conformance.test.ts` parses one real reply per command
(`test/fixtures/zandronum/*.txt`, recorded per `test/fixtures/conformance/README.md`)
and fails when a reply stops parsing as the contract says.

General rules:

- A reply is whole lines. Most multi-line replies start with a header line
  (`MCP_ACTOR`, `MCP_FOUND`, ...), and the host treats an absent header as "the
  CCMD never ran". `MCP_RUNACS` is the exception: a result line printed last.
- Most failures are one `error <message>` line (after the header, if the
  command has one). The message text is free-form and may differ per engine; the
  host only tests for the `error ` prefix. The ACS variable commands are the
  exception, with the failure forms listed in their rows.
- `key=value` lines are space-separated, and `name=`, when present, comes last
  and takes the rest of the line. Coordinates and angles print with one decimal,
  `vel=` with two, `msg` positions with three.
- Optional `key=value` arguments may come in any order, except where a row says
  otherwise.

### Actors and players

| CCMD | Arguments | Reply |
|---|---|---|
| `dumpactor` | `[<tid> [<index>]]` (none: the console player) | `MCP_ACTOR`, then `actor none`, or `class <name>`, `health <n>`, `pos <x> <y> <z>`, `angle <deg>`, `pitch <deg>`, `[state <sprite> <frame> <tics>]` (when the state has a sprite); for a player also `[weapon <class>]` (with a ready weapon) and `morphtics <n>`; then one `item <class> <amount> <max>` per inventory item |
| `actorsnear` | `[<radius>]` (default 512, a box around the player) | `MCP_ACTORS`, then one `near <class> <health> <x> <y> <sprite>` per actor |
| `findactors` | `[class=<name>] [tid=<n>] [radius=<n>] [limit=<n>] [detail=1]`; `limit` defaults to 200, `0` means none | `MCP_FOUND`, then one `found class= tid= hp= spawnhp= x= y= z= angle= pitch= [dist=] [index=] sprite= frame= flags= [target=]` line per actor; `dist=` and nearest-first order only with a console player actor; `index=` (the actor's place among the TID's matches) on a `tid=` search; `detail=1` adds `[master=] [tracer=] special= args= vel= radius= height= floorz= [player=]`; then `truncated shown=<n> total=<n>` past `limit` |
| `mcp_spawnat` | `<class> <x> <y> [z=] [angle=] [tid=<n>\|auto] [kind=friend\|foe] [force=1] [health=] [special=] [args=a,b,c,d,e] [ambush=1] [dormant=1]` | `spawned class= tid= hp= spawnhp= x= y= z= angle= pitch= flags= [requested=] [special= args=] [forced=1]`, or `error ...` (e.g. `blocked by line <n>`) |
| `mcp_setview` | `<deg> [<pitch>]`, `tid=<n>` or `class=<name>` | `view angle= pitch= [tid= class=]` |
| `dumpplayers` | none | `MCP_PLAYERS`, then one `player slot= bot= state= hp= armor= [weapon=] x= y= z= angle= pitch= tid= cheats= frags= kills= items= secrets= [team=] ... name=` per in-game player; `team=` when the player is on a team; `...` is Zandronum's multiplayer fields `spec=`, `deadspec=`, `deaths=`, `points=`, `wins=` and `ping=`, each where the reply puts it; `state=` is `live`, `dead`, `reborn` or `enter` |
| `currentpos` (stock) | none | `Current player position: (<x>,<y>,<z>), angle: <deg>, floorheight: <h>, sector:<n>, lightlevel: <n>` |
| `linetarget` (stock) | none | `Target=<class>, Health=<n>, Spawnhealth=<n>` |
| `dumpactors` (stock) | none | a count line, a tab-separated `Actor Ed Num SpawnID Filter Source` header, then one tab-separated row per class, blank lines between (golden capture: `test/fixtures/zandronum/dumpactors.golden.txt`) |

`flags=` is a letter set: `m` monster, `f` friendly, `c` corpse, `d` dormant, `s`
shootable, `o` solid, `i` invulnerable, `a` ambush; `-` for none.

Notes:

- `mcp_spawnat` has no void check: a requested point in the void is judged by the fit test like
  any other. `<x>`, `<y>` and a given `z=` must lie within -32768..32767, else
  `error coordinates must be within -32768..32767`, `force=1` or not: fixed point would wrap the
  spot to another part of the map.

### ACS

| CCMD | Arguments | Reply |
|---|---|---|
| `dumpmodules` | none | `MCP_MODULES`, then `module <id> <name>` per loaded module |
| `dumpscripts` | none | `MCP_SCRIPTS`, then `script <module> <number> <name\|-> <type> <argc>` |
| `dumpfunctions` | none | `MCP_FUNCTIONS`, then `function <module> <index> <name>` |
| `getmapvar` / `setmapvar` | `<name>` / `<name> <value>` | `mapvar <name> = <n>`, or `mapvar <name> not found` (exported names only), or `usage: ...` |
| `getmaparray` / `setmaparray` | `<name> <index>` / `<name> <index> <value>` | `maparray <name>[<index>] = <n>`, or `maparray <name> not found`, or `usage: ...` |
| `getacsvar` / `setacsvar` | `<world\|global> <index>` / `... <value>` | `acsvar <scope> <index> = <n>`, or `index out of range (0-<max>)`, `unknown scope '<s>' (use world\|global)` or `usage: ...` |
| `dumpacsvars` | none | `MCP_ACSVARS`, then an `acsvar` line per nonzero variable |
| `mcp_runacs` | `<path> [<script>] [<args>...] [open=1]` (up to 4 args; `open=1` may sit anywhere after `<path>`). A `<script>` that parses as a number is a script number, anything else a name | anything the script printed before its first delay, then `MCP_RUNACS module=<n> scripts=<n> started=<script\|none> deferred=<0\|1>`; or `error ...` with no `MCP_RUNACS` line. A refused snippet stays loaded (`acstemp=` counts it) until the map changes: Zandronum can't unload a module |
| `scriptstat` (stock) | none | `script <number>: <state>` or `script "<name>": <state>` per running script, or `No scripts are running.` |
| `acsprofile` (stock) | `[<sort> [<limit>]]`, or `clear` | a scripts section and a functions section, each a `Top <n> ...:` line, a column header and fixed-width rows ending in five numbers (total, runs, avg, min, max); a named script prints quoted |

### Screen and session

| CCMD | Arguments | Reply |
|---|---|---|
| `dumphud` | none | `MCP_HUD`, then the last frame's `text <x> <y> <text>`, `image <x> <y> <patch>` and `msg <layer> <left> <top> <tics> <text>` lines. A status bar that draws glyph by glyph adds no `text` lines (its glyphs are filtered as font characters); console notify lines appear as `text` while shown. `image` names are cut to 8 characters |
| `dumprenderer` | none | `MCP_RENDERER`, then `key=value` lines: `renderer`, screen and view rect, `statusbar_y`, and render cvars, `gl_vendor`, `gl_shadermodel`, `gl_maxtexsize` (OpenGL only), `vid_renderer` and `fullscreen` among them; `renderer` is `opengl` or `software`, and `st_scale`, `hud_scale` are bools |
| `mcp_unblock` | none | `unblock ok`. Closes the console, chat and automap |
