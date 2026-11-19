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
{"v":1,"t":"hello","engine":"<id>","bridge":"<version>","pid":12345,"caps":["cmd","event","time","status","input","runscript","spawnfind","runacsname","mapslot","rec","clock","walk","frametime","recvars","recplayer","rechost","demo"]}
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
`mcp_mapslot` CCMD under ACS; without it the map-var tools refuse `sourceFile`),
`rec` (the `mcp_rec` CCMD under Per-tic recorder, which `record` and
`record_read` need), `clock` (the `mcp_clock` CCMD under Frozen clock, which
`freeze_time` and `frame_sweep` need, and the `frozen` status field; without it
the host never treats time as frozen), `walk` (`mcp_input walk` entries and the
`go` limits under Scripted input, which `move_to`'s engine mode needs; without
it `move_to` steers from the host), `recvars` (`mcp_rec var` samples ACS variables),
`recplayer` (player input/weapon fields and opt-in psprite events), `rechost`
(passive authoritative server recording; clients still refused),
`frametime` (`mcp_clock frametime` holds
render-time sources per tic while frozen; `freeze_time frameTime: true` requires it),
`demo` (`mcp_clock freeze demo`, the frozen clock holding an offline demo, and
`mcp_checkpoint` under Frozen clock).

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
flag itself to keep a backgrounded instance ticking. While the clock is frozen
it sets the pause the thaw restores instead, so `paused` stays 0:
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
acstemp=0 frozen=0 health=100 armor=0 cheats=0`, with `health`/`armor`/`cheats`/`menuclass`
present only when there's a live player actor / an open menu, and `frozen` only
on a bridge with the `clock` cap). `pending` comes before `maptime`, and an overlay
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
| `frozen` | `0`, `1` | the `mcp_clock` frozen clock is held (Frozen clock below). A blocker in the engine-state note; tools that need tics to run by themselves refuse while it is `1`. the bridge's `setpause` leaves `paused` at 0 while frozen (it sets the value the thaw restores instead) |
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
| `mcp_unblock` | none | `unblock ok`. Closes the console, chat and automap, and thaws a frozen clock (as `mcp_clock thaw`, printing nothing more) |
| `mcp_mark` | `[<note>...]` (a playtest marker, meant for a key bind) | one `MCP_MARK n= tic= maptime= map= [x= y= z= angle=] [round=] [wave=] shot=<name\|none> note=<rest of line>` line. `note=` takes the rest of the line, as `name=` does elsewhere. `n` counts marks in this process; `tic` is `gametic` (runs while paused), `maptime` freezes while paused; the position is the console player's body, left out without one, as always on a `-host` server (its console player slot 0 is a client's). `round=` is the result of the ACS script the `mcp_mark_round` cvar names (number, else a script name; archived), run synchronously like `ACS_ExecuteWithResult`, so it must not delay; `round=none` when no such script is loaded, no `round=` with the cvar empty, outside a level or on a client. `wave=` is the invasion wave, only with invasion on. `shot=` names the screenshot it queues, `mcp_mark_<bridge port>_<YYYYMMDD-HHMMSS>_<n>`, written as `<name>.png` to the engine's working dir and kept; `none` when another game action is pending, and always on a `-host` server, which has no screen. The shot is taken a tic later (`ga_screenshot`, serviced while paused too). While the clock is frozen no tic runs to take it, so it is queued as an `mcp_clock` capture of the held frame instead (`none` when that refuses: outside a level, no display, a full queue). The line reaches the gamelog, the bridge log and, mid-command, that command's reply |

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

`mcp_input` holds one timeline: a list of entries. A segment holds one input
for N tics; a walk steers the player to a target every tic until it is there
(the law is `engine-bridge/overlay/mcp_steer.h`). While
it is armed the engine replaces the console player's input every tic, inside the
game ticker on the tic's net input before a recording demo writes it (so the
demo holds the injected input), counting only tics that ran (`maptime` moved).
The tic runs a copy: the net input is left as it was, so once the timeline
ends the next tic carries the player's own input, not the last injected one.
A playing demo's input is never replaced: an armed timeline disarms `demo` on
the first playback tic. Offline only. Limits: 64 entries, 2100 segment tics
in all, and the `go` tic limit (at most 2100).

A walk entry is judged only at a tic's start, from the player's position and
velocity then: an entry already satisfied completes without consuming a tic, and
the next one steers that same tic. A stop entry completes when the velocity is
exactly 0 and the aim point within 0.05 units (after 3 settle tics, within 0.5);
a `pass` entry once the aim point is within this tic's step; a moving target
(a `tid` actor that moved last tic) once the aim point is within 0.5 units and
the relative speed under 1. The aim point is the target pulled back toward the
player by `standoff`, measured between bounding boxes plus a 1-unit gap for a
solid actor. `tid:N` is the nearest actor with that TID other than the player,
re-resolved every tic; one that vanishes while its box overlaps the player's
(a pickup taken) completes the entry. `class:Name` is the nearest of that class
(subclasses too) when the entry starts, aimed at its position then and not followed.

| Form | Reply |
|------|-------|
| `clear` | `MCP_INPUT cleared`; `error armed...` while armed |
| `seg <tics> <buttons\|-> <fwd> <side> <up> <angle\|-> <turn> <pitch\|->` | `MCP_INPUT seg <n> total=<tics>`, or `error ...`, which marks the timeline bad until the next `clear`; `error armed...` while armed. `buttons` is a comma list of names (`attack`, `altattack`, `use`, `jump`, `crouch`, `reload`, `zoom`, `speed`, `strafe`, `turn180`, `user1`-`user4`); an unknown one fails with the known list. `fwd`/`side`/`up` are raw ticcmd units (run: 12800 / 10240; up: 768). `angle` is an absolute heading in degrees held for the segment, `turn` degrees per tic (exclusive with `angle`), `pitch` an absolute view pitch (negative looks up) |
| `walk <pt:x,y\|tid:N\|class:Name> <standoff> <pass 0\|1> <speed> <buttons\|->` | `MCP_INPUT walk <n>`, or `error ...`, which marks the timeline bad like `seg`. `speed` in (0, 1] caps the thrust (1 = running); `buttons` are held throughout |
| `go <0\|1> [<maxtics> [<stucktics>]]` | `MCP_INPUT armed segs=<n> tics=<t> limit=<l> maptime=<m>` and the game is unpaused; `1` pauses it again on every disarm. On a frozen clock the game stays unpaused and `1` sets the pause the thaw restores instead; while a demo records or plays no disarm pauses (a paused tic desyncs it), and `go 1` refuses while a demo records unfrozen (`error recording: a pause would desync the demo; freeze the clock first`). `maxtics` defaults to the segment total with no walk entry, else 2100, and is capped at 2100; reaching it with entries left disarms `timeout`. `stucktics` (default 35): closest approach must improve by more than 1 unit to reset the timer, or more than 8 after a blocked step; otherwise the walk disarms `stuck` after that many tics. `error ...` when empty, bad, armed, on a server or a client (an offline game with bots runs), in demo playback, outside a level, with no player or a bad number |
| `status` | `MCP_INPUT active=<0\|1> consumed=<n> total=<t> seg=<i> maptime=<m> reason=<done\|level_change\|stopped\|stuck\|timeout\|died\|target_gone\|demo\|-> done=<entries completed> limit=<l> net=<0\|1> dist=<d\|-> target=<x,y\|->`. `net=1` where `go` would refuse as a netgame. `dist` is the last walk's distance to its target's centre, `target` that target's position. `died`: a walk found the player dead; segments don't stop for it. A segment timeline whose last tic ran is `done` at the next read (`status`, `trail`, `stop`) or tic, so a pause right after it still reads done |
| `trail [<from>\|ends]` | `MCP_INPUT_TRAIL`, then `start maptime= seg=0 x= y= z= angle= pitch= momx= momy= momz= health= buttons=` (the player when armed; only from index 0) and one `tic ...` row with the same fields per consumed tic from index `from`: the player after that tic, `maptime` being the tic its input was applied in. `ends` prints only each segment's last row |
| `stop` | `MCP_INPUT stopped consumed=<n>` (reason `stopped`, or `done` when the last tic had already run), or `MCP_INPUT idle` when nothing is armed |

The engine writes `MCP_INPUT_SEG <n> maptime=<m>` when a segment's first tic is
applied or a walk starts and `MCP_INPUT_END reason=<r> consumed=<n> maptime=<m>` on every disarm.
Both go to the bridge logfile and the engine's own gamelog only (not the
console, the notify area or the socket), so the host can split the bridge log
per segment. While armed, the injected buttons also carry the direction bits a
held key would set (`BT_FORWARD`/`BT_BACK`, `BT_MOVERIGHT`/`BT_MOVELEFT`,
`BT_MOVEUP`/`BT_MOVEDOWN` from the axes' signs, `BT_LEFT`/`BT_RIGHT` from
`turn`), so ACS `GetPlayerInput` reads them as it would real keys.

### Per-tic recorder

`mcp_rec` records chosen actors and events tic by tic into a buffer, and writes
it to a file on request. Its hooks sit in the playsim: the tic's end (right
after `maptime` is incremented, so once per simulated tic, after everything in
it), each spawn, `Destroy`, `SetState`, damage (after the health subtractions),
`Die`, and a script's start and normal end. Nothing is printed while armed: a
row only goes to the buffer, never the console, the gamelog or the bridge log.
A server may record too, passively and authoritatively (`rechost`);
clients are refused. Limits: 8 watches, 32 variables,
512 tracked actors at once (`untracked=`
counts the matches past that), 20000 rows (`dropped=` counts the rows past
that), 10500 tics.

A watch matches an actor by class (subclasses too), tid and player (that
player's body), AND-ed; watches are OR-ed. A watch with only a class tries at
arm and at each spawn, on the spawn's own tic; one with a tid or a player at arm
and at each tic end. A matched actor gets an id (from 1, per recording) and a
`spawn` row (a spawn, with the `spawn` event on) or a `seen` row. Events are
recorded for tracked actors, `damage` also when its source or inflictor is
tracked. Owned inventory is tracked but never sampled, and a map-reset hidden
actor never matches.

| Form | Reply |
|------|-------|
| `clear` | `MCP_REC cleared`: the setup and the buffer emptied |
| `watch [class=<name>] [tid=<n>] [player=<n>]` | `MCP_REC watch n=<count>`, or `error ...` (no selector, more than 8, `unknown class <name>`, `not an actor class <name>`, a tid below 1, a player outside 0-63), which marks the setup bad until the next `clear` |
| `fields <a,b,...>` | `MCP_REC fields n=<count>`, or `error unknown field <x> (known: ...)`, which marks it bad. The names are `findactors`' keys plus `state` (the state's `<Owner>.<index>`), `label` (its label, as `dumpactor`'s `stateid` prints it), `tics` (tics left in it) and the player fields below; default `tid,hp,x,y,z,sprite,frame` |
| `events <a,b,...\|none>` | `MCP_REC events n=<count>` of `spawn`, `destroy`, `state`, `damage`, `death`, `psprite` (default all but `state` and `psprite`), or `error unknown event ...`, which marks it bad |
| `scripts <all\|a,b,...>` | `MCP_REC scripts n=<count\|all>`: start and end rows for these scripts, each a number above 0 or else a name (at most 32; a list holding a name with spaces is sent as one quoted argument), or `error ...`, which marks it bad |
| `var map=<name>\|world=<n>\|global=<n>\|slot=<s> [index=<k>] [label=<text>]` | `MCP_REC var n=<count>`; max 32, needs `recvars`; slot form also requires the `mcp_mapslot` digest tokens |
| `go tics=<1-10500> [run=1] [every=<n>] [changes=0\|1]` | `MCP_REC armed watches=<n> tracked=<n> vars=<n> tics=<N> maptime=<m>`, after actor and variable baselines at the current maptime. Each `go` empties the buffer. `run=1` unpauses, and the tic hook pauses again on the Nth tic, so exactly N tics run (a run that ends at an intermission is left unpaused; on a frozen clock it sets the pause the thaw restores; never while a demo records or plays, and `run=1` refuses while a demo records unfrozen with `error recording: ...` as `mcp_input go 1` does); without it pause is untouched and the recording ends when N tics have run or on `stop`. `every=<n>` and `changes=1` thin actor samples only. `error ...` when armed, bad, with no watch/script/variable, on a bad argument, in demo playback, outside a level, on a client, or with `run=1` on a server |
| `status` | `MCP_REC active=<0\|1> ran=<n> tics=<N> rows=<n> dropped=<n> tracked=<n> untracked=<n> maptime=<m> reason=<done\|stopped\|level_change\|map_reset\|->`; `tracked` counts the ids given; Zandronum's `map_reset` ends before round teardown and retains the buffer |
| `dump <path>` | writes the file, then `MCP_REC wrote rows=<n> dropped=<n>`, or `error cannot write <path>`. The file name must start with `mcp-rec-` (else `error dump writes only a file named mcp-rec-*`), so the CCMD is no general file writer. `mcp_rec` is an unsafe command, like `mcp_clock`: menus and mod scripts can't run it |
| `stop` | `MCP_REC stopped ran=<n>`, which re-pauses a `run=1` recording; `MCP_REC idle` when nothing is armed |

`clear`, `watch`, `fields`, `events`, `scripts` and `var` refuse while armed (`error
armed: mcp_rec stop first`) without marking the setup bad. The host sends the
whole setup in one line (`mcp_rec stop; mcp_rec clear; mcp_rec watch ...;
mcp_rec fields ...; mcp_rec events ...; [mcp_rec scripts ...;] mcp_rec go
...[; <command>]`), so a typo arms nothing and a command after `go` runs
before any tic. Var lines follow scripts and precede `go`. A setup or `go`
failure does not stop the command following it on that console line: the
command still runs, with nothing armed. Host validation, missing-capability
and probe-resolution refusals happen before sending this schedule.

Each `var` line has exactly one selector. `map` looks up an exported name;
`index` selects an array element and is refused for a scalar or past its bound.
World indices are 0-255 and globals 0-63; with `index` these select a sparse
ACS world/global array element (an absent element reads 0). A probe-resolved
slot uses `v=1 code=<len> first=<fourcc> md5=<hex>` as `mcp_mapslot` does,
with `label=<expression>` supplied by the host. The module and slot are
rechecked at `go` and each read; a stale setup refuses `go`, and a failed
read disarms with `level_change`. A baseline is followed by changed tic-end
values only, independently of `every` and `changes`. A var at `t=M` is the
value in that tic-end state; a script started at `t=M` first shows its write
at `t=M+1` or later. A set and reset within one tic or between tic ends is
not observable. Var rows share the 20,000-row buffer with all other kinds.

The recorder-only player fields require `recplayer` and are absent unless
the tracked actor is the player's current body (not a voodoo doll):

| Fields | Value |
|--------|-------|
| `buttons`, `modbuttons` | raw and mod-modified button bitsets for the tic, decimal in the file |
| `wclass`, `pending`, `refire`, `wflags` | ready weapon class; pending weapon class (`none` for no weapon, absent for no change); refire count; weapon flags, decimal |
| `wstate`, `wlabel`, `wsprite`, `wframe`, `wtics` | weapon layer's state id, label, drawn sprite/frame and tics left; absent when that layer is missing |

Host field groups `input` and `weaponstate` expand to those groups in order,
deduplicated; the engine accepts only atomic fields. The host decodes button
and weapon-flag cells as names joined by `+`, or `-` for zero. The opt-in
`psprite` event records every tracked player layer's state changes, including
zero-tic chains, but deduplicates repeated entries of the same state and layer
object. Its `w*` keys describe the layer named by `layer`, not necessarily the
weapon layer. Bypassed removals reconcile at tic end as `wstate=none`; a
Zandronum removal and same-state re-entry within one tic is invisible. A
two-state idle loop still emits events: use weapon samples to thin those.

A level change ends the recording with `reason=level_change`, checked in the
one row writer, the tic hook, `status` and `dump` before anything is written:
not in a level, a maptime below the last one seen, or another map name. The
tic hook also wants a maptime exactly one past the last. So the old map's
teardown and the new map's spawns and OPEN scripts are not recorded; the buffer
stays readable. Not detected: a save loaded, or the same map reloaded, at the
armed maptime with no tic in between (arming at maptime 0 and restarting the map
before a tic runs).

The file starts with `MCP_RECFILE v=1 engine=<id> map=<map\|-> start=<maptime>
ran=<n> rows=<n> dropped=<n> fields=<a,b,...\|-> reason=<...>` (`fields` lists
the sample keys in the order asked), then one `rec t=<maptime> k=<kind> ...`
line per row, in the order written:

| Kind | Keys after `k=` |
|------|-----------------|
| `seen`, `spawn` | `id= class= tid= x= y= z=` |
| `sample` | `id=`, then the fields in the order asked, each left out when it has no value, as in `findactors` |
| `destroy` | `id= x= y= z=` |
| `state` | `id= [state=] [label=] [sprite= frame=] tics=` |
| `damage` | `id=` (0 for an untracked target, then `tgt=<ref>`), `amount= type= [src=<ref> [srcid=]] [inf=<ref> [infid=]] hp=` (`hp` after the hit; `srcid`/`infid` for a tracked source or inflictor). A non-lethal hit's row comes before the `Pain` state row it causes |
| `death` | `id= [src=<ref> [srcid=]] [inf=<ref> [infid=]] hp=` |
| `script_start` | `serial= script=<n\|-1> module=<name> act=<ref\|none> [name=]`: a named script prints `script=-1` and its name last, as `name=` takes the rest of the line |
| `script_end` | `serial= script=<n\|-1> [name=]`; `serial=0` when its start wasn't recorded |
| `var` | `var=<1-based selector index> value=<n> [prev=<n>] name=<label>`; a baseline and then changed tic-end values, with `name` last |
| `psprite` | `id= layer=<GZDoom layer number> wstate=<Owner.index\|none> [wlabel= wsprite= wframe= wtics=]`; the weapon-column keys show the layer named here |

`t` is `level.maptime` when the row was written: a sample at `t=M` is the state
`mcp_status maptime=M` describes, and an event at `t=M` happened during the tic
from M to M+1, or between tics (a console command). A `<ref>` is `player<n>` or
`<class>#<tid>`.

