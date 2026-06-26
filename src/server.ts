#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { InstanceRegistry, defaultLaunchIo } from "./process/registry.js";
import { hasBridge } from "./process/verify.js";
import { parseDumpActors } from "./parsers/dumpactors.js";
import { parseScriptStat } from "./parsers/scriptstat.js";
import { parseAcsVars } from "./parsers/acsvars.js";
import { parseMapVar, parseMapArray, parseModules } from "./parsers/mapvars.js";
import { parseScripts, parseFunctions } from "./parsers/scripts.js";
import { parseAcsProfile } from "./parsers/acsprofile.js";
import { parsePlayerState, parseTarget } from "./parsers/playerstate.js";
import { parseActorState, parseActorsNear } from "./parsers/actorstate.js";
import { parseHud } from "./parsers/hud.js";
import { buildIndex, findSymbol, type AcsIndex } from "./acs/symbols.js";
import { collectAcsLumps } from "./acs/collect.js";
import { parseBehaviorNames } from "./acs/bytecode.js";
import { readdirSync } from "node:fs";
import { readMapFromContainer, type MapData } from "./map/index.js";
import { parseRenderInfo, pick } from "./parsers/renderinfo.js";
import { command, buildPuke, buildPukeName, buildSave } from "./commands/builders.js";
import { readSaveMeta } from "./saves/png.js";
import { captureScreenshot } from "./screenshot/capture.js";
import { menuKeyEvent, charEvent, type MenuKey } from "./input/keys.js";

// --- configuration (via env so MCP clients can pass it in their config) ------
const DEFAULT_HOST = process.env.ZANDRONUM_BRIDGE_HOST ?? "127.0.0.1";
const BASE_PORT = Number.parseInt(process.env.ZANDRONUM_BRIDGE_PORT ?? "7777", 10);
// Where the engine writes screenshots — its working directory.
const SCREENSHOT_DIR = process.env.ZANDRONUM_SCREENSHOT_DIR ?? ".";
// Path to the zandronum binary (zandronum.exe on Windows; the `zandronum`
// executable on Linux/macOS), used by launch_instance.
const ZANDRONUM_EXE = process.env.ZANDRONUM_EXE;

const portFor = (instance: number) => BASE_PORT + (instance - 1);
// Default WAD to read maps from (usually the IWAD).
const ZANDRONUM_IWAD = process.env.ZANDRONUM_IWAD;

// Parsed maps are cached so a slaughtermap is parsed once, then sliced per query.
const mapCache = new Map<string, MapData>();
function loadMap(file: string | undefined, map: string): MapData {
  const wad = file ?? ZANDRONUM_IWAD;
  if (!wad) throw new Error("No WAD specified. Pass `file` or set ZANDRONUM_IWAD.");
  const key = `${wad}|${map.toUpperCase()}`;
  let data = mapCache.get(key);
  if (!data) {
    data = readMapFromContainer(readFileSync(wad), map);
    mapCache.set(key, data);
  }
  return data;
}

const registry = new InstanceRegistry();

/** Lazily attach to instance N (port = BASE_PORT + N-1) on first use. */
async function clientFor(instance: number) {
  if (!registry.has(instance)) {
    await registry.attach({
      id: instance,
      host: DEFAULT_HOST,
      port: BASE_PORT + (instance - 1),
    });
  }
  return registry.get(instance);
}

const instanceArg = z.number().int().positive().default(1);

const server = new McpServer({ name: "zandronum-mcp", version: "0.2.0" });

server.registerTool(
  "run_command",
  {
    title: "Run console command",
    description:
      "Send a raw console command to a running, bridge-patched Zandronum instance and return its captured output.",
    inputSchema: { instance: instanceArg, text: z.string().min(1) },
  },
  async ({ instance, text }) => {
    const client = await clientFor(instance);
    const output = await client.runCommand(text);
    return { content: [{ type: "text", text: output.join("\n") || "(no output)" }] };
  },
);

server.registerTool(
  "list_actor_classes",
  {
    title: "List actor classes",
    description:
      "Run `dumpactors` and return the registered DECORATE/actor classes as structured data.",
    inputSchema: { instance: instanceArg },
    outputSchema: {
      actors: z.array(
        z.object({
          name: z.string(),
          edNum: z.number(),
          spawnId: z.number(),
          filter: z.string(),
          source: z.string(),
        }),
      ),
    },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const output = await client.runCommand("dumpactors");
    const actors = parseDumpActors(output);
    return {
      content: [{ type: "text", text: `${actors.length} actor classes` }],
      structuredContent: { actors },
    };
  },
);

