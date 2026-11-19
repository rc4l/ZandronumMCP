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
| `dumpactor_firing` | `mcp_setview 270` (away from the imps), `+attack`, `step` 25 tics, `dumpactor`, `-attack`, all under this marker: the pistol mid-refire, so the weapon and flash psprites, `refire` and the attack button are set. Last, since it spends ammo |
| `end` | (marker only) |

The `dumphud` captures were taken with `res/` loaded, god/notarget enabled, the player at
(-800,700,8) facing north, and `ConfHud` active after three stepped tics. The capture (2026-11-12,
a stock ZA_3.2.1 build with this overlay) used OpenGL at 800x500 (the OpenGL precondition above
binds only `dumprenderer` and `pointinfo`, so a redo of `dumphud` alone can run on either renderer). It contains
no bridge correlator and retains the HUD message and pause image.

The `status` and `status_acstemp` captures include `pending=0`.
Never hand-edit captures into a new format. For notify conformance, re-run the launch through
`dumphud` with its HUD-message script active; bridge correlator text must be absent.

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