What the hooks don't see: a spawn's tid, special and args are set after the
spawn hook; damage that is vetoed or fully absorbed returns before the damage
hook, and health written directly (`P_GiveBody`, ACS, `mcp_setprop`, poison)
skips it (the `hp` sample shows it); weapon psprites need the separate opt-in
`psprite` event, not the actor `state` event; a suspended script resumed by `P_GetScriptGoing` makes no start row,
and scripts a map reset or level exit kills make no end row. Zandronum event
scripts can start and end outside `P_Ticker`, inside `P_DamageMobj` or a game
mode's ticker; their rows carry the surrounding tic's maptime.

### Frozen clock

`mcp_clock` holds the game's tic clock at a virtual (tic, frac) pair with the
sim unpaused, so the main loop keeps redrawing one frame through the normal
interpolation code and only queued jobs run tics. By default only the tic clock
and frac freeze. The opt-in `frametime 1` also holds animated textures, warps,
sky scroll, shader timers and the fps counter per tic; these advance with frozen
steps. The displayed fps value is not meaningful while held. Offline only
(`clock` cap, plus `frametime` for the render-time hold).

A job queue (at most 256 jobs) runs once per frame, right after the frame is
drawn. A `step <n>` job lets one tic through per frame until n tics have run. A
`shot` job sets the frac to k/N, renders 3 more frames at it (so a read after
the buffer swap returns a frame at that frac), then writes `<name>.png` to the
engine's working dir, as `screenshot <name>` does, without a game action and
without the `Captured` console line (a held frame never ages notify lines, so
it would show in every later frame). `mcp_clock` is an unsafe command: menus
and mod scripts can't run it. The
frac goes back to 1/1, the tic's end state, after each step tic and each shot,
so outside a shot a frozen frame looks like a paused one without the PAUSE
banner. While frozen with nothing queued the engine sleeps about 10 ms a frame.
Mouse look still turns the held view: the engine's `D_PostEvent` applies it to
the view directly whenever `paused` is 0, outside any tic (`use_mouse 0`, e.g.
`launch_instance` `mouse: false`, keeps it still).
Stock Zandronum's focus-loss pause (`paused` -1) is cleared every frozen frame
and never restored by `thaw`, so an unfocused window keeps stepping (a focus
loss landing inside a step tic still ends that one job `paused`; the next step
runs). A client
disconnect thaws the clock and disarms `freeze demo` (logging `MCP_CLOCK
frozen=0: the MCP client disconnected`), since nobody is left to step it.