server.registerTool(
  "summon",
  {
    title: "Summon actor",
    description: "Spawn an actor of the given class at the player's position.",
    inputSchema: {
      instance: instanceArg,
      className: z.string().min(1),
      kind: z.enum(["normal", "friend", "foe"]).default("normal"),
    },
  },
  async ({ instance, className, kind }) => {
    const verb = kind === "friend" ? "summonfriend" : kind === "foe" ? "summonfoe" : "summon";
    const client = await clientFor(instance);
    const output = await client.runCommand(command(verb, className));
    return { content: [{ type: "text", text: output.join("\n") || `summoned ${className}` }] };
  },
);

server.registerTool(
  "give",
  {
    title: "Give item",
    description: "Give an inventory item to the player.",
    inputSchema: {
      instance: instanceArg,
      item: z.string().min(1),
      amount: z.number().int().positive().optional(),
    },
  },
  async ({ instance, item, amount }) => {
    const client = await clientFor(instance);
    const cmd = amount === undefined ? command("give", item) : command("give", item, amount);
    const output = await client.runCommand(cmd);
    return { content: [{ type: "text", text: output.join("\n") || `gave ${item}` }] };
  },
);

server.registerTool(
  "take",
  {
    title: "Take item",
    description: "Remove an inventory item from the player.",
    inputSchema: {
      instance: instanceArg,
      item: z.string().min(1),
      amount: z.number().int().positive().optional(),
    },
  },
  async ({ instance, item, amount }) => {
    const client = await clientFor(instance);
    const cmd = amount === undefined ? command("take", item) : command("take", item, amount);
    const output = await client.runCommand(cmd);
    return { content: [{ type: "text", text: output.join("\n") || `took ${item}` }] };
  },
);

server.registerTool(
  "load_map",
  {
    title: "Load map",
    description: "Load a map by its lump name (e.g. MAP01, E1M1).",
    inputSchema: { instance: instanceArg, mapName: z.string().min(1) },
  },
  async ({ instance, mapName }) => {
    const client = await clientFor(instance);
    const output = await client.runCommand(command("map", mapName));
    return { content: [{ type: "text", text: output.join("\n") || `loaded ${mapName}` }] };
  },
);

server.registerTool(
  "list_running_scripts",
  {
    title: "List running ACS scripts",
    description: "Run `scriptstat` and return the currently running ACS scripts and their states.",
    inputSchema: { instance: instanceArg },
    outputSchema: {
      scripts: z.array(
        z.object({
          number: z.number().nullable(),
          name: z.string().nullable(),
          state: z.string(),
        }),
      ),
    },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const output = await client.runCommand("scriptstat");
    const scripts = parseScriptStat(output);
    return {
      content: [{ type: "text", text: `${scripts.length} running script(s)` }],
      structuredContent: { scripts },
    };
  },
);

server.registerTool(
  "run_script",
  {
    title: "Run ACS script",
    description:
      "Run (puke) an ACS script by number or name, with optional integer arguments.",
    inputSchema: {
      instance: instanceArg,
      script: z.union([z.number().int(), z.string().min(1)]),
      args: z.array(z.number().int()).optional(),
      always: z.boolean().optional(),
    },
  },
  async ({ instance, script, args, always }) => {
    const client = await clientFor(instance);
    const command =
      typeof script === "number"
        ? buildPuke(script, args)
        : buildPukeName(script, args, always);
    const output = await client.runCommand(command);
    return { content: [{ type: "text", text: output.join("\n") || `ran ${script}` }] };
  },
);

server.registerTool(
  "screenshot",
  {
    title: "Screenshot",
    description:
      "Take a screenshot of the game and return it as an image so it can be viewed.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const shot = await captureScreenshot(client, { dir: SCREENSHOT_DIR });
    return {
      content: [{ type: "image", data: shot.base64, mimeType: "image/png" }],
    };
  },
);

const MENU_KEYS = ["up", "down", "left", "right", "enter", "back", "backspace"] as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function postMenuKey(client: { sendEvent: (a: number, b: number, c: number, d: number) => void }, key: MenuKey) {
  const ev = menuKeyEvent(key);
  client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
}

server.registerTool(
  "menu_key",
  {
    title: "Press a menu key",
    description: "Send a single menu navigation key (GUI key event) to the active menu.",
    inputSchema: { instance: instanceArg, key: z.enum(MENU_KEYS) },
  },
  async ({ instance, key }) => {
    const client = await clientFor(instance);
    if (!client.supports("event")) {
      return { isError: true, content: [{ type: "text", text: "This engine bridge has no input support (rebuild with the latest bridge)." }] };
    }
    postMenuKey(client, key);
    return { content: [{ type: "text", text: `sent ${key}` }] };
  },
);

