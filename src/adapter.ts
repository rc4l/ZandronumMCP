import type { LaunchOptions } from "./process/launch.js";

/** What differs between the engines this host drives; shared core reads engine specifics only through this. */
export interface EngineAdapter {
  /** Matches the bridge hello's `engine` field. */
  id: string;
  displayName: string;
  /** Prefix of every env var the server and the engine bridge read (`<PREFIX>_EXE`, `<PREFIX>_BRIDGE_PORT`, ...). */
  envPrefix: string;
  /** MCP server name; also names the dedicated engine ini (`<name>.ini`, see `configPathFor`). */
  serverName: string;
  /** Binary inside a macOS `.app` bundle given as `<PREFIX>_EXE`. */
  macHooksBinary: string;
  /** Per-platform engine paths, for the "set <PREFIX>_EXE" error. */
  exeHint: string;
  /** Where to get a bridge-patched build, appended to "Point it at a bridge-patched build" (lead with ": " or ", "). */
  bridgeHelp: string;
  /** The cvar that pins windowed mode. */
  fullscreenCvar: string;
  /** Engine-specific `+set` pins, after the window size and before `+map`. */
  launchPins: (o: LaunchOptions, env: NodeJS.ProcessEnv) => string[];
  /** Extra child env; a key the launching environment already sets wins. */
  launchEnv: (base: NodeJS.ProcessEnv, platform: NodeJS.Platform) => NodeJS.ProcessEnv;
  /** Default `<PREFIX>_BRIDGE_GAMELOG` for a launch of `exe`. */
  gamelogDefault: (exe: string) => string;
  /** Default savegame dir, resolved once at startup; undefined when none can be determined. */
  resolveSaveDir: (env: NodeJS.ProcessEnv, exe: string | undefined) => string | undefined;
  /** Metadata from one savegame file's bytes. */
  readSaveMeta: (file: string, buf: Buffer) => SaveMeta;
  /** list_saves also scans each immediate subfolder of the save dir (per-game save folders). */
  saveSubdirs: boolean;
  /** Why run_command refuses this raw console text before sending it, or undefined to send it. */
  refuseCommand: (text: string) => string | undefined;
  /** A whole console line the engine prints as decoration, dropped from replies; undefined when there is none. */
  consoleBar?: RegExp;
  /** The engine opens files with ANSI `fopen` on Windows, so a non-ASCII path can't reach it. */
  ansiPaths: boolean;
  /** Whether the engine's walk of a -file directory on `platform` leaves out an entry, by its own name, at any depth. */
  dirWalkSkips: (name: string, isDir: boolean, platform: NodeJS.Platform) => boolean;
  /** LAN roles and their pause caveats; undefined for an engine with no netgame support here. */
  netgame?: NetgameCaps;
  notes: EngineNotes;
  e2e: EngineE2e;
}

/** How an instance's launch args mark its netgame role, and what that role means for pausing. */
export interface NetgameCaps {
  /** The launch flag that makes an instance the server, e.g. "-host". */
  hostFlag: string;
  /** The launch flag that makes an instance a client, e.g. "-connect". */
  clientFlag: string;
  /** The console command a client sends to leave spectating; undefined when clients enter as players. */
  joinCommand?: string;
  /** step and stepTics leave a client running, since a paused client stalls; unset where step acts on the whole net. */
  stepLeavesClientRunning?: boolean;
  /** The caveat set_pause/step/step_until add on each role. */
  pauseNotes: { server: string; client: string };
}

/** What `scripts/e2e-smoke.mjs` can expect of a real build of this engine. */
export interface EngineE2e {
  /** How a save is aimed at a scratch dir: a launch flag naming the dir, or "path" when `save` takes a full path. */
  saveInto: { flag: string } | "path";
  /** summon_at refuses a point in the void as "outside map". */
  summonAtVoid: boolean;
  /** read_log pattern for the no-focus hint line logged at window creation; undefined for none. */
  nofocusPattern: string | undefined;
}

/** Description fragments for engine caveats, each spliced into one tool's shared description. */
export interface EngineNotes {
  /** Appended to run_command's description; "" for none. */
  runCommand: string;
  /** What list_actor_classes lists, e.g. "DECORATE/actor". */
  actorClasses: string;
  /** Lumps relaunch_instance picks up edits to, e.g. "DECORATE/MAPINFO". */
  reloadLumps: string;
  /** When summon_at still spawns, after "even while". */
  summonAtWhile: string;
  /** Why summon_at refuses, after "The spawn is refused, reporting why, ". */
  summonAtRefusals: string;
  /** Closes set_actor_prop's description: where it is refused. */
  setActorProp: string;
  /** Where place_actor, remove_actor, damage_actor and give/take with a tid are refused. */
  actorWrites: string;
  /** place_actor's engine caveats (the void, a netgame player body); "" for none. */
  placeActor: string;
  /** remove_actor's engine caveats; "" for none. */
  removeActor: string;
  /** give/take's engine caveats, on either path; "" for none. */
  inventory: string;
  /** run_acs net-mode and unload caveats, before "save_game refuses". */
  runAcs: string;
  /** Appended to screenshot_file's description; "" for none. */
  screenshotFile: string;
  /** set_pause's description after "Set the engine's master pause flag directly" (lead with `. ` or `, `). */
  setPause: string;
  /** What ensure_live checks for, before ", a pending map/save/demo load" in "list what could block it (...)". */
  ensureLiveBlockers: string;
  /** When ensure_live doesn't wait out a pending load, after "(up to ~5 s)" (lead with ", "); "" for none. */
  ensureLiveLoadWait: string;
  /** What fix's `mcp_unblock` clears, ending the sentence after "closes the menu (`closemenu`)" (lead with " and " or ", "). */
  ensureLiveUnblock: string;
  /** set_cheat's sentence before "Needs a bridge with the status cap". */
  setCheat: string;
  /** list_saves' description before "No running game needed." */
  listSaves: string;
  /** Appended to save_game's description; "" for none. */
  saveGame: string;
  /** What read_hud calls HUD messages, e.g. "ACS HUD messages". */
  hudMessages: string;
  /** The fields list_players returns, in order. */
  playerFields: string;
  /** Closes find_actors' description: how to drill into one result. */
  findActors: string;
  /** renderer_info's whole description. */
  rendererInfo: string;
  /** Appended to profile_scripts' and profile_window's descriptions: what the engine leaves out of the profile; "" for none. */
  profileScripts: string;
}

export interface SaveMeta {
  file: string;
  title: string | null;
  map: string | null;
  engine: string | null;
  gameWad: string | null;
  created: string | null;
}

/** The name of one of the engine's env vars, e.g. `envName(engine, "EXE")`. */
export function envName(engine: Pick<EngineAdapter, "envPrefix">, suffix: string): string {
  return `${engine.envPrefix}_${suffix}`;
}

/** `base`, then `note` after a space when there is one. */
export function appendNote(base: string, note: string): string {
  return note ? `${base} ${note}` : base;
}