| Form | Reply |
|------|-------|
| `freeze` | `MCP_CLOCK frozen=1 gametic=<n> maptime=<m> restore=<paused> jobs=1`: remembers `paused`, sets it to 0, holds the clock at the current tic and queues one step, so that live tic leaves interpolation on. `error ...` on a netgame (server or client), in client-demo playback (`error client demo playback`), with `singletics`, outside a level, with a game action pending, or with a menu or console open. An offline demo can be frozen. Already frozen: the `status` line |
| `freeze demo` | `MCP_CLOCK armed=demo frozen=0`: arms a freeze that engages once an offline demo has run its first tic, so `mcp_clock freeze demo; playdemo X` (or `...; load S; playdemo X`) holds it from the start. Allowed with a game action pending and with the console open; the arm refusals are `freeze`'s first three. While armed each frame runs one tic at most. Engaging remembers `paused` as `freeze` does, queues no step, and writes `MCP_CLOCK frozen=1 maptime=<m> restore=<paused> jobs=0 armed=demo` to the bridge logfile and the gamelog only (a notify line never ages while frozen). It lands after exactly one demo tic: `maptime` 1 for a map-started demo, the save's `maptime` plus 1 for a save-started one. `thaw`, `stop`, `mcp_unblock` and a level load without a demo disarm. Already frozen: the `status` line |
| `thaw` | `MCP_CLOCK frozen=0 maptime=<m> paused=<n> [restore_skipped=demo]`: time resumes from the held tic with no catch-up and `paused` gets the remembered value back, except while a demo records or plays, where it is set to 0 and the reply carries `restore_skipped=demo` (a paused recorded tic is simulated on replay; a paused playback tic reads a ticcmd that never runs); releases any frame-time hold; queued jobs end as `stopped`. `MCP_CLOCK frozen=0` when not frozen |
| `frametime <0\|1>` | `MCP_CLOCK frametime=<0\|1> framems=<ms>`: toggle the frame-time hold without thawing; `error not frozen` outside a freeze |
| `step <n>` | `MCP_CLOCK queued jobs=<count>`; `error not frozen`, `error paused`, `error menu or console open`, `error not in a level`, `error queue full`, or a usage error for n below 1 |
| `shot <name> [<k> <N>]` | `MCP_CLOCK queued jobs=<count>`, a capture at frac k/N (default 1/1, 0 <= k <= N); `error not frozen`, `error not in a level`, `error no display` (`-nodraw`, no screen), `error queue full`, and for k < N with interpolation off and no step queued ahead `error interpolation off (<nointerp>)` |
| `stop` | `MCP_CLOCK stopped dropped=<count>`: drops the queue (`reason=stopped` when anything was dropped). A tic already let through this frame still runs, uncounted |
| `status` | `MCP_CLOCK frozen=<0\|1> gametic=<n> maptime=<m> frac=<k>/<N> interp=<0\|1> [nointerp=<cl_capfps\|r_NoInterpolate>] jobs=<count> steps=<n> shots=<n> reason=<r> frametime=<0\|1> framems=<ms> armed=<0\|demo>` |