server.registerTool(
  "menu_nav",
  {
    title: "Navigate a menu",
    description: "Send a sequence of menu keys (e.g. [\"down\",\"down\",\"enter\"]) with a small delay between each.",
    inputSchema: { instance: instanceArg, steps: z.array(z.enum(MENU_KEYS)).min(1) },
  },
  async ({ instance, steps }) => {
    const client = await clientFor(instance);
    if (!client.supports("event")) {
      return { isError: true, content: [{ type: "text", text: "This engine bridge has no input support (rebuild with the latest bridge)." }] };
    }
    for (const key of steps) {
      postMenuKey(client, key);
      await sleep(60);
    }
    return { content: [{ type: "text", text: `sent ${steps.length} key(s): ${steps.join(" ")}` }] };
  },
);

server.registerTool(
  "menu_text",
  {
    title: "Type into a menu text field",
    description:
      "Type a string into the active menu text-entry field (e.g. the player name box after pressing enter on it), one character at a time.",
    inputSchema: { instance: instanceArg, text: z.string().min(1) },
  },
  async ({ instance, text }) => {
    const client = await clientFor(instance);
    if (!client.supports("event")) {
      return { isError: true, content: [{ type: "text", text: "This engine bridge has no input support (rebuild with the latest bridge)." }] };
    }
    for (const ch of text) {
      const ev = charEvent(ch);
      client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
      await sleep(40);
    }
    return { content: [{ type: "text", text: `typed "${text}"` }] };
  },
);

server.registerTool(
  "verify_menu",
  {
    title: "Open, navigate, and screenshot a menu",
    description:
      "Open a menu (via a console command like `menu_options`), apply navigation steps, then return a screenshot to verify it.",
    inputSchema: {
      instance: instanceArg,
      open: z.string().optional(),
      steps: z.array(z.enum(MENU_KEYS)).default([]),
    },
  },
  async ({ instance, open, steps }) => {
    const client = await clientFor(instance);
    if (open) await client.runCommand(open);
    if (steps.length > 0) {
      if (!client.supports("event")) {
        return { isError: true, content: [{ type: "text", text: "This engine bridge has no input support (rebuild with the latest bridge)." }] };
      }
      for (const key of steps) {
        postMenuKey(client, key);
        await sleep(60);
      }
    }
    const shot = await captureScreenshot(client, { dir: SCREENSHOT_DIR });
    return { content: [{ type: "image", data: shot.base64, mimeType: "image/png" }] };
  },
);

// --- time control -----------------------------------------------------------
// Single-player Zandronum hard-pauses when its window loses focus (no cvar to
// disable it), which freezes the simulation whenever the MCP drives a
// backgrounded instance. These tools set the engine's pause flag directly so
// time-based behavior — charge weapons, projectiles, animations, monster AI —
// is actually testable headless. The TICRATE (35 tics/sec) is fixed in Doom.
const TICRATE = 35;
const NO_TIME_CAP =
  "This engine bridge has no time-control support (rebuild/redownload with the latest bridge).";

server.registerTool(
  "set_pause",
  {
    title: "Pause or resume the game",
    description:
      "Set the engine's master pause flag directly. Use this to resume a backgrounded instance that auto-paused on focus loss, so the simulation keeps advancing while the MCP drives it.",
    inputSchema: { instance: instanceArg, paused: z.boolean() },
  },
  async ({ instance, paused }) => {
    const client = await clientFor(instance);
    if (!client.supports("time")) {
      return { isError: true, content: [{ type: "text", text: NO_TIME_CAP }] };
    }
    client.setPause(paused);
    return { content: [{ type: "text", text: paused ? "paused" : "resumed" }] };
  },
);

server.registerTool(
  "step",
  {
    title: "Advance the game by N tics",
    description:
      "Resume the game, let it run for the given number of tics (35 tics = 1 second), then pause again. Lets you advance the simulation a deterministic-ish amount to observe time-based effects (charging, projectiles, animations) without keeping the window focused.",
    inputSchema: {
      instance: instanceArg,
      tics: z.number().int().positive().default(35),
    },
  },
  async ({ instance, tics }) => {
    const client = await clientFor(instance);
    if (!client.supports("time")) {
      return { isError: true, content: [{ type: "text", text: NO_TIME_CAP }] };
    }
    client.setPause(false);
    await sleep((tics / TICRATE) * 1000);
    client.setPause(true);
    return { content: [{ type: "text", text: `advanced ~${tics} tic(s)` }] };
  },
);

