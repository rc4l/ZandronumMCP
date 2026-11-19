# Conformance captures

`test/conformance.test.ts` parses one real reply per bridge CCMD
(`test/fixtures/zandronum/*.txt`). This directory holds what the capture run loads.

- `mcpconf.acs`: a library with an exported map var and array, a world and a global var, a
  function, an `OPEN` loop, a numbered script and a `HudMessage` script. `res/` is loaded with
  `-file`: `LOADACS` names it, `res/acs/mcpconf.o` is `acc mcpconf.acs res/acs/mcpconf.o`.
- `probe.acs`: the `mcp_runacs` snippet (`acc probe.acs probe.o`), whose script also sets a
  result value for the `mcp_runscript` capture.

## Re-capturing

Launch instance 1 on DOOM2.WAD `MAP01` with `files: ["<repo>/test/fixtures/conformance/res"]` and
`-nosound -nomusic`, then `closemenu`, `warp -800 700` (the fixtures' positions depend on it),
`set_cheat god on` and `set_cheat notarget on`. On Zandronum,
confirm before the markers that `dumprenderer` prints `renderer=opengl` (`vid_renderer` is an
archived cvar any session can flip; set it to 1 and relaunch if not): `dumprenderer`'s `gl_*`
fields and `pointinfo`'s `inmap`, which needs GL nodes, are missing under the software renderer.
`<repo>` is the driven server's own checkout. The rows up
to `input_clear` expect the level running and the player at (-800,700,8) facing north: a stock
Zandronum build launched unfocused starts paused (`paused=-1`, the single-player focus-loss pause),
so `set_pause false`, `set_view`
angle 90 pitch 0, and let about 70 tics pass (no `step`, which pauses again; re-unpause after the
rows that step). `dumpactor_tid` pins the imp's first `Spawn` frame, so on a mismatch redo it
alone: paused, a fresh `mcp_spawnat` before any marker, then its marker and `end`. Before each capture send
`run_command "echo CAPTURE <name>"`, then the command through `run_command`, and nothing else
under that marker:

| Name | Command |
|---|---|
| `status` | (marker only) |
| `currentpos` | `currentpos` |
| `spawnat` | `mcp_spawnat DoomImp <x> <y>`, 128 units ahead of the player |
| `setview` | `mcp_setview tid=<tid>` |
| `linetarget` | `linetarget` |
| `dumpactor_player` | `dumpactor` |
| `dumpactor_tid` | `dumpactor <tid>` |
| `pointinfo` | `mcp_pointinfo -800 700 mover=player:0`, the player's own spot, which the mover itself doesn't block (`fit ok=1`) |
| `checksight` | `mcp_checksight from=player:0 to=tid:<tid>`, the imp (`visible=1`) |
| `tracemove` | `mcp_tracemove -500 700`, east from the player into a blocking line, stopping at x -605 (`ok=0 reason=line`) |
| `mcp_mark` | `mcp_mark conf note` (leaves an `mcp_mark_*.png` beside the engine binary) |
| `actorsnear` | `actorsnear 512` |
| `findactors` | `findactors class=DoomImp` |
| `findactors_tid` | `findactors tid=<tid>` |
| `setprop_write` | `mcp_setprop <tid> 0 health 50` |
| `setprop_read` | `mcp_setprop <tid> 0 speed` |
| `setprop_error` | `mcp_setprop 9999 0 health 1` |
| `dumpplayers` | `dumpplayers` |
| `dumprenderer` | `dumprenderer` |
| `dumpmodules` | `dumpmodules` |
| `dumpscripts` | `dumpscripts` |
| `dumpfunctions` | `dumpfunctions` |
| `getmapvar` | `getmapvar confVar` |
| `setmapvar` | `setmapvar confVar 43` |
| `getmapvar_missing` | `getmapvar NoSuchVar` |
| `getmaparray` | `getmaparray confArr 2` |
| `setmaparray` | `setmaparray confArr 1 5` |
| `getmaparray_missing` | `getmaparray NoSuchArr 0` |
| `getacsvar` | `getacsvar world 1` |
| `setacsvar` | `setacsvar global 2 10` |
| `dumpacsvars` | `dumpacsvars` |
| `scriptstat` | `scriptstat` |
| `acsprofile` | `puke 901 1` and `step` 3 tics first (so the functions section has a row), then `acsprofile` |
| `acsprofile_sorted` | `acsprofile total 5` |
| `acsprofile_all` | `acsprofile total 0`, run right after the `acsprofile_sorted` capture |
| `dumphud` | `pukename ConfHud`, `step` 3 tics, `dumphud` |
| `runacs` | `mcp_runacs <repo>/test/fixtures/conformance/probe.o ConfProbe 5 name=1` (drop `name=1` on an overlay without the `runacsname` cap) |
| `runscript` | `mcp_runscript ConfProbe name=1 7` (the script `runacs` just loaded; it sets its result to 6 times the argument) |
| `status_acstemp` | (marker only) |
| `unblock` | `mcp_unblock` |
| `dumpactor_missing` | `dumpactor 9999` |
| `input_clear` | `set_pause true` before the marker, then `mcp_input clear` |
| `input_seg` | `mcp_input seg 5 attack 12800 0 0 - 0 -` |
| `input_seg_bad` | `mcp_input seg 5 nosuch 0 0 0 - 0 -` |
| `input_go_bad` | `mcp_input go 1` |
| `input_go` | `mcp_input clear; mcp_input seg 3 - 12800 0 0 - 0 -; mcp_input seg 2 attack 0 0 0 - 0 -; mcp_input go 1`, then wait 2 s before the next marker: the run's `MCP_INPUT_SEG` and `MCP_INPUT_END` log lines belong to this capture |
| `input_status` | `mcp_input status` |
| `input_trail` | `mcp_input trail` |
| `input_trail_ends` | `mcp_input trail ends` |
| `input_stop` | `mcp_input stop` |
| `spawnat_find` | `mcp_spawnat DoomImp <player x> <player y> find=128`, the player's own spot (from `currentpos`), so the search has to move the imp |
| `dumpactor_firing` | `mcp_setview 270` (away from the imps), `+attack`, `step` 25 tics, `dumpactor`, `-attack`, all under this marker: the pistol mid-refire, so the weapon and flash psprites, `refire` and the attack button are set. After the rows above, since it spends ammo |
| `place` | `mcp_place <tid> 0 x=<x> y=<y>`, a spot 48 to 96 units from the `spawnat` imp where `mcp_pointinfo <x> <y> mover=tid:<tid>` says `fit ok=1` |
| `place_error` | `mcp_place 9999 0 x=0` |
| `damage` | `mcp_damage <tid> 0 10` |
| `damage_error` | `mcp_damage <tid> 0 10 source=9999` |
| `inv_give` | `mcp_inv 0 0 give Clip 5` |
| `inv_take` | `mcp_inv 0 0 take Clip 5` |
| `inv_error` | `mcp_inv 0 0 give NoSuchItem` |
| `remove` | `mcp_remove <tid> 0`, last of the imp's rows |
| `remove_error` | `mcp_remove 9999 0 all=1` |
| `end` | (marker only) |

The `mapslot_*` captures take a second launch, with `files` also listing
`<repo>/test/fixtures/mapslot/res` (kept out of the first, whose `dumpmodules` expects `MCPCONF`
alone). The digests are those of `res/acs/mapslot.o` and `res/acs/mapslotn.o`
(`imageDigest`, `src/acs/bytecode.ts`); a fixture rebuild changes them:

| Name | Command |
|---|---|
| `mapslot_get` | `mcp_mapslot 4 v=1 code=44 first=SPTR md5=29ceb5e0fbf5c86a15b7f526facab038` (`ms_hid`) |
| `mapslot_set` | the same with `set=107` |
| `mapslot_array` | `mcp_mapslot 6 v=1 code=136 first=SPTR md5=4acb6c6f08027dc5833e3698dc124a63 index=11` (`mn_hid_pts[1].y`) |
| `mapslot_nomatch` | `mapslot_get`'s command with the md5's last digit changed |
| `end` | (marker only) |

The `rec_*` captures take a third launch, set up as the first. Before any marker: switch to the
rocket launcher with rockets, `summon_at DoomImp` 256 units north of the player with tid 77,
`set_view tid=77`, `set_pause true`, then the `record` tool with `watch: [{tid: 77}, {class:
"Rocket"}, {player: 0}]`, `events: ["spawn","destroy","damage","death","state"]`,
`vars: [{world: 5}]`, `scripts: "all"`, `tics: 70` and `command: "+attack; pukename ConfHud"`, and `run_command
"-attack"`. Repeat until its counts include `damage` and `death`. Then:

| Name | Command |
|---|---|
| `rec_status_done` | `mcp_rec status` |
| `rec_dump` | `mcp_rec dump mcp-rec-conf.txt`; copy that file from beside the engine binary to `test/fixtures/<engine>/rec_file.txt` |
| `rec_stop_idle` | `mcp_rec stop` |
| `rec_watch_bad` | `mcp_rec watch class=NoSuchClass` |
| `rec_var_bad` | `mcp_rec var map=NoSuchRecorderVar` |
| `rec_go_refused` | `mcp_rec go tics=10` (the bad watch above marked the setup bad) |
| `rec_clear` | `mcp_rec clear` |
| `rec_go_nothing` | `mcp_rec go tics=10` (the cleared setup has no watch, script or var) |
| `rec_watch` | `mcp_rec watch player=0` |
| `rec_var` | `mcp_rec var world=5` |
| `rec_armed` | `mcp_rec go tics=500` (still paused, so nothing runs) |
| `rec_status` | `mcp_rec status` |
| `rec_stop` | `mcp_rec stop` |
| `end` | (marker only) |

The `rec_file_player` capture uses a separate fresh launch with the first setup and pistol ready.
Pause, then `record` with `watch: [{player: 0}]`, `fields: ["input", "weaponstate"]`,
`events: ["psprite"]`, `tics: 35`, `onChange: false`, `command: "+attack"`; release with
`run_command "-attack"`. Dump with `mcp_rec dump mcp-rec-conf-player.txt` and capture that file as
`rec_file_player.txt`. It must include player sample fields, weapon/flash state-change rows and
the flash removal. Keep this separate from `rec_file`, whose kinds gain `var`, not `psprite`.

The 2026-11-08 player captures were recorded at the MAP01 spawn (-96,784,56), facing north,
after an idle 35-tic recording with the same fields. The run started at maptime 2182 and dumped 36
samples and 17 psprite events over 35 tics, with no dropped rows.

The `dumphud` captures were taken with `res/` loaded, god/notarget enabled, the player at
(-800,700,8) facing north, and `ConfHud` active after three stepped tics. The capture (2026-11-13,
a stock ZA_3.2.1 build with this overlay) used OpenGL at 800x500 (the OpenGL precondition above
binds only `dumprenderer` and `pointinfo`, so a redo of `dumphud` alone can run on either renderer). It contains
no bridge correlator and retains the HUD message and pause image.

The `input_walk*` captures take a short run of the first launch's setup (the walk moves the
player, which the later rows' positions depend on): `set_pause true`, then the rows below, then
`end`. Split into a temp dir and copy only the `input_walk*` files:

| Name | Command |
|---|---|
| `input_walk_bad` | `mcp_input clear; mcp_input walk nosuch:1 0 0 1 -` |
| `input_walk` | `mcp_input clear; mcp_input walk pt:-800,800 0 0 1 -` |
| `input_walk_go` | `mcp_input go 1 350`, then wait 3 s before the next marker: the walk's `MCP_INPUT_SEG` and `MCP_INPUT_END` log lines belong to this capture |
| `input_walk_status` | `mcp_input status` |

The `clock_*` captures follow `status_acstemp` in a short run of the first launch's setup:
markers `status`, `runacs`, `status_acstemp`, then the rows below, then `end`. Split into a temp
dir and copy only `status`, `status_acstemp` and the `clock_*` files. The game must be unpaused
with no menu or console open:

| Name | Command |
|---|---|
| `clock_step_refused` | `mcp_clock step 1` (not frozen yet) |
| `clock_frametime_refused` | `mcp_clock frametime 1` (not frozen yet) |
| `clock_freeze` | `mcp_clock freeze` |
| `clock_status` | `mcp_clock status` |
| `clock_frametime_on` | `mcp_clock frametime 1` |
| `clock_step` | `mcp_clock step 3` |
| `clock_shot` | `mcp_clock shot mcp_clock_conf 1 2` (leaves `mcp_clock_conf.png` beside the engine binary) |
| `clock_status_after` | `mcp_clock status` |
| `clock_stop` | `mcp_clock step 200; mcp_clock stop` in one `run_command` |
| `clock_frametime_off` | `mcp_clock frametime 0` |
| `clock_thaw` | `mcp_clock thaw` |

The `demo_*` run takes its own launch: DOOM2.WAD `MAP01`, no `files`, `-nosound -nomusic` and
`-record mcp-demo-conf.lmp` (relative, so it lands beside the engine binary and no host path
enters the captures), then `closemenu`. Unpaused, run the first four rows; then `set_pause true`
and the rest, waiting about 0.5 s after each `mcp_clock freeze`/`thaw` and `stop`, 2 s after
`playdemo`, and after `clock_demo_step` until `mcp_clock status` shows `jobs=0`. Split into a temp
dir and copy every file below except `demo_stop` and `clock_demo_step`:

| Name | Command |
|---|---|
| `checkpoint` | `mcp_checkpoint` |
| `checkpoint_rows` | `mcp_checkpoint rows` |
| `input_go_recording` | `mcp_input clear; mcp_input seg 3 - 12800 0 0 - 0 -; mcp_input go 1` (refused: recording unfrozen) |
| `rec_go_recording` | `mcp_rec clear; mcp_rec watch player=0; mcp_rec go tics=10 run=1` (refused the same way) |
| `clock_freeze_recording` | `mcp_clock freeze`, after the `set_pause true` (`restore=1`) |
| `clock_thaw_recording` | `mcp_clock thaw` (`restore_skipped=demo`) |
| `demo_stop` | `stop` (writes the demo) |
| `clock_freeze_demo` | `mcp_clock freeze demo` |
| `clock_demo_engaged` | `playdemo mcp-demo-conf.lmp` (the engage line arrives in the bridge log) |
| `clock_demo_status` | `mcp_clock status` |
| `checkpoint_demo` | `mcp_checkpoint` |
| `clock_demo_step` | `mcp_clock step 5000` |
| `clock_demo_end` | `mcp_clock status` (`reason=demo_end`) |
| `clock_demo_thaw` | `mcp_clock thaw` |
| `end` | (marker only) |

Zandronum prints `NetUpdate: Node 0 missed too many tics` after a played demo longer than about
70 tics (`BACKUPTICS`) ends, frozen or not (stock: `NetUpdate` skips the exchange during playback, so the resend
window is stale when it resumes). It lands in `clock_demo_thaw` and is not a bridge reply.

The var/player/frame-time captures above are real rebuilt-overlay replies with shared
conformance contracts. The `rec_file` capture includes a world[5] baseline at the
recording's start; `rec_var`, `rec_var_bad`, `rec_go_nothing` and `rec_armed` pin the variable setup replies.
The clock captures cover frame-time refusal, on/off replies and status fields
`frametime`, `framems` and `armed`. The `status` and `status_acstemp` captures include
`pending=0`.
Never hand-edit captures into a new format. On resolver changes, re-capture `mapslot_*` and
verify byte-identical replies. For notify conformance, re-run the first launch through `dumphud`
with its HUD-message script active; bridge correlator text must be absent.

Then, before `kill_instance` (a launch recreates it), split the instance's bridge tee log,
`mcp-bridge-<port>.log` beside the engine binary. For example, for Zandronum instance 1, from the
repo root:

```
node --import tsx scripts/split-captures.mjs <engine dir>/mcp-bridge-7777.log test/fixtures/zandronum
```

It writes one file per marker. To redo only some captures, run just those markers plus `end`,
split into a temp dir and copy the files over.

Review the diff: values that move between runs (positions, TIDs, `maptime`, profile timings) are
expected to change, and the test asserts shapes and the library's fixed values, not those.