`interp=1` needs `r_NoInterpolate` clear (a tic has run since the last paused
one) and `cl_capfps 0`. `steps` counts the tics that moved `maptime` and
`shots` the captures written, both since the freeze, so the host waits for
target counts. `steps` includes the freeze's own tic (it reads 1 once `freeze`
settles): wait on deltas, not absolute values. A failed PNG write still counts
as a shot, so the host deletes a stale file of the same name before queueing.

The frame-time hold is tic-quantized, not frac-dependent. Each source anchors
its first held read, then advances by `(virtualTic - anchorTic) * 1000 / 35`
integer milliseconds. Repeated fractions of one tic therefore have identical
animated surfaces, but the end of tic T and the start of tic T+1 may differ on
those surfaces. A per-source offset preserves continuity when the hold is
disabled or thawed, without a wall-time catch-up. Without the hold, animated
textures and renderer timers keep real time. Zandronum software warps already
hold with the tic clock but do not advance with frozen steps; OpenGL warps
continue animating. The explicit hold advances both with steps. Menus, console,
chat, wipes, networking, mod-side real-time
APIs and frame-rate limiting retain their real clocks.

`reason` is `-` while jobs are queued or none has run since the freeze, `done`
when the queue drained, else why the queue was dropped:

| Reason | When |
|--------|------|
| `stopped` | `stop`, or `thaw` with jobs queued |
| `paused` | a step tic ran without moving `maptime` (`gametic` moves on paused tics: a `pause` net command, a menu a human opened) |
| `level_change` | after a step tic the game left `GS_LEVEL`, a level or save load was pending at the tic's start, or `maptime` moved by anything but 0 or 1 (a hub return or a save load restores its own); also when the game leaves `GS_LEVEL` with jobs queued |
| `stalled` | a step tic was let through but `gametic` didn't move for 1 s |
| `nointerp` | a k < N shot reached the head of the queue with interpolation off |
| `demo_end` | a step tic read the end of a demo that played while frozen. That tic counts in `steps`; the next step (the console return) ends `level_change`, not `demo_end` |