// --- ACS world/global variable read/write ----------------------------------
const acsScope = z.enum(["world", "global"]);

server.registerTool(
  "get_acs_var",
  {
    title: "Get ACS variable",
    description: "Read an ACS world or global variable by index.",
    inputSchema: { instance: instanceArg, scope: acsScope, index: z.number().int().min(0) },
  },
  async ({ instance, scope, index }) => {
    const client = await clientFor(instance);
    const output = await client.runCommand(command("getacsvar", scope, index));
    const vars = parseAcsVars(output);
    if (vars.length === 0) {
      return { isError: true, content: [{ type: "text", text: output.join("\n") || "no value" }] };
    }
    return {
      content: [{ type: "text", text: String(vars[0].value) }],
      structuredContent: { scope, index, value: vars[0].value },
    };
  },
);

server.registerTool(
  "set_acs_var",
  {
    title: "Set ACS variable",
    description: "Write an ACS world or global variable by index.",
    inputSchema: {
      instance: instanceArg,
      scope: acsScope,
      index: z.number().int().min(0),
      value: z.number().int(),
    },
  },
  async ({ instance, scope, index, value }) => {
    const client = await clientFor(instance);
    const output = await client.runCommand(command("setacsvar", scope, index, value));
    const vars = parseAcsVars(output);
    if (vars.length === 0) {
      return { isError: true, content: [{ type: "text", text: output.join("\n") || "set failed" }] };
    }
    return {
      content: [{ type: "text", text: `${scope}[${index}] = ${vars[0].value}` }],
      structuredContent: { scope, index, value: vars[0].value },
    };
  },
);

server.registerTool(
  "list_acs_vars",
  {
    title: "List non-zero ACS variables",
    description: "Run `dumpacsvars` and return all non-zero ACS world/global variables, optionally filtered by scope.",
    inputSchema: { instance: instanceArg, scope: acsScope.optional() },
  },
  async ({ instance, scope }) => {
    const client = await clientFor(instance);
    let vars = parseAcsVars(await client.runCommand("dumpacsvars"));
    if (scope) vars = vars.filter((v) => v.scope === scope);
    return {
      content: [{ type: "text", text: `${vars.length} non-zero ACS var(s)` }],
      structuredContent: { vars },
    };
  },
);

// --- static ACS source index (number <-> name <-> file:line) ----------------
const ZANDRONUM_ACS_SRC = process.env.ZANDRONUM_ACS_SRC;
const acsIndexCache = new Map<string, AcsIndex>();
function loadAcsIndex(dir: string | undefined): AcsIndex {
  const src = dir ?? ZANDRONUM_ACS_SRC;
  if (!src) throw new Error("No ACS source dir. Pass `dir` or set ZANDRONUM_ACS_SRC.");
  let idx = acsIndexCache.get(src);
  if (!idx) {
    const files = readdirSync(src)
      .filter((f) => f.toLowerCase().endsWith(".acs"))
      .map((f) => ({ path: f, text: readFileSync(path.join(src, f), "utf8") }));
    idx = buildIndex(files);
    acsIndexCache.set(src, idx);
  }
  return idx;
}

const acsSrcArg = z.string().optional();

server.registerTool(
  "acs_index",
  {
    title: "Index ACS source",
    description:
      "Parse a directory of .acs source files and return symbol counts (scripts, functions, numeric defines). Reads files directly; no game needed.",
    inputSchema: { dir: acsSrcArg },
  },
  async ({ dir }) => {
    const idx = loadAcsIndex(dir);
    const info = {
      scripts: idx.symbols.filter((s) => s.kind === "script").length,
      functions: idx.symbols.filter((s) => s.kind === "function").length,
      defines: Object.keys(idx.defines).length,
    };
    return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
  },
);

server.registerTool(
  "find_acs_symbol",
  {
    title: "Find ACS symbol",
    description:
      "Resolve a script number or a script/function name to its symbol(s) — name, number, file:line. Turns a profiler 'script 1017' into a source location.",
    inputSchema: { ref: z.string().min(1), dir: acsSrcArg },
  },
  async ({ ref, dir }) => {
    const matches = findSymbol(loadAcsIndex(dir), ref);
    return {
      content: [{ type: "text", text: `${matches.length} match(es) for ${ref}` }],
      structuredContent: { matches },
    };
  },
);

