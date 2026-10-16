# Tools

> **Auto-generated** from `src/tools.ts` by `scripts/gen-tools-doc.mjs` — do not
> edit by hand; run `npm run docs:tools` to regenerate.

The MCP server exposes **66 tools**. Your agent also discovers them at
runtime via each tool's `description`, so this is mainly for browsing.

## Commands, cheats & input

- **`run_command`** — Send a raw console command to a running, bridge-patched Zandronum instance and return its captured output.
- **`list_actor_classes`** — Run `dumpactors` and return the registered DECORATE/actor classes as structured data.
- **`summon`** — Spawn an actor of the given class at the player's position (use summon_at for exact map coordinates).
- **`summon_at`** — Run `mcp_spawnat`: spawn an actor at exact map x/y (each coordinate within -32768..32767; z defaults to the floor, angle in degrees, 0 east) and report it in the same call, even while paused (it thinks once the sim runs). The reply's class is the actual spawned class after any mod replacement (requested= shows the asked-for name when it differs); use it and the returned tid for follow-ups with find_actors/actor_state. tid defaults to a fresh unique TID; tid 0 means none. kind friend/foe matches summonfriend/summonfoe. The spawn is refused, reporting why, for an unknown class or a spot blocked by an actor, a line or the floor/ceiling fit; force skips that check. A point in the void is only caught by the floor/ceiling check here. health, special + args (up to 5, zero-padded), ambush and dormant are set at spawn time. Missile classes spawn inert.
- **`set_cheat`** — Idempotently turn a player cheat on or off. Reads the cheat bit from the engine-state snapshot and only runs the stock toggle CCMD (god, notarget, ...) when it differs, then waits for the bit to flip, so a blind toggle can never switch it the wrong way. Uses the engine's normal net path. Needs a bridge with the status cap and a cheats= field.
- **`give`** — Give an inventory item to the player.
- **`take`** — Remove an inventory item from the player.
- **`load_map`** — Load a map by its lump name (e.g. MAP01, E1M1).
- **`list_running_scripts`** — Run `scriptstat` and return the currently running ACS scripts and their states.
- **`run_script`** — Run (puke) an ACS script by number or name, with optional integer arguments.
- **`run_acs`** — Compile full ACS source host-side (bcc by default: zt-bcc or bcc on PATH, with zt-bcc's lib/ found next to or one folder above the binary; or acc on PATH; ZANDRONUM_BCC/ZANDRONUM_ACC override the executables) and load it into the running level as a temporary module, then optionally run one of its scripts by number or name with up to 4 args. The script runs inside this call until its first delay, so its Log() output comes back in the reply (Print() is a HUD message: use read_hud); stepTics then runs the sim that many tics and returns the log lines printed meanwhile. A snippet that isn't a #library is compiled as one, so its strings resolve. It may #import a library the level already loaded (pass includeDirs for its source) and then shares that library's live functions and map vars; importing a library that isn't loaded is refused before anything is sent. open runs its OPEN scripts. Compile errors come back without touching the engine. Offline only (no server/client). Zandronum can't unload a module: one the engine rejects stays loaded, inert, and every snippet stays until the map changes. While any is loaded save_game refuses: a save would fail to load (in-game saves and leaving a hub level carry the same hazard, which this tool can't intercept).
- **`screenshot`** — Take a screenshot of the game and return it as an image so it can be viewed.
- **`screenshot_file`** — Take a screenshot and leave it on disk, returning only its absolute path (no image content). For measuring pixels with a script instead of viewing the frame. A reused `name` overwrites that file.
- **`menu_key`** — Send a single menu navigation key (GUI key event) to the active menu.
- **`menu_nav`** — Send a sequence of menu keys (e.g. ["down","down","enter"]) with a small delay between each.
- **`menu_text`** — Type a string into the active menu text-entry field (e.g. the player name box after pressing enter on it), one character at a time.
- **`mouse_move`** — Move the pointer to a screen position, in pixels from the top-left of the game window. Drives hover-only UI -- tooltips, hot states -- which nothing else here can reach.
- **`mouse_click`** — Press and release the left button at a position. Give toX/toY to DRAG: press at the first point, move through it, release at the second. `double` sends a double-click.
- **`mouse_wheel`** — Wheel notches at the current pointer position. Positive scrolls up, negative down.
- **`verify_menu`** — Open a menu (via a console command like `menu_options`), apply navigation steps, then return a screenshot to verify it.

## Time control

- **`set_pause`** — Set the engine's master pause flag directly. Use this to resume a backgrounded instance that auto-paused on focus loss, so the simulation keeps advancing while the MCP drives it.
- **`step`** — Resume the game, let it run for the given number of tics (35 tics = 1 second), then pause again. Lets you advance the simulation a deterministic-ish amount to observe time-based effects (charging, projectiles, animations) without keeping the window focused.
- **`ensure_live`** — Prove the simulation actually advances: list what could block it (menu, console, chat, automap, not in a level, dead/spectating player, demo, a pending map/save/demo load, which it first waits out for up to ~5 s), then run it ~5 tics and check the map tic counter moved. The pause state is left as found, since `paused` is the normal driving state and `step` runs through it. With fix, first closes the menu (`closemenu`) and hides the console, chat and automap (`mcp_unblock`). Returns live plus the blockers found, fixed and remaining.
- **`step_until`** — Advance the sim in chunks of chunkTics until a condition holds or maxTics run out, then leave it paused like `step`. The condition compares a map var, map array element, ACS world/global var or player field (x, y, z, angle, floorHeight, sector, light, health, armor) against a number, or a player field against another field (e.g. z == floorHeight). Reports the map tics that actually elapsed. Fails fast with the blocker list if a chunk doesn't advance the map tic counter.

## ACS world/global variable read/write

- **`get_acs_var`** — Read an ACS world or global variable by index.
- **`set_acs_var`** — Write an ACS world or global variable by index.
- **`list_acs_vars`** — Run `dumpacsvars` and return all non-zero ACS world/global variables, optionally filtered by scope.

## Static ACS source index

- **`acs_index`** — Parse a directory of .acs source files and return symbol counts (scripts, functions, numeric defines). Reads files directly; no game needed.
- **`find_acs_symbol`** — Resolve a script number or a script/function name to its symbol(s) — name, number, file:line. Turns a profiler 'script 1017' into a source location.
- **`behavior_names`** — Read function and named-script names from a mod's compiled ACS (BEHAVIOR/library lumps) in a WAD or PK3 — for source-less mods. Numbered scripts have no names in bytecode (use find_acs_symbol with source for those).
- **`list_map_exports`** — List each ACS module's exported map variables and arrays (MEXP/ARAY chunks) from a WAD, PK3 or compiled .o, with slot index and array size. get_map_var/get_map_array only see exported names, so check here before a launch or pk3 rebuild. `lump` narrows to modules whose name or basename matches (e.g. `mymod` for `acs/mymod.o`).

## Savegames & demos

- **`list_saves`** — List .zds savegames in the save directory with metadata (title, map, engine, game wad, creation time) read from each save's PNG text chunks. No running game needed.
- **`save_game`** — Run `save` to write a savegame (single-player / cooperative only). NOTE: saving heavily-scripted mods can crash the engine — All-out-War crashes on save; vanilla and simple maps save fine.
- **`load_game`** — Run `load` to restore a savegame by name.
- **`play_demo`** — Run `playdemo` to play back a recorded .lmp demo. (Recording is via the -record launch arg, not a console command.)

## Live player / target state

- **`player_state`** — Run `currentpos` and return the player's position, angle, floor height, sector, light level, and (on a status-capable bridge) health, armor, and whether the player is alive, dead, or spectating.
- **`actor_state`** — Run `dumpactor` and return an actor's live state: class, health, position, angle, pitch, current DECORATE state (sprite/frame/tics, e.g. TNT1 A 0), inventory, and (for players) ready weapon + morph status. Defaults to the player; pass a TID for any actor, plus index for the nth actor sharing it.
- **`read_hud`** — Run `dumphud` and return everything the engine painted last frame: HUD text strings (with screen x/y), images (by texture name + position), and active ACS HUD messages (full composed text, layer, position, remaining tics). Captures menus too.
- **`actors_near`** — Run `actorsnear` and return actors within a radius (map units, default 512) of the player: class, health, position, and current sprite.
- **`inspect_target`** — Run `linetarget` and return the actor the player is aiming at (class, health, spawn health).
- **`set_view`** — Point the player's view: an absolute angle (degrees, Doom convention: 0 east, 90 north) with optional pitch (degrees, negative looks up), or face an actor by tid (first actor with it) or class (nearest map actor of that class, aiming at its mid-height). Give exactly one of angle, tid, class.
- **`list_players`** — Run `dumpplayers` and return every in-game player: slot, bot, spectator/dead-spectator, player state, health, armor, ready weapon, x/y/z, angle, pitch, TID, cheat bits, frags, deaths, kills/items/secrets, points, wins, team, ping and name. Bots join at slot 1+.
- **`find_actors`** — Run `findactors` and list map actors (owned inventory excluded), optionally filtered by class (includes subclasses), TID and radius around the player, sorted by distance. Each has class, tid, hp/spawnhp, x/y/z, angle, pitch, dist, sprite/frame, flags (monster, friendly, corpse, dormant, shootable, solid, invulnerable, ambush) and target. detail adds master/tracer, special + args, vel, radius/height, floorz and player index. With a tid filter each result also has index, the one to pass to actor_state(tid, index) for it (the list is in distance order, not index order).

## ACS scripts / functions / profiling

- **`list_scripts`** — Run `dumpscripts` and return every script across loaded modules (module, number, name, type, arg count).
- **`list_functions`** — Run `dumpfunctions` and return named ACS functions across loaded modules.
- **`profile_scripts`** — Run `acsprofile` and return per-script/function execution stats (total instructions, runs, avg/min/max).
- **`profile_window`** — Clear ACS profiling, wait N seconds, then return what ran during that window — `what's hot right now` rather than cumulative since map start.

## Map-scope ACS variables/arrays

- **`list_modules`** — Run `dumpmodules` and return the loaded ACS modules (id + name). Map vars live only while a map is loaded.
- **`get_map_var`** — Read a map-scope ACS variable by name (searched across loaded modules).
- **`set_map_var`** — Write a map-scope ACS variable by name.
- **`get_map_array`** — Read one element of a map-scope ACS array by name and index.
- **`set_map_array`** — Write one element of a map-scope ACS array by name and index.

## Renderer / UI inspection

- **`renderer_info`** — Active backend (software/opengl), GL vendor/shader model, resolution, fullscreen/vsync.
- **`viewport_info`** — The 3D view window rect (x/y/width/height) and screenblocks size.
- **`hud_info`** — Status bar Y position, status bar / HUD scale, alt HUD, crosshair.

## Map geometry

- **`map_info`** — Read a map from a WAD and return its format (doom/hexen/udmf) and entity counts. Reads the file directly — the game need not be running.
- **`get_sector`** — Return one sector's properties by index (all fields, format-native keys).
- **`get_linedef`** — Return one linedef by index, with its referenced sidedefs (textures + offsets) resolved.
- **`find_sectors_by_tag`** — Return all sectors whose tag/id matches (binary `tag` or UDMF `id`).

## Process management

- **`launch_instance`** — Spawn a bridge-enabled Zandronum process with the given options and attach to it. Requires ZANDRONUM_EXE to be set.
- **`attach_instance`** — Connect to a bridge-patched Zandronum that is ALREADY running — one you launched by hand, or from a terminal — and bind it to an instance number for the other tools. Only needed for engines this session didn't launch: launch_instance binds automatically. Defaults to this instance's conventional port.
- **`kill_instance`** — Stop a launched instance and detach from it. Asks the engine to quit itself first (a hard kill mid-render can wedge macOS GPU teardown and leave an unkillable process), then force-kills if it doesn't exit.
- **`reset`** — Kill every instance this session launched, and reap engines ORPHANED by earlier sessions (whose launcher is gone) that could otherwise squat bridge ports. Engines belonging to another running editor window are left alone. Pass all:true to also kill those — only do that if you know no other session is using this engine build.
- **`get_startup_errors`** — Read the engine's captured console log for an instance and surface DECORATE/ACS compile errors and fatal startup errors. Works even when the bridge never came up (e.g. the engine aborted on a bad script) — exactly when the other tools can't connect.
- **`read_log`** — Read an instance's engine console log, which catches prints that never come back in a command reply (e.g. cheat ON/OFF messages, emitted a tic later). Correlation sentinel lines are dropped. `pattern` is a case-insensitive regex filter. Without `sinceLine` this returns the last `maxLines` matches; with it, the first `maxLines` matches after that line. Pass the returned `nextLine` as `sinceLine` to read only what was logged since.
- **`get_crash`** — Return the signal, faulting address, and symbolized backtrace the bridge's crash handler captured the last time the engine crashed (segfault/abort/bus error/etc.). Use this when an instance dies unexpectedly — e.g. run_command reports the bridge closed. A report left by another engine (different PID) is named but not returned as this instance's crash; one that can't be tied to this engine (its PID is unknown, or the report has no pid line) is returned marked `Unverified:`.
