//
// e2e-smoke.mjs: drive a real bridge-patched engine build through the tool
// surface: launch, hello handshake, run_command round trip, the file-backed tools
// (map_info/get_sector against the IWAD, save/list_saves round trip), the
// stock-CCMD tools (dumpactors, scriptstat, summon/give/take, currentpos/linetarget,
// acsprofile), the overlay tools (actor_state, actors_near, renderer/viewport/hud
// info, read_hud, ACS vars/modules/scripts), the `status` cap, the test-session
// tools (set_cheat, set_view, find_actors, summon_at, ensure_live, step_until), run_acs
// (needs bcc on PATH or <PREFIX>_BCC) and kill.
//
// Engine-neutral: env names and engine expectations come from dist/engine.js, so
// <PREFIX> is that adapter's envPrefix (ZANDRONUM). Not part of `npm test`
// (it needs a real engine and a display). Run it by hand after `npm run build`:
//
//   <PREFIX>_EXE=<bridge-patched build> <PREFIX>_IWAD=<DOOM2.WAD> npm run e2e
//
import { ServerContext, configFromEnv } from "../dist/context.js";
import { registerTools } from "../dist/tools.js";
import { envName } from "../dist/adapter.js";
import { engine } from "../dist/engine.js";
import { writeSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";

const config = configFromEnv(engine, process.env);
const iwad = config.iwad;
if (!config.exe || !iwad) {
  console.error(`set ${envName(engine, "EXE")} and ${envName(engine, "IWAD")}`);
  process.exit(1);
}

// Saves go to a fresh temp dir, so the run stays out of the real save folder and a
// leftover save from an earlier run can't pass the round trip.
const saveDir = mkdtempSync(path.join(tmpdir(), `${engine.serverName}-e2e-saves-`));
const { saveInto } = engine.e2e;
const saveName = (name) => (saveInto === "path" ? path.join(saveDir, name) : name);

// Collect the handlers the same way the MCP server does, without the transport.
// Args go through each tool's input schema, as the SDK does, so its defaults apply.
const handlers = new Map();
const fakeServer = {
  registerTool: (name, config, handler) => {
    const schema = z.object(config.inputSchema ?? {});
    handlers.set(name, (args, extra) => handler(schema.parse(args), extra));
  },
};

const ctx = new ServerContext(engine, { ...config, saveDir });
registerTools(fakeServer, ctx);

const extra = { _meta: {}, sendNotification: () => Promise.resolve() };
const call = (name, args = {}) => handlers.get(name)({ instance: 1, ...args }, extra);
const textOf = (r) => r.content.map((c) => c.text ?? `<${c.type}>`).join(" | ");

// writeSync, not console.log: a piped stdout is buffered, so a hang or a kill
// would swallow every line telling us how far the run got.
const say = (s) => void writeSync(1, `${s}\n`);

let failures = 0;
function check(label, ok, detail) {
  say(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
  if (!ok) failures++;
}

try {
  // Offline (no engine needed): map geometry read straight from the IWAD.
  const mapInfo = await call("map_info", { map: "MAP01", file: iwad });
  check(
    "map_info reads MAP01 from the IWAD",
    !mapInfo.isError && mapInfo.structuredContent?.sectors > 0,
    textOf(mapInfo),
  );

  const sector = await call("get_sector", { map: "MAP01", index: 0, file: iwad });
  check("get_sector returns sector 0", !sector.isError && sector.structuredContent?.sector, textOf(sector));

  const launched = await call("launch_instance", {
    map: "MAP01",
    skill: 2,
    extraArgs: ["-nosound", "-nomusic", ...(saveInto === "path" ? [] : [saveInto.flag, saveDir])],
  });
  check("launch_instance", !launched.isError, textOf(launched));
  if (launched.isError) process.exit(1);

  const client = ctx.attachedClient(1);
  // The bridge is single-client (its accept loop blocks on the first connection),
  // so this reads the hello the launch's own attach already captured. A second
  // connect would sit unanswered in the listen backlog.
  check(`hello reports engine ${engine.id}`, client.engineName === engine.id, String(client.engineName));
  check(
    "caps are cmd/event/time/status",
    ["cmd", "event", "time", "status"].every((c) => client.supports(c)),
    "",
  );

  // gameversion, not "version": not every engine has a "version" CCMD, and an
  // "Unknown command" reply would satisfy a mere "produced some output" assertion.
  const ver = await call("run_command", { text: "gameversion" });
  const verText = textOf(ver);
  check("run_command round trip", !ver.isError && /Commit \S+/.test(verText), verText);

  const echo = await call("run_command", { text: "echo bridge_alive" });
  check("echo correlates", textOf(echo).includes("bridge_alive"), textOf(echo));

  // mcp_status rides every command's correlator sentinel once the bridge
  // advertises the `status` cap, so lastStatus is populated after any command.
  check(
    "mcp_status rides the correlator sentinel",
    client.lastStatus !== undefined && client.lastStatus.gamestate !== undefined,
    JSON.stringify(client.lastStatus),
  );

  // Stock-CCMD tools against the live instance.
  const actors = await call("list_actor_classes");
  check(
    "list_actor_classes returns structured rows",
    !actors.isError && (actors.structuredContent?.actors?.length ?? 0) > 0,
    textOf(actors),
  );

  const scripts = await call("list_running_scripts");
  check("list_running_scripts returns an array (idle map)", !scripts.isError, textOf(scripts));

  const summon = await call("summon", { className: "DoomImp" });
  check("summon accepted", !summon.isError, textOf(summon));
  await call("step", { tics: 5 });

  const target = await call("inspect_target");
  check(
    "inspect_target sees the summoned imp",
    !target.isError && target.structuredContent?.target === "DoomImp",
    textOf(target),
  );

  const gave = await call("give", { item: "Clip", amount: 50 });
  check("give accepted", !gave.isError, textOf(gave));
  const took = await call("take", { item: "Clip", amount: 5 });
  check("take accepted", !took.isError, textOf(took));

  const state = await call("player_state");
  check(
    "player_state reads position and sector",
    !state.isError && typeof state.structuredContent?.sector === "number",
    textOf(state),
  );

  const profile = await call("profile_scripts");
  check("profile_scripts returns an array (idle map)", !profile.isError, textOf(profile));

  // Overlay tools (dumpactor/actorsnear/dumprenderer).
  const actorState = await call("actor_state");
  check(
    "actor_state reads the console player",
    !actorState.isError && actorState.structuredContent?.class != null,
    textOf(actorState),
  );

  const actorsNear = await call("actors_near");
  check(
    "actors_near sees the summoned imp",
    !actorsNear.isError && (actorsNear.structuredContent?.actors?.length ?? 0) > 0,
    textOf(actorsNear),
  );

  const rendererInfo = await call("renderer_info");
  check(
    "renderer_info reports a backend",
    !rendererInfo.isError && typeof rendererInfo.structuredContent?.renderer === "string",
    textOf(rendererInfo),
  );

  const viewportInfo = await call("viewport_info");
  check(
    "viewport_info reports a view rect",
    !viewportInfo.isError && typeof viewportInfo.structuredContent?.view_width === "number",
    textOf(viewportInfo),
  );

  const hudInfo = await call("hud_info");
  check(
    "hud_info reports a status bar Y",
    !hudInfo.isError && typeof hudInfo.structuredContent?.statusbar_y === "number",
    textOf(hudInfo),
  );

  // HUD capture overlay. A live level exercises the text tee (status bar strings, or
  // the console notify lines where the status bar draws glyph by glyph) and the
  // texture tee with no extra setup. The `msg` line kind (HUD messages) needs a
  // loaded BEHAVIOR with a HudMessage-calling script, which vanilla MAP01 lacks.
  const hud = await call("read_hud");
  check(
    "read_hud captures at least one HUD text string",
    !hud.isError && (hud.structuredContent?.text?.length ?? 0) > 0,
    textOf(hud),
  );
  check(
    "read_hud captures at least one HUD image",
    !hud.isError && (hud.structuredContent?.images?.length ?? 0) > 0,
    textOf(hud),
  );

  // ACS internals overlay. World/global vars need no ACS content loaded, so a round
  // trip works on any map. The stock MAP01 has no BEHAVIOR lump, so the map-scope
  // tools are exercised via their not-found path instead of a real value round trip.
  const setVar = await call("set_acs_var", { scope: "world", index: 0, value: 77 });
  check("set_acs_var accepted", !setVar.isError && setVar.structuredContent?.value === 77, textOf(setVar));
  const getVar = await call("get_acs_var", { scope: "world", index: 0 });
  check(
    "get_acs_var reads back the value just set",
    !getVar.isError && getVar.structuredContent?.value === 77,
    textOf(getVar),
  );

  const acsVars = await call("list_acs_vars", { scope: "world" });
  check(
    "list_acs_vars sees the non-zero world var",
    !acsVars.isError && (acsVars.structuredContent?.vars ?? []).some((v) => v.index === 0 && v.value === 77),
    textOf(acsVars),
  );

  const modules = await call("list_modules");
  check("list_modules returns an array", !modules.isError && Array.isArray(modules.structuredContent?.modules), textOf(modules));

  const scriptsList = await call("list_scripts");
  check("list_scripts returns an array", !scriptsList.isError && Array.isArray(scriptsList.structuredContent?.scripts), textOf(scriptsList));

  const functionsList = await call("list_functions");
  check(
    "list_functions returns an array",
    !functionsList.isError && Array.isArray(functionsList.structuredContent?.functions),
    textOf(functionsList),
  );

  const noMapVar = await call("get_map_var", { name: "NoSuchVar" });
  check("get_map_var reports not-found on a vanilla map", noMapVar.isError === true, textOf(noMapVar));

  const noMapArray = await call("get_map_array", { name: "NoSuchArray", index: 0 });
  check("get_map_array reports not-found on a vanilla map", noMapArray.isError === true, textOf(noMapArray));

  // Test-session tools.
  const godOn = await call("set_cheat", { name: "god", on: true });
  check("set_cheat god on", textOf(godOn).startsWith("god on"), textOf(godOn));
  const godAgain = await call("set_cheat", { name: "god", on: true });
  check("set_cheat god on again is a no-op", textOf(godAgain).startsWith("god already on"), textOf(godAgain));
  const godOff = await call("set_cheat", { name: "god", on: false });
  check("set_cheat god off", textOf(godOff).startsWith("god off"), textOf(godOff));
  const notarget = await call("set_cheat", { name: "notarget", on: true });
  check("set_cheat notarget on", !notarget.isError, textOf(notarget));

  // Not 90: MAP01's start already faces 90, which would hide a lost yaw write.
  const view = await call("set_view", { angle: 45, pitch: -10 });
  await call("step", { tics: 2 });
  const viewState = await call("actor_state");
  check(
    "set_view sets angle and pitch, surviving a tic",
    view.structuredContent?.angle === 45 &&
      viewState.structuredContent?.angle === 45 &&
      viewState.structuredContent?.pitch === -10,
    `${textOf(view)} / ${textOf(viewState)}`,
  );

  const players = await call("list_players");
  const p0 = players.structuredContent?.players?.[0];
  check(
    "list_players shows slot 0 as the human player",
    p0?.slot === 0 && p0?.bot === 0,
    textOf(players),
  );

  const imps = await call("find_actors", { class: "DoomImp" });
  check(
    "find_actors finds the summoned imp map-wide",
    !imps.isError && imps.structuredContent?.actors?.length >= 1,
    textOf(imps),
  );
  const faced = await call("set_view", { class: "DoomImp" });
  check("set_view faces the imp", faced.structuredContent?.class === "DoomImp", textOf(faced));

  // summon_at. The spot is a mapper-placed pickup away from the player, so it's
  // walkable and its z is the floor.
  const items = await call("find_actors", { class: "Inventory" });
  const spot = items.structuredContent?.actors?.find((a) => a.dist > 256);
  check("find_actors finds a pickup away from the player", !!spot, textOf(items));
  const placed = await call("summon_at", { className: "DoomImp", x: spot.x, y: spot.y });
  const p = placed.structuredContent ?? {};
  check(
    "summon_at spawns at the requested x/y on the floor, with a tid",
    !placed.isError && p.x === spot.x && p.y === spot.y && p.z === spot.z && p.tid > 0,
    `${textOf(placed)} / spot ${JSON.stringify(spot)}`,
  );
  const byTid = await call("find_actors", { tid: p.tid });
  const hit = byTid.structuredContent?.actors;
  check(
    "find_actors by the returned tid finds exactly that imp",
    hit?.length === 1 && hit[0].class === "DoomImp" && hit[0].x === spot.x && hit[0].y === spot.y,
    textOf(byTid),
  );
  const placedState = await call("actor_state", { tid: p.tid });
  check("actor_state resolves the returned tid", placedState.structuredContent?.class === "DoomImp", textOf(placedState));

  const onPlayer = await call("summon_at", { className: "DoomImp", x: p0.x, y: p0.y });
  check("summon_at on the player is blocked by player0", onPlayer.isError && /blocked by player0/.test(textOf(onPlayer)), textOf(onPlayer));
  const forced = await call("summon_at", { className: "DoomImp", x: p0.x, y: p0.y, force: true });
  check("summon_at force succeeds on the same spot", !forced.isError && forced.structuredContent?.forced === 1, textOf(forced));
  if (engine.e2e.summonAtVoid) {
    const voidSpot = await call("summon_at", { className: "DoomImp", x: 30000, y: 30000 });
    check("summon_at in the void reports outside map", voidSpot.isError && /outside map/.test(textOf(voidSpot)), textOf(voidSpot));
  } else {
    // No void check here, but a point past the fixed-point range is refused (by the schema) rather than wrapped.
    const farSpot = await call("summon_at", { className: "DoomImp", x: 100000, y: 100000 });
    check("summon_at past +-32767 is refused", farSpot.isError && /less than or equal to 32767/.test(textOf(farSpot)), textOf(farSpot));
  }
  const noClass = await call("summon_at", { className: "NoSuchClass", x: spot.x, y: spot.y });
  check("summon_at reports an unknown class", noClass.isError && /unknown class/.test(textOf(noClass)), textOf(noClass));

  await call("run_command", { text: "menu_main" });
  const blocked = await call("ensure_live");
  check(
    "ensure_live reports the open menu",
    blocked.structuredContent?.found?.some((b) => b.startsWith("a menu is open")),
    textOf(blocked),
  );
  const fixed = await call("ensure_live", { fix: true });
  check(
    "ensure_live fix clears it and the sim advances",
    fixed.structuredContent?.live === true && fixed.structuredContent?.remaining?.length === 0,
    textOf(fixed),
  );

  const landed = await call("step_until", {
    condition: { kind: "player", field: "z", op: "==", value: "floorHeight" },
    maxTics: 70,
  });
  check("step_until on a player field", landed.structuredContent?.met === true, textOf(landed));

  const shotFile = await call("screenshot_file", { name: "e2e_shot" });
  const shotPath = shotFile.structuredContent?.path;
  check(
    "screenshot_file leaves a PNG on disk",
    !!shotPath && existsSync(shotPath) && readFileSync(shotPath).subarray(1, 4).toString() === "PNG",
    textOf(shotFile),
  );

  const log = await call("read_log", { pattern: "degreeless" });
  check("read_log sees the god-mode prints", /Degreelessness/i.test(textOf(log)), textOf(log));
  // The engine holds both no-focus hints at window creation. Bare Xvfb can't show
  // the focus outcome (no EWMH WM), only that the hints landed.
  if (engine.e2e.nofocusPattern) {
    const nofocus = await call("read_log", { pattern: engine.e2e.nofocusPattern });
    check(
      "nofocus hints set on window creation",
      /input_hint=0 user_time=0/.test(textOf(nofocus)),
      textOf(nofocus),
    );
  }

  const shot = await call("screenshot");
  const img = shot.content.find((c) => c.type === "image");
  check("screenshot returns PNG bytes", !!img && img.data.length > 1000, `${img?.data.length ?? 0} b64 chars`);

  const errs = await call("get_startup_errors");
  check("get_startup_errors reads the log", !errs.isError, textOf(errs).slice(0, 120));

  const crash = await call("get_crash");
  check("get_crash reports no crash", textOf(crash).toLowerCase().includes("no crash"), textOf(crash));

  // save/list_saves round trip: the stock "save" CCMD through run_command, then
  // list_saves reading the resulting .zds back.
  // The save CCMD only flags a save for the next tic, which never runs while the
  // engine sits paused, so step a few tics to let it land.
  const saved = await call("run_command", { text: `save ${saveName("e2esmoke")}` });
  check("save command accepted", !saved.isError, textOf(saved));
  await call("step", { tics: 5 });

  const saves = await call("list_saves", { dir: saveDir });
  const meta = saves.structuredContent?.saves?.find((s) => s.file === "e2esmoke.zds");
  check(
    "list_saves reads back the save's metadata",
    !saves.isError && meta?.map === "MAP01",
    JSON.stringify(saves.structuredContent),
  );

  // run_acs. Two snippets, so the second's Log() string resolves in module 1, not module 0.
  const first = await call("run_acs", { compiler: "bcc", source: 'script 1 (void) { Log(s:"e2e first"); }', script: 1 });
  check("run_acs loads and runs a snippet in the call", !first.isError && /\ne2e first\n/.test(textOf(first)), textOf(first));
  const second = await call("run_acs", { compiler: "bcc",
    source: 'script 1 (void) { Log(s:"e2e second"); } script 2 (void) { Delay(1); Log(s:"e2e later"); }',
    script: 1,
  });
  check(
    "run_acs loads a second snippet as its own module with its own strings",
    !second.isError && second.structuredContent?.module === first.structuredContent?.module + 1 && /\ne2e second\n/.test(textOf(second)),
    textOf(second),
  );
  const bad = await call("run_acs", { compiler: "bcc", source: "script 1 (void) { Log(s:\"x\") }", script: 1 });
  check("run_acs returns compile errors", bad.isError && /compile failed/.test(textOf(bad)), textOf(bad));
  const refused = await call("save_game", { name: saveName("e2etaint") });
  check("save_game refuses while a snippet is loaded", refused.isError && /run_acs/.test(textOf(refused)), textOf(refused));
  await call("load_map", { mapName: "MAP01" });
  await call("step", { tics: 2 });
  const allowed = await call("save_game", { name: saveName("e2eclean") });
  check("save_game works again after load_map", !allowed.isError, textOf(allowed));

  const killed = await call("kill_instance");
  check("kill_instance", !killed.isError, textOf(killed));
} finally {
  ctx.registry.closeAll();
}

say(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