server.registerTool(
  "behavior_names",
  {
    title: "Read ACS names from compiled bytecode",
    description:
      "Read function and named-script names from a mod's compiled ACS (BEHAVIOR/library lumps) in a WAD or PK3 — for source-less mods. Numbered scripts have no names in bytecode (use find_acs_symbol with source for those).",
    inputSchema: { file: z.string().min(1) },
  },
  async ({ file }) => {
    const functions = new Set<string>();
    const namedScripts = new Set<string>();
    for (const lump of collectAcsLumps(readFileSync(file))) {
      const names = parseBehaviorNames(lump);
      names.functions.forEach((n) => functions.add(n));
      names.namedScripts.forEach((n) => namedScripts.add(n));
    }
    const result = { functions: [...functions], namedScripts: [...namedScripts] };
    return {
      content: [{ type: "text", text: `${result.functions.length} functions, ${result.namedScripts.length} named scripts` }],
      structuredContent: result,
    };
  },
);

// --- savegames & demos ------------------------------------------------------

const ZANDRONUM_SAVE_DIR = process.env.ZANDRONUM_SAVE_DIR;

function saveDir(dir?: string): string {
  const d = dir ?? ZANDRONUM_SAVE_DIR ?? (ZANDRONUM_EXE ? path.dirname(ZANDRONUM_EXE) : undefined);
  if (!d) throw new Error("No save dir. Pass `dir`, or set ZANDRONUM_SAVE_DIR or ZANDRONUM_EXE.");
  return d;
}

server.registerTool(
  "list_saves",
  {
    title: "List savegames",
    description:
      "List .zds savegames in the save directory with metadata (title, map, engine, game wad, creation time) read from each save's PNG text chunks. No running game needed.",
    inputSchema: { dir: z.string().optional() },
  },
  async ({ dir }) => {
    const d = saveDir(dir);
    const saves = readdirSync(d)
      .filter((f) => f.toLowerCase().endsWith(".zds"))
      .map((f) => readSaveMeta(f, readFileSync(path.join(d, f))));
    return {
      content: [{ type: "text", text: `${saves.length} save(s) in ${d}` }],
      structuredContent: { dir: d, saves },
    };
  },
);

server.registerTool(
  "save_game",
  {
    title: "Save the game",
    description:
      "Run `save` to write a savegame (single-player / cooperative only). NOTE: saving heavily-scripted mods can crash the engine — All-out-War crashes on save; vanilla and simple maps save fine.",
    inputSchema: { instance: instanceArg, name: z.string().min(1), description: z.string().optional() },
  },
  async ({ instance, name, description }) => {
    const client = await clientFor(instance);
    const out = (await client.runCommand(buildSave(name, description))).join("\n");
    return { isError: !/game saved/i.test(out), content: [{ type: "text", text: out.trim() || "(no output)" }] };
  },
);

server.registerTool(
  "load_game",
  {
    title: "Load a savegame",
    description: "Run `load` to restore a savegame by name.",
    inputSchema: { instance: instanceArg, name: z.string().min(1) },
  },
  async ({ instance, name }) => {
    const client = await clientFor(instance);
    const out = (await client.runCommand(command("load", name))).join("\n");
    return { content: [{ type: "text", text: out.trim() || "(loaded)" }] };
  },
);

server.registerTool(
  "play_demo",
  {
    title: "Play a demo",
    description:
      "Run `playdemo` to play back a recorded .lmp demo. (Recording is via the -record launch arg, not a console command.)",
    inputSchema: { instance: instanceArg, name: z.string().min(1) },
  },
  async ({ instance, name }) => {
    const client = await clientFor(instance);
    const out = (await client.runCommand(command("playdemo", name))).join("\n");
    return { content: [{ type: "text", text: out.trim() || "(playing)" }] };
  },
);

