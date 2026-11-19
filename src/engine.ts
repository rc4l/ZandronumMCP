import { dirname } from "node:path";
import type { EngineAdapter } from "./adapter.js";
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
  launchPins: () => [],
  // Opt-in only, since a fixed SDL_VIDEO_WINDOW_POS could push a single-monitor setup's window off-screen.
  launchEnv: (base, platform) =>
    platform === "linux" && base.ZANDRONUM_WINDOW_POS ? { SDL_VIDEO_WINDOW_POS: base.ZANDRONUM_WINDOW_POS } : {},
  // `save <name>` writes a bare name relative to the engine's cwd, the exe's folder.
  resolveSaveDir: (env, exe) => env.ZANDRONUM_SAVE_DIR ?? (exe ? dirname(exe) : undefined),
  readSaveMeta,
  saveSubdirs: false,
  refuseCommand: () => undefined,
  // FileReader::Open is a plain fopen (files.cpp).
  ansiPaths: true,
  notes: {
    runCommand: "",
    actorClasses: "DECORATE/actor",
    summonAtWhile: "paused",
    summonAtRefusals:
      "for an unknown class or a spot blocked by an actor, a line or the floor/ceiling fit; force skips that check. " +
      "A point in the void is only caught by the floor/ceiling check here.",
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
      "slot, bot, spectator/dead-spectator, player state, health, armor, ready weapon, x/y/z, angle, pitch, TID, " +
      "cheat bits, frags, deaths, kills/items/secrets, points, wins, team, ping and name",
    findActors: "With a tid filter each result also has index, the one to pass to actor_state(tid, index) for it (the list is in distance order, not index order).",
    rendererInfo: "Active backend (software/opengl), GL vendor/shader model, resolution, fullscreen/vsync.",
  },
  e2e: {
    // `save <name>` fopens the name as given (cwd-relative or absolute); -savedir only moves autosaves.
    saveInto: "path",
    // No void check: a point past -32768..32767 is refused as out of fixed-point range, not as outside the map.
    summonAtVoid: false,
    // Stock Zandronum logs no window focus hints, so the smoke run has nothing to check.
    nofocusPattern: undefined,
  },
};
