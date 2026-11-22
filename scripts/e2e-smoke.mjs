//
// e2e-smoke.mjs: drive a real bridge-patched engine (and display) through the tool surface by hand after
// `npm run build`, with <PREFIX> the dist/engine.js envPrefix and bcc on PATH or in <PREFIX>_BCC:
//
//   <PREFIX>_EXE=<bridge-patched build> <PREFIX>_IWAD=<DOOM2.WAD> npm run e2e
//
import { ServerContext, configFromEnv } from "../dist/context.js";
import { registerTools } from "../dist/tools.js";
import { envName } from "../dist/adapter.js";
import { engine } from "../dist/engine.js";
import { writeSync, mkdtempSync, existsSync, readFileSync, unlinkSync } from "node:fs";
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

// Collect handlers like the MCP server, parsing args through each input schema as the SDK does.
const handlers = new Map();
const fakeServer = {
  registerTool: (name, config, handler) => {
    const schema = z.object(config.inputSchema ?? {});
    handlers.set(name, async (args, extra) => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        const why = parsed.error.issues.map((i) => i.message).join("; ");
        return { content: [{ type: "text", text: `Input validation error: Invalid arguments for tool ${name}: ${why}` }], isError: true };
      }
      // The SDK turns a thrown handler error (e.g. a ToolRefusal) into an error reply.
      try {
        return await handler(parsed.data, extra);
      } catch (e) {
        return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    });
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
// The mcp_mark screenshot this run queued, removed at the end.
let markShot;
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
  // Reuse the launch's attach, since the single-client bridge would leave a second connect unanswered.
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
    "actor_state reads the console player, with a weapon psprite layer",
    !actorState.isError &&
      actorState.structuredContent?.class != null &&
      (actorState.structuredContent?.player?.psprites ?? []).some((p) => p.layer === "weapon"),
    textOf(actorState),
  );

  const mark = await call("run_command", { text: "mcp_mark e2e" });
  check("mcp_mark logs mark 1", !mark.isError && /^MCP_MARK n=1 .*note=e2e$/m.test(textOf(mark)), textOf(mark));
  markShot = textOf(mark).match(/ shot=(\S+)/)?.[1];

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

  // HUD capture overlay, leaving the `msg` kind untested since vanilla MAP01 has no HudMessage script.
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

  // ACS internals overlay, with map-scope tools on their not-found path since MAP01 has no BEHAVIOR lump.
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
    p0?.slot === 0 && p0?.bot === 0 && p0?.host === 1,
    textOf(players),
  );

  const imps = await call("find_actors", { class: "DoomImp" });
  check(
    "find_actors finds the summoned imp map-wide",
    !imps.isError && imps.structuredContent?.actors?.length >= 1,
    textOf(imps),
  );
  const monsters = await call("find_actors", { flags: { monster: true, alive: true } });
  const monsterRows = monsters.structuredContent?.actors ?? [];
  check(
    "find_actors flags lists only live monsters, the imp among them",
    monsterRows.some((a) => a.class === "DoomImp") &&
      monsterRows.every((a) => a.flags.split(",").includes("monster") && a.hp > 0),
    textOf(monsters),
  );
  const faced = await call("set_view", { class: "DoomImp" });
  check("set_view faces the imp", faced.structuredContent?.class === "DoomImp", textOf(faced));

  // summon_at on a mapper-placed pickup, so the spot is walkable and its z is the floor.
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
  const feet = await call("check_sight", { from: { player: 0 }, to: { x: p0.x, y: p0.y } });
  check("check_sight sees a point at the player's feet", !feet.isError && feet.structuredContent?.visible === true, textOf(feet));

  const onPlayer = await call("summon_at", { className: "DoomImp", x: p0.x, y: p0.y });
  check("summon_at on the player is blocked by player0", onPlayer.isError && /blocked by player0/.test(textOf(onPlayer)), textOf(onPlayer));
  const nearPlayer = await call("summon_at", { className: "DoomImp", x: p0.x, y: p0.y, findSpot: 128 });
  const movedBy = nearPlayer.structuredContent?.moved;
  // The search is its own bridge cap: an overlay without it gets the host's refusal instead.
  if (client.supports("spawnfind")) {
    check("summon_at findSpot moves off the blocked spot", !nearPlayer.isError && movedBy > 0 && movedBy <= 128, textOf(nearPlayer));
  } else {
    check("summon_at findSpot is refused without the spawnfind cap", nearPlayer.isError && /no free-spot search/.test(textOf(nearPlayer)), textOf(nearPlayer));
  }
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

  // set_actor_prop, on the placed imp.
  const prop = (args) => call("set_actor_prop", { tid: p.tid, ...args });
  const speedRead = await prop({ prop: "speed" });
  check(
    "set_actor_prop reads the imp's speed without writing it",
    !speedRead.isError && speedRead.structuredContent?.old === 8 && speedRead.structuredContent?.new === undefined,
    textOf(speedRead),
  );
  const speedSet = await prop({ prop: "speed", value: 20 });
  check(
    "set_actor_prop writes speed 20, reporting old and new",
    speedSet.structuredContent?.old === 8 && speedSet.structuredContent?.new === 20,
    textOf(speedSet),
  );
  const noGravity = await prop({ prop: "flag:NOGRAVITY", value: true });
  const noGravityRead = await prop({ prop: "flag:NOGRAVITY" });
  check(
    "set_actor_prop sets flag:NOGRAVITY and the read form agrees",
    noGravity.structuredContent?.old === 0 && noGravity.structuredContent?.new === 1 && noGravityRead.structuredContent?.old === 1,
    `${textOf(noGravity)} / ${textOf(noGravityRead)}`,
  );
  const alpha = await prop({ prop: "alpha", value: 0.5 });
  check("set_actor_prop writes alpha 0.5", alpha.structuredContent?.new === 0.5, textOf(alpha));
  const afterProps = await call("find_actors", { tid: p.tid });
  check("find_actors still resolves the edited imp", afterProps.structuredContent?.actors?.length === 1, textOf(afterProps));
  const bogusFlag = await prop({ prop: "flag:BOGUS", value: true });
  check("set_actor_prop reports an unknown flag", bogusFlag.isError && /unknown flag/.test(textOf(bogusFlag)), textOf(bogusFlag));

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

  const watched = await call("watch_actors", { tid: p.tid, tics: 10 });
  const watchRows = watched.structuredContent?.table?.rows ?? [];
  check(
    "watch_actors samples the placed imp by tid with rising maptime",
    !watched.isError && watchRows.length > 0 && watchRows.every((r, i) => i === 0 || r[0] > watchRows[i - 1][0]),
    textOf(watched),
  );

  const shotFile = await call("screenshot_file", { name: "e2e_shot" });
  const shotPath = shotFile.structuredContent?.path;
  check(
    "screenshot_file leaves a PNG on disk",
    !!shotPath && existsSync(shotPath) && readFileSync(shotPath).subarray(1, 4).toString() === "PNG",
    textOf(shotFile),
  );

  const log = await call("read_log", { pattern: "degreeless" });
  check("read_log sees the god-mode prints", /Degreelessness/i.test(textOf(log)), textOf(log));
  const logPath = log.structuredContent?.path;
  check("read_log names a log file that exists", !!logPath && existsSync(logPath), textOf(log).split("\n")[0]);
  const counted = await call("read_log", { pattern: "degreeless", count: true });
  check(
    "read_log count matches the lines it returns",
    counted.structuredContent?.count === log.structuredContent?.lines?.length,
    textOf(counted),
  );
  const waited = await call("wait_for_log", { pattern: "degreeless" });
  check("wait_for_log matches a line already printed this launch", waited.structuredContent?.reason === "matched", textOf(waited));
  const timedOut = await call("wait_for_log", { pattern: "e2e_never_printed", timeoutSec: 0.5 });
  check("wait_for_log times out on a line never printed", !timedOut.isError && timedOut.structuredContent?.reason === "timeout", textOf(timedOut));

  // Checks only that the no-focus hints landed, since bare Xvfb has no EWMH WM to show the outcome.
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

  // mcp_mark's shot lands a tic after the mark, long before this.
  const marked = await call("read_marks", { mark: 1 });
  check("read_marks returns mark 1 with its screenshot", marked.content.some((c) => c.type === "image"), textOf(marked));

  const errs = await call("get_startup_errors");
  check("get_startup_errors reads the log", !errs.isError, textOf(errs).slice(0, 120));

  const crash = await call("get_crash");
  check("get_crash reports no crash", textOf(crash).toLowerCase().includes("no crash"), textOf(crash));

  // stepTics lets the save land, since the save CCMD only flags it for a next tic that never runs while paused.
  const saved = await call("run_command", { text: `save ${saveName("e2esmoke")}`, stepTics: 5, logPattern: "game saved" });
  check("save command accepted", !saved.isError, textOf(saved));
  check(
    "run_command stepTics returns the save's later print",
    saved.structuredContent?.log?.some((l) => /game saved/i.test(l)) === true,
    textOf(saved),
  );

  const saves = await call("list_saves", { dir: saveDir });
  const meta = saves.structuredContent?.saves?.find((s) => s.file === "e2esmoke.zds");
  check(
    "list_saves reads back the save's metadata",
    !saves.isError && meta?.map === "MAP01",
    JSON.stringify(saves.structuredContent),
  );

  // Two snippets load, so the second's Log() string must resolve in module 1, not module 0.
  const first = await call("run_acs", { compiler: "bcc", stepTics: 0, source: 'script 1 (void) { Log(s:"e2e first"); }', script: 1 });
  check("run_acs loads and runs a snippet in the call", !first.isError && /\ne2e first\n/.test(textOf(first)), textOf(first));
  const second = await call("run_acs", { compiler: "bcc", stepTics: 0,
    source: 'script 1 (void) { Log(s:"e2e second"); } script 2 (void) { Delay(1); Log(s:"e2e later"); }',
    script: 1,
  });
  check(
    "run_acs loads a second snippet as its own module with its own strings",
    !second.isError && second.structuredContent?.module === first.structuredContent?.module + 1 && /\ne2e second\n/.test(textOf(second)),
    textOf(second),
  );
  // MAP01 line 242 crosses a 32-unit step; use 64 to isolate its player-only blocking flag.
  const blockPlayers = await call("run_acs", {
    compiler: "bcc", source: 'special 55:Line_SetBlocking(3); script "E2eBlockPlayers" (int flags) { Line_SetBlocking(6, flags, 1023 ^ flags); }',
    script: "E2eBlockPlayers", args: [0],
  });
  const stepHeight = await call("set_actor_prop", { prop: "maxstepheight" });
  const oldStep = stepHeight.structuredContent?.old;
  const probeMover = await call("summon_at", { className: "MapSpot", x: 352, y: 672 });
  const probeTid = probeMover.structuredContent?.tid;
  check("player-blocking probe fixture loads", !blockPlayers.isError && typeof oldStep === "number" && !!probeTid,
    `${textOf(blockPlayers)} / ${textOf(stepHeight)} / ${textOf(probeMover)}`);
  if (!blockPlayers.isError && typeof oldStep === "number" && probeTid) {
    const route = { from: { x: 352, y: 672 }, to: { x: 416, y: 672 }, actors: false };
    await call("set_actor_prop", { prop: "maxstepheight", value: 64 });
    await call("set_actor_prop", { tid: probeTid, prop: "maxstepheight", value: 64 });
    await call("set_actor_prop", { tid: probeTid, prop: "maxdropoffheight", value: 64 });
    try {
      for (const mover of [{ player: 0 }, { tid: probeTid }]) {
        const clear = await call("trace_move", { ...route, mover });
        check("unflagged line is clear to the probe mover", clear.structuredContent?.ok === true, textOf(clear));
      }
      await call("run_script", { name: "E2eBlockPlayers", args: [4], always: true });
      const playerTrace = await call("trace_move", { ...route, mover: { player: 0 } });
      const fit = await call("point_info", { x: 384, y: 672, mover: { player: 0 } });
      const monsterTrace = await call("trace_move", { ...route, mover: { tid: probeTid } });
      check("player trace stops at player-only line 242", playerTrace.structuredContent?.ok === false &&
        playerTrace.structuredContent?.reason === "line" && playerTrace.structuredContent?.line === 242, textOf(playerTrace));
      check("player fit stops at player-only line 242", fit.structuredContent?.fit?.ok === false &&
        fit.structuredContent?.fit?.reason === "line" && fit.structuredContent?.fit?.line === 242, textOf(fit));
      check("non-player trace ignores the player-only line", monsterTrace.structuredContent?.ok === true, textOf(monsterTrace));
      // The railing raises the opening 32 more units; leave enough step and ceiling clearance.
      await call("set_actor_prop", { prop: "maxstepheight", value: 96 });
      for (const flags of [65, 96]) {
        await call("run_script", { name: "E2eBlockPlayers", args: [flags], always: true });
        const railingTrace = await call("trace_move", { ...route, mover: { player: 0 } });
        const railingFit = await call("point_info", { x: 384, y: 672, mover: { player: 0 } });
        check("two-sided railing overrides blocking flags for player trace", railingTrace.structuredContent?.ok === true, textOf(railingTrace));
        check("two-sided railing overrides blocking flags for player fit", railingFit.structuredContent?.fit?.ok === true, textOf(railingFit));
      }
    } finally {
      await call("run_script", { name: "E2eBlockPlayers", args: [0], always: true });
      await call("set_actor_prop", { prop: "maxstepheight", value: oldStep });
    }
  }
  const stepped = await call("run_acs", { compiler: "bcc", source: 'script 7 (void) { Delay(1); Log(s:"e2e later"); }', script: 7, stepTics: 3 });
  check("run_acs stepTics returns what the script logged later", stepped.structuredContent?.log?.includes("e2e later"), textOf(stepped));
  const digits = await call("run_acs", { compiler: "bcc", stepTics: 0,
    source: 'script "123" (void) { Log(s:"e2e named"); } script 123 (void) { Log(s:"e2e numbered"); }',
    script: "123",
  });
  // name=1 is its own bridge cap: an overlay without it gets the host's refusal instead.
  if (client.supports("runacsname")) {
    check("run_acs runs a script name made of digits as a name", /\ne2e named\n/.test(textOf(digits)), textOf(digits));
  } else {
    check("run_acs refuses a digits-only name without the runacsname cap", digits.isError && /made of digits/.test(textOf(digits)), textOf(digits));
  }
  const bad = await call("run_acs", { compiler: "bcc", stepTics: 0, source: "script 1 (void) { Log(s:\"x\") }", script: 1 });
  check("run_acs returns compile errors", bad.isError && /compile failed/.test(textOf(bad)), textOf(bad));
  // The snippet loads unstarted, so each script's first run is run_script's own.
  if (client.supports("runscript")) {
    const lib = await call("run_acs", { compiler: "bcc", stepTics: 0,
      source: 'script "E2eAnswer" (void) { SetResultValue(42); } script "E2eLater" (void) { SetResultValue(7); Delay(35); SetResultValue(9); }',
    });
    const answer = await call("run_script", { name: "E2eAnswer" });
    const got = answer.structuredContent;
    check(
      "run_script returns a finished script's SetResultValue and its module",
      !lib.isError && got?.result === 42 && got?.finished === true && got?.module === lib.structuredContent?.module,
      textOf(answer),
    );
    const later = await call("run_script", { name: "E2eLater" });
    check(
      "run_script reports a script paused at a delay as unfinished, with the value so far",
      later.structuredContent?.result === 7 && later.structuredContent?.finished === false,
      textOf(later),
    );
  } else {
    say("SKIP  run_script result value (bridge has no runscript cap)");
  }
  const refused = await call("save_game", { name: saveName("e2etaint") });
  check("save_game refuses while a snippet is loaded", refused.isError && /run_acs/.test(textOf(refused)), textOf(refused));
  await call("load_map", { mapName: "MAP01" });
  await call("step", { tics: 2 });
  const allowed = await call("save_game", { name: saveName("e2eclean") });
  check("save_game works again after load_map", !allowed.isError, textOf(allowed));

  const timedStart = (await call("player_state")).structuredContent;
  const timed = await call("input_timeline", { segments: [{ tics: 5, forward: 1 }] });
  const timedEnd = (await call("player_state")).structuredContent;
  check(
    "input_timeline runs a 5-tic forward segment and the player moves",
    !timed.isError && timed.structuredContent?.reason === "done" && Math.hypot(timedEnd.x - timedStart.x, timedEnd.y - timedStart.y) > 1,
    textOf(timed),
  );

  // Last before the relaunch, which drops the bot again.
  const bot = await call("add_bot");
  const joined = bot.structuredContent?.bots ?? [];
  check("add_bot steps until a bot joins at slot 1+", !bot.isError && joined.length === 1 && joined[0].slot >= 1, textOf(bot));

  const oldPid = ctx.attachedClient(1)?.enginePid;
  const relaunchStart = Date.now();
  const relaunched = await call("relaunch_instance", { map: "MAP01" });
  say(`relaunch took ${Date.now() - relaunchStart} ms`);
  const newPid = ctx.attachedClient(1)?.enginePid;
  check(
    "relaunch_instance starts a new engine",
    !relaunched.isError && newPid !== undefined && newPid !== oldPid,
    `${textOf(relaunched)} (PID ${oldPid} -> ${newPid})`,
  );

  const killed = await call("kill_instance");
  check("kill_instance", !killed.isError, textOf(killed));
} finally {
  ctx.registry.closeAll();
  // mcp_mark keeps its shots by design; drop this run's, or the build dir gains one per run.
  const markPng = markShot && markShot !== "none" ? path.join(config.screenshotDir, `${markShot}.png`) : undefined;
  if (markPng && existsSync(markPng)) unlinkSync(markPng);
}

say(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