// --- live player / target state ---------------------------------------------
server.registerTool(
  "player_state",
  {
    title: "Player state",
    description: "Run `currentpos` and return the player's position, angle, floor height, sector, and light level.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const state = parsePlayerState(await client.runCommand("currentpos"));
    if (!state) {
      return { isError: true, content: [{ type: "text", text: "no player (not in a level?)" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: { ...state } };
  },
);

server.registerTool(
  "actor_state",
  {
    title: "Actor state (DECORATE)",
    description:
      "Run `dumpactor` and return an actor's live state: class, health, position, current DECORATE state (sprite/frame/tics, e.g. TNT1 A 0), inventory, and (for players) ready weapon + morph status. Defaults to the player; pass a TID for any actor.",
    inputSchema: { instance: instanceArg, tid: z.number().int().min(0).optional() },
  },
  async ({ instance, tid }) => {
    const client = await clientFor(instance);
    const cmd = tid !== undefined ? command("dumpactor", tid) : "dumpactor";
    const state = parseActorState(await client.runCommand(cmd));
    if (state.class === null) {
      return { isError: true, content: [{ type: "text", text: "no actor (not in a level / bad TID?)" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: { ...state } };
  },
);

server.registerTool(
  "read_hud",
  {
    title: "Read on-screen HUD",
    description:
      "Run `dumphud` and return everything the engine painted last frame: HUD text strings (with screen x/y), images (by texture name + position), and active ACS HUD messages (full composed text, layer, position, remaining tics). Captures menus too.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const hud = parseHud(await client.runCommand("dumphud"));
    return {
      content: [
        {
          type: "text",
          text: `${hud.text.length} strings, ${hud.images.length} images, ${hud.messages.length} hud messages`,
        },
      ],
      structuredContent: { ...hud },
    };
  },
);

server.registerTool(
  "actors_near",
  {
    title: "Actors near the player",
    description:
      "Run `actorsnear` and return actors within a radius (map units, default 512) of the player: class, health, position, and current sprite.",
    inputSchema: { instance: instanceArg, radius: z.number().int().positive().optional() },
  },
  async ({ instance, radius }) => {
    const client = await clientFor(instance);
    const cmd = radius !== undefined ? command("actorsnear", radius) : "actorsnear";
    const actors = parseActorsNear(await client.runCommand(cmd));
    return {
      content: [{ type: "text", text: `${actors.length} actor(s) nearby` }],
      structuredContent: { actors },
    };
  },
);

server.registerTool(
  "inspect_target",
  {
    title: "Inspect aimed target",
    description: "Run `linetarget` and return the actor the player is aiming at (class, health, spawn health).",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const target = parseTarget(await client.runCommand("linetarget"));
    if (!target) {
      return { content: [{ type: "text", text: "no target in view" }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(target) }], structuredContent: { ...target } };
  },
);

// --- ACS scripts / functions / profiling ------------------------------------
server.registerTool(
  "list_scripts",
  {
    title: "List ACS scripts",
    description: "Run `dumpscripts` and return every script across loaded modules (module, number, name, type, arg count).",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const scripts = parseScripts(await client.runCommand("dumpscripts"));
    return {
      content: [{ type: "text", text: `${scripts.length} script(s)` }],
      structuredContent: { scripts },
    };
  },
);

server.registerTool(
  "list_functions",
  {
    title: "List ACS functions",
    description: "Run `dumpfunctions` and return named ACS functions across loaded modules.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const functions = parseFunctions(await client.runCommand("dumpfunctions"));
    return {
      content: [{ type: "text", text: `${functions.length} function(s)` }],
      structuredContent: { functions },
    };
  },
);

server.registerTool(
  "profile_scripts",
  {
    title: "Profile ACS scripts",
    description: "Run `acsprofile` and return per-script/function execution stats (total instructions, runs, avg/min/max).",
    inputSchema: {
      instance: instanceArg,
      sort: z.enum(["total", "avg", "min", "max", "runs"]).optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async ({ instance, sort, limit }) => {
    const client = await clientFor(instance);
    const cmd = sort
      ? command("acsprofile", sort, ...(limit !== undefined ? [limit] : []))
      : "acsprofile";
    const entries = parseAcsProfile(await client.runCommand(cmd));
    return {
      content: [{ type: "text", text: `${entries.length} profiled` }],
      structuredContent: { entries },
    };
  },
);

server.registerTool(
  "profile_window",
  {
    title: "Profile a time window",
    description:
      "Clear ACS profiling, wait N seconds, then return what ran during that window — `what's hot right now` rather than cumulative since map start.",
    inputSchema: {
      instance: instanceArg,
      seconds: z.number().int().min(1).max(30).default(3),
      sort: z.enum(["total", "avg", "min", "max", "runs"]).optional(),
      limit: z.number().int().positive().optional(),
    },
  },
  async ({ instance, seconds, sort, limit }) => {
    const client = await clientFor(instance);
    await client.runCommand("acsprofile clear");
    await sleep(seconds * 1000);
    const cmd = sort
      ? command("acsprofile", sort, ...(limit !== undefined ? [limit] : []))
      : "acsprofile";
    const entries = parseAcsProfile(await client.runCommand(cmd));
    return {
      content: [{ type: "text", text: `${entries.length} profiled over ${seconds}s` }],
      structuredContent: { entries },
    };
  },
);

// --- map-scope ACS variables/arrays (by name, across loaded modules) --------
const acsName = z.string().min(1);

server.registerTool(
  "list_modules",
  {
    title: "List loaded ACS modules",
    description: "Run `dumpmodules` and return the loaded ACS modules (id + name). Map vars live only while a map is loaded.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const client = await clientFor(instance);
    const modules = parseModules(await client.runCommand("dumpmodules"));
    return {
      content: [{ type: "text", text: `${modules.length} module(s)` }],
      structuredContent: { modules },
    };
  },
);

server.registerTool(
  "get_map_var",
  {
    title: "Get map variable",
    description: "Read a map-scope ACS variable by name (searched across loaded modules).",
    inputSchema: { instance: instanceArg, name: acsName },
  },
  async ({ instance, name }) => {
    const client = await clientFor(instance);
    const value = parseMapVar(await client.runCommand(command("getmapvar", name)));
    if (value === null) {
      return { isError: true, content: [{ type: "text", text: `map var '${name}' not found` }] };
    }
    return { content: [{ type: "text", text: String(value) }], structuredContent: { name, value } };
  },
);

server.registerTool(
  "set_map_var",
  {
    title: "Set map variable",
    description: "Write a map-scope ACS variable by name.",
    inputSchema: { instance: instanceArg, name: acsName, value: z.number().int() },
  },
  async ({ instance, name, value }) => {
    const client = await clientFor(instance);
    const result = parseMapVar(await client.runCommand(command("setmapvar", name, value)));
    if (result === null) {
      return { isError: true, content: [{ type: "text", text: `map var '${name}' not found` }] };
    }
    return { content: [{ type: "text", text: `${name} = ${result}` }], structuredContent: { name, value: result } };
  },
);

server.registerTool(
  "get_map_array",
  {
    title: "Get map array element",
    description: "Read one element of a map-scope ACS array by name and index.",
    inputSchema: { instance: instanceArg, name: acsName, index: z.number().int().min(0) },
  },
  async ({ instance, name, index }) => {
    const client = await clientFor(instance);
    const value = parseMapArray(await client.runCommand(command("getmaparray", name, index)));
    if (value === null) {
      return { isError: true, content: [{ type: "text", text: `map array '${name}' not found` }] };
    }
    return { content: [{ type: "text", text: String(value) }], structuredContent: { name, index, value } };
  },
);

server.registerTool(
  "set_map_array",
  {
    title: "Set map array element",
    description: "Write one element of a map-scope ACS array by name and index.",
    inputSchema: { instance: instanceArg, name: acsName, index: z.number().int().min(0), value: z.number().int() },
  },
  async ({ instance, name, index, value }) => {
    const client = await clientFor(instance);
    const result = parseMapArray(await client.runCommand(command("setmaparray", name, index, value)));
    if (result === null) {
      return { isError: true, content: [{ type: "text", text: `map array '${name}' not found` }] };
    }
    return { content: [{ type: "text", text: `${name}[${index}] = ${result}` }], structuredContent: { name, index, value: result } };
  },
);

// --- renderer / UI inspection (read-only) ----------------------------------
async function renderInfo(instance: number) {
  const client = await clientFor(instance);
  return parseRenderInfo(await client.runCommand("dumprenderer"));
}

server.registerTool(
  "renderer_info",
  {
    title: "Renderer info",
    description: "Active backend (software/opengl), GL vendor/shader model, resolution, fullscreen/vsync.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const info = pick(await renderInfo(instance), [
      "renderer", "gl_vendor", "gl_shadermodel", "gl_maxtexsize",
      "screen_width", "screen_height",
      "vid_renderer", "fullscreen", "vid_vsync", "vid_defwidth", "vid_defheight",
    ]);
    return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
  },
);

server.registerTool(
  "viewport_info",
  {
    title: "Viewport info",
    description: "The 3D view window rect (x/y/width/height) and screenblocks size.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const info = pick(await renderInfo(instance), [
      "view_x", "view_y", "view_width", "view_height", "screenblocks",
    ]);
    return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
  },
);

server.registerTool(
  "hud_info",
  {
    title: "HUD info",
    description: "Status bar Y position, status bar / HUD scale, alt HUD, crosshair.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    const info = pick(await renderInfo(instance), [
      "statusbar_y", "st_scale", "hud_scale", "hud_althud", "crosshair",
    ]);
    return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
  },
);

const mapFileArg = z.string().optional();

server.registerTool(
  "map_info",
  {
    title: "Map info",
    description:
      "Read a map from a WAD and return its format (doom/hexen/udmf) and entity counts. Reads the file directly — the game need not be running.",
    inputSchema: { map: z.string().min(1), file: mapFileArg },
  },
  async ({ map, file }) => {
    const data = loadMap(file, map);
    const info = {
      format: data.format,
      sectors: data.sectors.length,
      linedefs: data.linedefs.length,
      sidedefs: data.sidedefs.length,
      vertices: data.vertices.length,
    };
    return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
  },
);

server.registerTool(
  "get_sector",
  {
    title: "Get sector",
    description: "Return one sector's properties by index (all fields, format-native keys).",
    inputSchema: { map: z.string().min(1), index: z.number().int().min(0), file: mapFileArg },
  },
  async ({ map, index, file }) => {
    const data = loadMap(file, map);
    const sector = data.sectors[index];
    if (!sector) {
      return { isError: true, content: [{ type: "text", text: `No sector ${index} (map has ${data.sectors.length}).` }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(sector) }], structuredContent: { sector } };
  },
);

server.registerTool(
  "get_linedef",
  {
    title: "Get linedef",
    description:
      "Return one linedef by index, with its referenced sidedefs (textures + offsets) resolved.",
    inputSchema: { map: z.string().min(1), index: z.number().int().min(0), file: mapFileArg },
  },
  async ({ map, index, file }) => {
    const data = loadMap(file, map);
    const line = data.linedefs[index];
    if (!line) {
      return { isError: true, content: [{ type: "text", text: `No linedef ${index} (map has ${data.linedefs.length}).` }] };
    }
    const sides = ["front", "back", "sidefront", "sideback"]
      .map((k) => line[k])
      .filter((v): v is number => typeof v === "number" && v >= 0)
      .map((i) => data.sidedefs[i])
      .filter(Boolean);
    const result = { line, sides };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  },
);

server.registerTool(
  "find_sectors_by_tag",
  {
    title: "Find sectors by tag",
    description: "Return all sectors whose tag/id matches (binary `tag` or UDMF `id`).",
    inputSchema: { map: z.string().min(1), tag: z.number().int(), file: mapFileArg },
  },
  async ({ map, tag, file }) => {
    const data = loadMap(file, map);
    const sectors = data.sectors.filter((s) => s.tag === tag || s.id === tag);
    return {
      content: [{ type: "text", text: `${sectors.length} sector(s) with tag ${tag}` }],
      structuredContent: { sectors },
    };
  },
);

server.registerTool(
  "launch_instance",
  {
    title: "Launch a Zandronum instance",
    description:
      "Spawn a bridge-enabled Zandronum process with the given options and attach to it. Requires ZANDRONUM_EXE to be set.",
    inputSchema: {
      instance: instanceArg,
      iwad: z.string().optional(),
      files: z.array(z.string()).optional(),
      map: z.string().optional(),
      skill: z.number().int().min(1).max(5).optional(),
      fullscreen: z.boolean().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
      extraArgs: z.array(z.string()).optional(),
    },
  },
  async ({ instance, iwad, files, map, skill, fullscreen, width, height, extraArgs }) => {
    if (!ZANDRONUM_EXE) {
      return { isError: true, content: [{ type: "text", text: "Set ZANDRONUM_EXE to the zandronum binary path (zandronum.exe on Windows, ./zandronum on Linux/macOS) to launch instances." }] };
    }
    if (!existsSync(ZANDRONUM_EXE)) {
      return { isError: true, content: [{ type: "text", text: `ZANDRONUM_EXE not found at ${ZANDRONUM_EXE} — check the path.` }] };
    }
    if (!hasBridge(ZANDRONUM_EXE)) {
      return { isError: true, content: [{ type: "text", text: `ZANDRONUM_EXE at ${ZANDRONUM_EXE} has no MCP bridge — that looks like a stock Zandronum (or GZDoom), which the MCP can't drive. Point it at a bridge-patched build: download one from the GitHub Releases, or build it yourself (see docs/ADVANCED.md).` }] };
    }
    const port = portFor(instance);
    await registry.launch(
      {
        id: instance,
        exe: ZANDRONUM_EXE,
        cwd: path.dirname(ZANDRONUM_EXE),
        port,
        iwad,
        files,
        map,
        skill,
        fullscreen,
        width,
        height,
        extraArgs,
      },
      defaultLaunchIo,
    );
    return { content: [{ type: "text", text: `launched instance ${instance} on bridge port ${port}` }] };
  },
);

server.registerTool(
  "kill_instance",
  {
    title: "Kill a Zandronum instance",
    description: "Stop a launched instance's process and detach from it.",
    inputSchema: { instance: instanceArg },
  },
  async ({ instance }) => {
    registry.kill(instance);
    return { content: [{ type: "text", text: `killed instance ${instance}` }] };
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; logs go to stderr.
  process.stderr.write(`zandronum-mcp ready (bridge ${DEFAULT_HOST}:${BASE_PORT}+)\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
