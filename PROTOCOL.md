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
{"v":1,"t":"hello","engine":"<id>","bridge":"<version>","pid":12345,"caps":["cmd","event","time","status","input","runscript","spawnfind","runacsname","mapslot"]}
```

`engine` is the engine adapter's `id` (`zandronum`); `bridge` is that
overlay's own version (e.g. `0.7.0`). `pid` is the engine process ID.
The bridge serves one client at a time: a second connection waits unanswered in
the listen backlog until the first closes.

`caps` values: `cmd` (console commands), `event` (input events), `time` (the
`setpause` control below), `status` (the `mcp_status` CCMD used for the
engine-state note described under Correlation), `input` (the `mcp_input` CCMD
under Scripted input, which `input_timeline` needs), `runscript` (the
`mcp_runscript` CCMD under ACS; without it `run_script` queues the script with
`puke`/`pukename` and has no result to return), `spawnfind` (`mcp_spawnat`
takes `find=`; a bridge without it ignores the key, so `summon_at` refuses
`findSpot` there instead of sending it), `runacsname` (`mcp_runacs` takes
`name=1`; without it `run_acs` sends a string script bare and refuses a name
made of digits, which an older overlay would run as a number), `mapslot` (the
`mcp_mapslot` CCMD under ACS; without it the map-var tools refuse `sourceFile`).

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
| `maptime` | integer | tics run on the current map; `ensure_live`/`step_until`/`move_to` watch it move |
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
carries the current note, and a new client (a relaunch, a re-attach) starts
with nothing remembered. A reply with `structuredContent` carries the same text
there as `engineState`, since some MCP clients show the model only the
structured half; the key is absent whenever the text note is. For the same
reason a structured reply's caveat lines (role notes, a missing log, a partial
join) go into a `notes` array, absent when there are none, and an error reply
with `structuredContent` carries its text there as `error`.

Lines printed while the bridge dispatches a command stay out of the on-screen
notify area. The console, logfile and `out` tee still receive
them, and hand-typed commands still show. Synchronous game-code output, including
a script's `Log()` from `mcp_runscript`, `mcp_runacs` or the marker script, suspends
this filter, so it shows just like later-tic game output. Bridge startup pins
`screenshot_quiet 1` to keep deferred `Captured ...` replies out too.

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
| `dumpactor` | `[<tid> [<index>]]` (none: the console player) | `MCP_ACTOR`, then `actor none`, or `class <name>`, `health <n>`, `pos <x> <y> <z>`, `angle <deg>`, `pitch <deg>`, `[state <sprite> <frame> <tics>]` (when the state has a sprite), then `[stateid <Owner>.<index> [<label>]]` when a class owns the state (`label` is the nearest own label at or before it, children dotted as `Death.Fire`, `+<n>` past it: `See+2`); for a player also `[weapon <class>]` (with a ready weapon), `morphtics <n>`, `input` and `modinput buttons= oldbuttons= forward= side= up= yaw= pitch= roll=` (raw `original_cmd`/`original_oldbuttons`, and after mods `cmd`/`oldbuttons`; buttons are decimal BT_ bit sets), `weaponinfo refire= flags= [pending=<class>\|none]` (flags: decimal WF_ bits; no `pending=` when no change is pending), then one `psprite layer= sprite= frame= tics= x= y= [id=] [label=]` per active layer, numbered as GZDoom's (`1` weapon, `1000` flash, `-1` Strife hands, `2147483645`+ the targeter; Zandronum's fixed slots map onto these); then one `item <class> <amount> <max>` per inventory item |
| `actorsnear` | `[<radius>]` (default 512, a box around the player) | `MCP_ACTORS`, then one `near <class> <health> <x> <y> <sprite>` per actor |
| `findactors` | `[class=<name>] [tid=<n>] [radius=<n>] [limit=<n>] [detail=1]`; `limit` defaults to 200, `0` means none | `MCP_FOUND`, then one `found class= tid= hp= spawnhp= x= y= z= angle= pitch= [dist=] [index=] sprite= frame= flags= [target=]` line per actor; `dist=` and nearest-first order only with a console player actor (never on a `-host` server, whose slot 0 is a client's); `index=` (the actor's place among the TID's matches) on a `tid=` search; `detail=1` adds `[master=] [tracer=] special= args= vel= radius= height= floorz= [player=]`; then `truncated shown=<n> total=<n>` past `limit` |
| `mcp_spawnat` | `<class> <x> <y> [z=] [angle=] [tid=<n>\|auto] [kind=friend\|foe] [force=1] [find=<radius>] [health=] [special=] [args=a,b,c,d,e] [ambush=1] [dormant=1]` | `spawned class= tid= hp= spawnhp= x= y= z= angle= pitch= flags= [requested=] [special= args=] [forced=1] [moved=<dist>]`, or `error ...` (e.g. `blocked by line <n>`). `find=` (above 0, up to 256, else `error find wants a radius above 0, up to 256`; ignored with `force=1`) only matters when the spot is blocked: the blocked actor is then removed (it only probes the candidates, though anything its own `BeginPlay` created stays at the requested spot) and a fresh one of its class is spawned at the nearest spot in that radius that passes the same fit test and has no wall on the straight path from the requested point (a one-sided or blocking line, or an opening lower than the actor, measured with the actor at the requested point), and the reply adds `moved=`. Candidates lie on rings one step apart (the actor's radius, at least 8), nearest ring first, each walked counter-clockwise from east; without `z=` the actor is put on the new spot's floor. `error no free spot within <radius>: <the requested spot's reason>` when none is free. Dynamic lights, missiles and MBF bouncers are never moved: they get the plain `error <reason>`. Every fit test runs with `NOTRIGGER` set, so it presses no push or impact line; a `TOUCHY` actor it overlaps still dies, a `BUMPSPECIAL` one's special can still fire, and a missile still damages what it overlaps at the requested spot. `find=` needs the `spawnfind` cap |
| `mcp_setprop` | `<tid> <index> <prop> [value...] [force=1]`, `force=1` last (tid 0: the console player); `<prop>` is a property name or `flag:<NAME>` | `setprop prop=<as given> [old=] [new=] class= tid= hp= spawnhp= x= y= z= angle= pitch= flags= [died=1] [removed=1] [noop=1] name=<tag>` (`GetTag()`: the class name for a stock actor); the read form (no value) has no `new=`, and `nametag` has neither `old=` nor `new=` (`name=` shows it) |
| `mcp_place` | `<tid> <index> [x=] [y=] [z=] [angle=] [pitch=] [vx=] [vy=] [vz=] [addvel=1] [fog=1] [force=1]`, at least one of the eight fields; numbers parse strictly, coordinates and velocities within -32767..32767 (`error coordinates must be within -32767..32767`, `error velocity must be ...`), pitch within -90..90 | `placed class= tid= hp= spawnhp= x= y= z= angle= pitch= fromx= fromy= fromz= vx= vy= vz= flags= [fog=1] [forced=1] name=<tag>`. Position first: a missing `x`/`y` keeps the current one; without `z`, a given `x` or `y` puts the actor on the sector floor there, else `z` stays. The move is `P_MoveThing` under `mcp_spawnat`'s fit flags (`PASSMOBJ`, `NOTRIGGER`); refused, it prints `mcp_spawnat`'s `error <reason>` and nothing at all is applied. `force=1` skips the test; `fog=1` spawns teleport fog at both spots. Then angle and pitch (degrees, no view interpolation), then velocity (units per tic: set, a missing axis keeping its current value, or added with `addvel=1`). `fog=`/`forced=` only with a position |
| `mcp_remove` | `<tid> <index> [all=1]`, tid 1 or more; `all=1` with index 0 | one `removed class= tid= hp= spawnhp= x= y= z= angle= pitch= [hidden=1]` per removed actor, read before the removal, then `removed_total count=<n> [skipped=<ref>,...]`. `P_RemoveThing`: out of the kill/item totals, no death. A live player body stays and is listed in `skipped=` as `player<n>`; an owned inventory item carrying the tid is removed like any actor (`P_RemoveThing` has no owner check). `error no actor with tid <n>` when `all=1` finds none |
| `mcp_damage` | `<tid> <index> <amount> [type=<name>] [source=<tid>]`, amount 1..1000000; `source=0` is the console player's body | `damaged class= tid= hp= spawnhp= x= y= z= angle= pitch= oldhp= dealt= type=<name> [source=<ref>] [nodamage=1] [died=1] [removed=1] flags= name=<tag>`: `P_DamageMobj` with no inflictor, `hp=` after it, `dealt=` `oldhp` minus `hp`, `nodamage=1` when that is 0 or less. `error already dead`, `error no source actor with tid <n>`, `error server: pass a source tid` |
| `mcp_inv` | `<tid> <index> <give\|take> <class> [<amount>]`, amount 1 or more (default 1); `Armor` names `BasicArmorPickup` to give and `BasicArmor` to take, as ACS does | `inv op=<give\|take> item=<class> held=<class\|health> before= after= [ok=0] class= tid= hp= spawnhp= x= y= z= angle= pitch= flags= name=<tag>`. ACS `GiveInventory`/`TakeInventory` on one actor; `held=` is, for a give, where the amount is kept (armor: `BasicArmor`; an ammo pickup: its parent ammo; a `Health` item: `health`, the actor's own; else the item), and for a take the item class itself, the only class `TakeInventory` looks up (so taking `ClipBox` takes nothing from `Clip`), read before and after. `ok=0` when a give's pickup was refused. `error not an inventory class <name>`; on a server `error not replicated: ...` for a non-player |
| `mcp_setview` | `<deg> [<pitch>]`, `tid=<n>` or `class=<name>` | `view angle= pitch= [tid= class=]` |
| `dumpplayers` | none | `MCP_PLAYERS`, then one `player slot= bot= host= state= hp= armor= [weapon=] x= y= z= angle= pitch= tid= cheats= frags= kills= items= secrets= [team=] ... name=` per in-game player; `team=` when the player is on a team; `host=1` marks the console player, offline only (a server owns no player slot); `...` is Zandronum's multiplayer fields `spec=`, `deadspec=`, `deaths=`, `points=`, `wins=` and `ping=`, each where the reply puts it; `state=` is `live`, `dead`, `reborn` or `enter` |
| `currentpos` (stock) | none | `Current player position: (<x>,<y>,<z>), angle: <deg>, floorheight: <h>, sector:<n>, lightlevel: <n>` |
| `linetarget` (stock) | none | `Target=<class>, Health=<n>, Spawnhealth=<n>` |
| `dumpactors` (stock) | none | a count line, a tab-separated `Actor Ed Num SpawnID Filter Source` header, then one tab-separated row per class, blank lines between (golden capture: `test/fixtures/zandronum/dumpactors.golden.txt`) |

`flags=` is a letter set: `m` monster, `f` friendly, `c` corpse, `d` dormant, `s`
shootable, `o` solid, `i` invulnerable, `a` ambush; `-` for none.

`mcp_setprop`, `mcp_place`, `mcp_remove`, `mcp_damage` and `mcp_inv` take their target as
`<tid> <index>` (the index-th actor sharing the TID; tid 0, with index 0 only, is the console
player's body), write directly, so they work while paused, and share their refusals:
`error client: <verb> on the server instance`, `error not in a level`, `error server: pass a tid`
(tid 0 on a server), `error no actor with tid <n> index <n>` and `error spectator`.

Notes:

- `dumpactor`: `psprite` layers are only `1`, `1000` and the targeter's (fixed slots), and
  `weaponinfo flags=` go up to `WF_REFIRESWITCHOK`.
- `mcp_spawnat` and `mcp_place` have no void check: a requested point in the void is judged by
  the fit test like any other, and a `find=` candidate by the path and fit tests alone.
  `mcp_spawnat`'s `<x>` and `<y>` must lie within -32767..32767, else
  `error coordinates must be within -32767..32767` (`mcp_place`'s refusal), `force=1` or not:
  fixed point would wrap the spot to another part of the map. For both, the actor's z (a given
  `z=`, or `mcp_place`'s floor default) must lie within -32767 up to 32767 minus its height, else
  `error z must be within -32767..<top> for height <h>`, `force=1` or not: fixed point would wrap
  its top, and the fit test would pass.
- `mcp_setprop` refuses `friction`, `damagemultiply`, `friendlyseeblocks` (`unsupported prop`)
  and a player pawn's `height`.
- In a map-reset game mode (`GMF_MAPRESETS`) a removed map-placed actor is hidden and keeps its
  tid, and `mcp_remove`'s row for it carries `hidden=1`. Every lookup then skips it, as
  Zandronum's ACS does (a `<tid> <index>` target, `all=1`, `findactors`, `dumpactor`,
  `actorsnear`, `mcp_setview` and a `tid:`/`class:` ref), so it reads as gone.
- `mcp_place`, `mcp_remove`, `mcp_damage` and `mcp_inv` run on a server (a client refuses with
  `client:`), where a client's body takes back its own angle and pitch from its next move;
  there `mcp_inv` refuses a non-player (`not replicated`).

### ACS

| CCMD | Arguments | Reply |
|---|---|---|
| `dumpmodules` | none | `MCP_MODULES`, then `module <id> <name>` per loaded module |
| `dumpscripts` | none | `MCP_SCRIPTS`, then `script <module> <number> <name\|-> <type> <argc>` |
| `dumpfunctions` | none | `MCP_FUNCTIONS`, then `function <module> <index> <name>` |
| `getmapvar` / `setmapvar` | `<name>` / `<name> <value>` | `mapvar <name> = <n>`, or `mapvar <name> not found` (exported names only), or `usage: ...` |
| `getmaparray` / `setmaparray` | `<name> <index>` / `<name> <index> <value>` | `maparray <name>[<index>] = <n>`, or `maparray <name> not found`, or `usage: ...` |
| `mcp_mapslot` | `<slot> v=1 code=<len> first=<fourcc> md5=<32 hex> [index=<k>] [set=<value>]`. The module is the one loaded module whose image digest is `code`/`first`/`md5`: its chunks start at offset `len` with a `first` chunk (`STRL` for a file's `STRE`, which the loader renames), and `md5` is the MD5 of its first `len` bytes (header and code), then every `ARAY`, `AIMP`, `MIMP`, `MEXP`, `MINI`, `AINI` and `LOAD` chunk, id by id in that order, each id's chunks in file order, 8-byte header included. Without `index=` the slot is a scalar; with it, element `k` of the array whose number the slot holds, as `PCD_PUSHMAPARRAY` reads it. `set=` writes, then reads back. `v=` is the digest scheme: a change to it or to the arguments bumps it | `MCP_MAPSLOT module=<i> slot=<s> [index=<k>] value=<n> name=<module name>` (`module` numbered as `dumpmodules` numbers them); or `error not in a level`, `error usage: ...`, `error unsupported v=<n>`, `error slot out of range` (outside 0-127), `error no module matches map=<map> modules=<count>`, `error ambiguous modules=<i>,<j>` |
| `getacsvar` / `setacsvar` | `<world\|global> <index>` / `... <value>` | `acsvar <scope> <index> = <n>`, or `index out of range (0-<max>)`, `unknown scope '<s>' (use world\|global)` or `usage: ...` |
| `dumpacsvars` | none | `MCP_ACSVARS`, then an `acsvar` line per nonzero variable |
| `mcp_runacs` | `<path> [<script>] [<args>...] [name=1] [open=1]` (up to 4 args; the flags may sit anywhere after `<path>`). `name=1` marks `<script>` a name, so a name made of digits stays a name; without it a token that parses as a number is a script number and anything else a name. The host sends `name=1` for every string when the bridge has the `runacsname` cap | anything the script printed before its first delay, then `MCP_RUNACS module=<n> scripts=<n> started=<script\|none> deferred=<0\|1>`; or `error ...` with no `MCP_RUNACS` line. A refused snippet stays loaded (`acstemp=` counts it) until the map changes: Zandronum can't unload a module |
| `mcp_runscript` | `<script> [always=1] [name=1] [<args>...]` (the two flags directly after `<script>`, in either order; up to 4 args). `<script>` is a script number written as plain digits, above 0, unless `name=1` marks it a name, so a name made of digits stays a name; the host sends `name=1` for every string | anything the script printed before its first delay, then `MCP_RUNSCRIPT script=<script> started=<0\|1> result=<n> finished=<0\|1> module=<n>`; or `error ...` (`netgame`, `not in a level`, `script wants a number above 0, or name=1 with a name`, `no script <script>`, `at most 4 script args`) with no `MCP_RUNSCRIPT` line. `module` is the first loaded module that has the script (the one that runs), numbered as `dumpmodules` and `MCP_RUNACS module=` are. The script runs inside the command, as `ACS_ExecuteWithResult` runs one. `started=0`: a copy is already running and `always=1` was not given (`result=0 finished=0`). A suspended copy is resumed instead, keeping its own args, and reports `started=1`, as `ACS_Execute` resumes one. `result` is the `SetResultValue` so far, 1 when unset; `finished=0` means the script paused at a delay. Offline only |
| `scriptstat` (stock) | none | `script <number>: <state>` or `script "<name>": <state>` per running script, or `No scripts are running.` |
| `acsprofile` (stock) | `[<sort> [<limit>]]`, or `clear`. The host always sends `total 0` and sorts and limits the rows itself | a scripts section and a functions section, each a `Top <n> ...:` line (`All ...:` when the limit is `<= 0`, which lists every row that ran), a column header and fixed-width rows ending in five numbers (total, runs, avg, min, max). The module column is 12 characters wide (module names are at most 8, so never cut) and the name column is cut at 20, so a named script (printed quoted) over 18 characters loses its closing quote and tail; never-run rows are skipped but still count against a limit above 0 |

**Map vars by source.** A map var the module doesn't export (a library's `internal` vars, or any var of a map's own
BEHAVIOR) is found by a probe compile. Build A is the mod's main source as is; build B is the
same source with `function raw __mcp_p_0(void) { return <expr>; }` appended. Both compile a
copy of the main file under its own name in one temp dir, with the source's folder as the first
include dir. Checks, in order: A must byte-match a deployed module; B must add no compiler
diagnostic; B must leave A's layout alone (every chunk but FUNC/FNAM byte-identical and in the
same order, the code identical up to the first probe bar at most 3 padding bytes, the directory
offset excepted); then each probe body is decoded and import- and bounds-checked.

It fails closed because a wrong slot never fails on its own: `GetArrayVal` reads 0, and a wrong
scalar is just another var. The chunks pin initialised and array slots, but only the code pins
a hidden zero scalar's slot.

### Screen and session

| CCMD | Arguments | Reply |
|---|---|---|
| `dumphud` | none | `MCP_HUD`, then the last frame's `text <x> <y> <text>`, `image <x> <y> <patch>` and `msg <layer> <left> <top> <tics> <text>` lines. A status bar that draws glyph by glyph adds no `text` lines (its glyphs are filtered as font characters); console notify lines appear as `text` while shown. `image` names are cut to 8 characters |
| `dumprenderer` | none | `MCP_RENDERER`, then `key=value` lines: `renderer`, screen and view rect, `statusbar_y`, and render cvars, `gl_vendor`, `gl_shadermodel`, `gl_maxtexsize` (OpenGL only), `vid_renderer` and `fullscreen` among them; `renderer` is `opengl` or `software`, and `st_scale`, `hud_scale` are bools |
| `mcp_unblock` | none | `unblock ok`. Closes the console, chat and automap |
| `mcp_mark` | `[<note>...]` (a playtest marker, meant for a key bind) | one `MCP_MARK n= tic= maptime= map= [x= y= z= angle=] [round=] [wave=] shot=<name\|none> note=<rest of line>` line. `note=` takes the rest of the line, as `name=` does elsewhere. `n` counts marks in this process; `tic` is `gametic` (runs while paused), `maptime` freezes while paused; the position is the console player's body, left out without one, as always on a `-host` server (its console player slot 0 is a client's). `round=` is the result of the ACS script the `mcp_mark_round` cvar names (number, else a script name; archived), run synchronously like `ACS_ExecuteWithResult`, so it must not delay; `round=none` when no such script is loaded, no `round=` with the cvar empty, outside a level or on a client. `wave=` is the invasion wave, only with invasion on. `shot=` names the screenshot it queues, `mcp_mark_<bridge port>_<YYYYMMDD-HHMMSS>_<n>`, written as `<name>.png` to the engine's working dir and kept; `none` when another game action is pending, and always on a `-host` server, which has no screen. The line reaches the gamelog, the bridge log and, mid-command, that command's reply. The shot is taken a tic later (`ga_screenshot`, serviced while paused too) |