The clock stays frozen after every reason, so nothing runs unasked. Two traps:

- **A pause that lands while frozen** (`run_command "pause"` then a step)
  leaves `paused=1`: that step ends `paused` and every later `step` refuses
  `error paused`. Thaw, then freeze again: the thaw restores the pre-freeze
  pause and the new freeze clears it.
- **A map change through an intermission** (`changemap` on DOOM2 MAP01) parks
  the frozen clock on the intermission. The tic running the net command is a
  normal step, the next ends `level_change`, and from then on `step` refuses
  `not in a level` until a thaw lets the intermission run. A `map` command has
  no intermission but also takes two tics: the first runs on the old map and
  counts, the next loads the new one and ends `level_change`, and from then on
  steps run on the new map.

While frozen, the bridge's `setpause` and `mcp_unblock` and `mcp_mark` go
through the clock (their rows above), and `mcp_setview` snaps the view, so every
frame of a sweep shows the new angle. Input events still reach the engine's event
queue but are only processed when a step tic runs.

Notify lines age only with tics too. Game messages and game-code `Log()` output
stay in the top-left of every frozen frame until `con_notifytime` worth of step
tics have run (105 at the default 3 s). Bridge replies do not enter this area.
Comparisons spanning different game messages still need to mask their strip.

#### Checkpoints

