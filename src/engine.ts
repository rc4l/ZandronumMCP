import { dirname, join } from "node:path";
import type { EngineAdapter } from "./adapter.js";
import { userTempDir } from "./process/launch.js";
import { readSaveMeta } from "./saves/png.js";

/** Zandronum's identity and engine specifics. */
export const engine: EngineAdapter = {
  id: "zandronum",
  displayName: "Zandronum",
  envPrefix: "ZANDRONUM",
  serverName: "zandronum-mcp",
  macHooksBinary: "zandronum-mcp-hooks",
  exeHint: "zandronum.exe on Windows, Zandronum.app on macOS, ./zandronum on Linux",
  bridgeHelp: ": download one from the GitHub Releases, or build it yourself (see docs/ADVANCED.md)",
  fullscreenCvar: "fullscreen",
  launchPins: () => [
    // Never announce a -host test server to the public master list. sv_updatemaster isn't
    // CVAR_ARCHIVE and this build skips autoexec, so the command line is the only place to set it.
    "+set", "sv_updatemaster", "0",
    // Loopback LAN tests run several clients from 127.0.0.1; the engine default of 2 refuses the 3rd.
    "+set", "sv_maxclientsperip", "8",
  ],
  // Opt-in only, since a fixed SDL_VIDEO_WINDOW_POS could push a single-monitor setup's window off-screen.
  launchEnv: (base, platform) =>
    platform === "linux" && base.ZANDRONUM_WINDOW_POS ? { SDL_VIDEO_WINDOW_POS: base.ZANDRONUM_WINDOW_POS } : {},
  // A filename prefix for the engine's native StartLogging, timestamped per session, kept out of
  // the build folder and the user's own gamelogs.
  gamelogDefault: () => join(userTempDir("zandronum-mcp"), "gamelogs", "zagamelog"),
  // `save <name>` writes a bare name relative to the engine's cwd, the exe's folder.
  resolveSaveDir: (env, exe) => env.ZANDRONUM_SAVE_DIR ?? (exe ? dirname(exe) : undefined),
  readSaveMeta,
  saveSubdirs: false,
  refuseCommand: () => undefined,
  // FileReader::Open is a plain fopen (files.cpp).
  ansiPaths: true,
  netgame: {
    hostFlag: "-host",
    clientFlag: "-connect",
    // Clients connect as spectators; `join` is refused on the server (p_user.cpp).
    joinCommand: "join",
    // A paused client stops processing server traffic, so step must not re-pause it.
    stepLeavesClientRunning: true,
    pauseNotes: {
      // P_Ticker's paused check sits inside `NETWORK_GetState() != NETSTATE_SERVER` (p_tick.cpp).
      server: "pause doesn't stop a server's sim: maptime keeps advancing",
      client: "a paused client stops processing server traffic: relayed log lines and world updates wait until it is unpaused",
    },
  },
  notes: {
    runCommand: "",
    actorClasses: "DECORATE/actor",
    reloadLumps: "DECORATE/MAPINFO",
    summonAtWhile: "paused",
    summonAtRefusals:
      "for an unknown class or a spot blocked by an actor, a line or the floor/ceiling fit; force skips that check. " +
      "An x or y outside -32767..32767, or a z below -32767 or above 32767 minus the actor's height, is refused too, " +
      "force or not, since fixed point would wrap it. " +
      "A point in the void is only caught by the floor/ceiling check here, so with findSpot a requested point " +
      "already behind a one-sided wall can resolve to a spot on that same far side.",
    setActorProp:
      "Refused outside a level, on a client instance (set it on the server) and on a spectator. " +
      "On a server pass a tid (tid 0 isn't your body there), and only replicated props and flags can be written " +
      "(others report not replicated); friction, damagemultiply and friendlyseeblocks are unsupported on this engine, " +
      "and a player pawn's height can't be set (the engine resets it every tic).",
    runAcs:
      "Offline only (no server/client). Zandronum can't unload a module: one the engine rejects stays loaded, inert, " +
      "and every snippet stays until the map changes. While any is loaded",
    screenshotFile: "",
    setPause:
      ". Use this to resume a backgrounded instance that auto-paused on focus loss, so the simulation keeps " +
      "advancing while the MCP drives it.",
    ensureLiveBlockers: "menu, console, chat, automap, not in a level, dead/spectating player, demo",
    ensureLiveLoadWait: "",
    ensureLiveUnblock: " and hides the console, chat and automap (`mcp_unblock`)",
    setCheat: "Uses the engine's normal net path.",
    listSaves:
      "List .zds savegames in the save directory with metadata (title, map, engine, game wad, creation time) " +
      "read from each save's PNG text chunks.",
    saveGame:
      "NOTE: saving heavily-scripted mods can crash the engine — All-out-War crashes on save; vanilla and simple maps save fine.",
    hudMessages: "ACS HUD messages",
    playerFields:
      "slot, bot, host (offline only: a server owns no player slot), spectator/dead-spectator, player state, " +
      "health, armor, ready weapon, x/y/z, angle, pitch, TID, " +
      "cheat bits, frags, deaths, kills/items/secrets, points, wins, team, ping and name",
    findActors: "With a tid filter each result also has index, the one to pass to actor_state(tid, index) for it (the list is in distance order, not index order).",
    rendererInfo: "Active backend (software/opengl), GL vendor/shader model, resolution, fullscreen/vsync.",
  },
  e2e: {
    // `save <name>` fopens the name as given (cwd-relative or absolute); -savedir only moves autosaves.
    saveInto: "path",
    // No void check: a point past ±32767 is refused as out of fixed-point range, not as outside the map.
    summonAtVoid: false,
    // Stock Zandronum logs no window focus hints, so the smoke run has nothing to check.
    nofocusPattern: undefined,
  },
};