### Map probes

Live geometry questions. A `<ref>` is one token: `tid:<n>[:<index>]` (the index-th actor
sharing the TID), `player:<n>`, `class:<name>` (the nearest one to the console player, owned
items skipped; on a `-host` server, which has no player of its own, the first one found) or `pt:<x>,<y>[,<z>]` (a map point; without `z`, the floor there). Every map coordinate (a
point, `z=`, `from=`) must lie within -32767..32767, what a fixed-point coordinate holds, else
`error coordinates must be within -32767..32767`. A collision
test runs on a throwaway probe actor (a `MapSpot`, never replaced) with the mover's radius,
height, step and dropoff limits and collision flags. It is blocked by solid actors without
being solid itself, triggers no line or bump special, picks nothing up, pushes nothing, is not
in the blockmap, and is destroyed before the reply. The mover itself and every `BUMPSPECIAL`
actor in the probed area have those flags lowered for the call and put back. A probe moves like
a monster of the mover's size: a player's step-up onto low actors is not modeled. Probes, and so
a fit, a trace and a `pt:` sight end, are refused on a netgame client (`error client: ...`) and
during demo playback or recording (`error demo: ...`). Block reasons: `actor` (`blocker=` as
`player<n>` or `<class>#<tid>`), `line` (`line=`, a one-sided or blocking line), `ceiling` (the
opening is lower than the probe), `slope` (a steep slope), plus `floor`, `step`, `dropoff` and
`outside` below.