`mcp_checkpoint [rows]` digests the playsim for demo sync checks (`demo` cap).
Read-only and safe, so it works frozen, paused or live:

```
MCP_CHECKPOINT maptime=<m> actors=<n> rng=<08x> hash=<08x> pos=<08x> vel=<08x> angle=<08x> health=<08x> tics=<08x> state=<08x> inv=<08x>
MCP_CHECKPOINT_ROW i=<n> class=<name> h=<08x> x=<hex> y=<hex> z=<hex> vx=<hex> vy=<hex> vz=<hex> angle=<hex> pitch=<hex> health=<d> tics=<d> sprite=<4 chars> frame=<letter>
```

It covers every actor thinker in iterator order (stable across replays of one
demo), skipping `DynamicLight` (animated by the renderer) and owned inventory.
Each group is an FNV-1a hash over raw values: `pos` (x, y, z), `vel`, `angle`
(angle, pitch), `health`, `tics`, `state` (the sprite name and frame letter, not
the sprite index, state or class, so a cosmetic replacement hashes the same)
and `inv` (each actor's owned inventory as class name and amount: armor, ammo,
weapons). `rng` is the sum of every RNG's seed, `hash` covers every group of
every actor. There is no `gametic`, which depends on when the demo started;
every field compares as is. With `rows`, one `MCP_CHECKPOINT_ROW` per actor
follows, with `h` the actor's own hash over its groups, so the first differing
row names the actor (`----` and `-` when it has no sprite). Values print as
their raw bits in hex: `x`..`pitch` are 32-bit fixed point and BAM, as `%08x`.