| CCMD | Arguments | Reply |
|---|---|---|
| `mcp_pointinfo` | `<x> <y> [z=] [radius= height=] [mover=<ref>]`; `mover` must be an actor, and supplies any size not given | `MCP_POINT`, then `point sector= [inmap=0\|1] floorz= ceilingz= [floor3d=] [ceiling3d=] light= special= tag=`, `floortex name=<texture>`, `ceiltex name=<texture>`, and with a size `fit ok=1` or `fit ok=0 reason=<reason> [blocker=] [line=]`. `floorz`/`ceilingz` are the sector's own planes (ACS `GetSectorFloorZ`); `floor3d`/`ceiling3d` (only when they differ) and the textures are the surfaces around `z` (else the floor), solid 3D floors included, as `CheckActorFloorTexture` finds them. `inmap` needs closed GL subsectors and is left out without GL nodes. A fit tests the probe at `z` (else on the floor); with `z`, `reason=floor` when it is below the floor found and `reason=ceiling` when its top is above the ceiling. `error a fit needs radius and height above 0, or mover=`. `floortex`/`ceiltex` names are cut to 8 characters; whether there are GL nodes for `inmap` is up to the renderer and `am_textured` |
| `mcp_checksight` | `from=<ref> to=<ref> [flags=<n>]`; flags are `P_CheckSight`'s `SF_` bits, not ACS `CheckSight`'s own (`2` past shootable lines, `4` past block-everything lines, `8` ignore water boundaries; ACS's "see past block-everything" bit is `2\|4`) | `MCP_SIGHT`, then `sight visible=0\|1 from=<ref> to=<ref> [line=<n>]`. `from`/`to` name an actor as `blocker=` does and a point as the token given. Sight is `P_CheckSight` with invisibility ignored: from the eye at 3/4 of `from`'s height to any part of `to`. A point is a 1-unit-high probe at its z or the floor. `line=` (when not visible) is the first line a straight trace from that eye to `to`'s middle hits, a hint left out when that trace is clear |
| `mcp_tracemove` | `<x> <y> [from=<x>,<y>] [mover=<ref>] [radius=] [height=] [actors=0]`; the mover defaults to the console player (not a spectator; none on a `-host` server), and `from` to the mover's position | `MCP_TRACE`, then `trace ok=1 x= y= z= dist= total=`, or `trace ok=0 reason=<reason> x= y= z= dist= total= [line=] [blocker=] [rise=] [drop=]` with the probe's last good spot. The probe steps at most radius-1 units at a time, the start included, each step `P_CheckPosition` plus `P_TryMove`'s checks: `ceiling` (the ceiling is less than the height above its z), `step` (`rise=` above the step height), `dropoff` (`drop=` beyond the dropoff height, unless a player mover, which moves by momentum, or a `DROPOFF`/`FLOAT` one; always with `NODROPOFF`), `outside` (into the void, GL nodes only). `actors=0` ignores actors. No momentum, line specials, moving sectors or damaging floors. `error no mover: pass radius/height or mover=`, `error from= needed without a mover` |

### Scripted input

`mcp_input` holds one timeline: a list of segments, each one input held for N
tics. While it is armed the engine replaces the console player's input every
tic, inside the game ticker right after the tic's real input was copied in, for
exactly the tics scheduled, counting only tics that ran (`maptime` moved).
Offline only. Limits: 64 segments, 2100 tics in all.

| Form | Reply |
|------|-------|
| `clear` | `MCP_INPUT cleared`; `error armed...` while armed |
| `seg <tics> <buttons\|-> <fwd> <side> <up> <angle\|-> <turn> <pitch\|->` | `MCP_INPUT seg <n> total=<tics>`, or `error ...`, which marks the timeline bad until the next `clear`; `error armed...` while armed. `buttons` is a comma list of names (`attack`, `altattack`, `use`, `jump`, `crouch`, `reload`, `zoom`, `speed`, `strafe`, `turn180`, `user1`-`user4`); an unknown one fails with the known list. `fwd`/`side`/`up` are raw ticcmd units (run: 12800 / 10240; up: 768). `angle` is an absolute heading in degrees held for the segment, `turn` degrees per tic (exclusive with `angle`), `pitch` an absolute view pitch (negative looks up) |
| `go <0\|1>` | `MCP_INPUT armed segs=<n> tics=<t> maptime=<m>` and the game is unpaused; `1` pauses it again on every disarm. `error ...` when empty, bad, armed, on a server or a client (an offline game with bots runs), in demo playback, outside a level or with no player |
| `status` | `MCP_INPUT active=<0\|1> consumed=<n> total=<t> seg=<i> maptime=<m> reason=<done\|level_change\|stopped\|->`. A segment timeline whose last tic ran is `done` at the next read (`status`, `trail`, `stop`) or tic, so a pause right after it still reads done |
| `trail [<from>\|ends]` | `MCP_INPUT_TRAIL`, then `start maptime= seg=0 x= y= z= angle= pitch= momx= momy= momz= health= buttons=` (the player when armed; only from index 0) and one `tic ...` row with the same fields per consumed tic from index `from`: the player after that tic, `maptime` being the tic its input was applied in. `ends` prints only each segment's last row |
| `stop` | `MCP_INPUT stopped consumed=<n>` (reason `stopped`, or `done` when the last tic had already run), or `MCP_INPUT idle` when nothing is armed |

The engine writes `MCP_INPUT_SEG <n> maptime=<m>` when a segment's first tic is
applied and `MCP_INPUT_END reason=<r> consumed=<n> maptime=<m>` on every disarm.
Both go to the bridge logfile and the engine's own gamelog only (not the
console, the notify area or the socket), so the host can split the bridge log
per segment. While armed, the injected buttons also carry the direction bits a
held key would set (`BT_FORWARD`/`BT_BACK`, `BT_MOVERIGHT`/`BT_MOVELEFT`,
`BT_MOVEUP`/`BT_MOVEDOWN` from the axes' signs, `BT_LEFT`/`BT_RIGHT` from
`turn`), so ACS `GetPlayerInput` reads them as it would real keys.
