import { describe, it, expect } from "vitest";
import { parseStatus } from "../src/parsers/status.js";
import { parsePlayerState, parseTarget } from "../src/parsers/playerstate.js";
import { parseActorState, parseActorsNear, parseFindActors } from "../src/parsers/actorstate.js";
import { firstError, hasHeader, parseKvLines } from "../src/parsers/lines.js";
import { isCorrelatorLine } from "../src/correlation/sentinel.js";
import { parseRenderInfo } from "../src/parsers/renderinfo.js";
import { parseMapArray, parseMapSlot, parseMapSlotNoMatch, parseMapVar, parseModules } from "../src/parsers/mapvars.js";
import { parseFunctions, parseScripts } from "../src/parsers/scripts.js";
import { parseAcsVars } from "../src/parsers/acsvars.js";
import { parseScriptStat } from "../src/parsers/scriptstat.js";
import { parseAcsProfile } from "../src/parsers/acsprofile.js";
import { parseHud } from "../src/parsers/hud.js";
import { parseRunAcs, parseRunScript, scriptOutput } from "../src/parsers/runacs.js";
import { parseInputArmed, parseInputStatus, parseInputTrail, type InputRow } from "../src/parsers/input.js";
import { splitLog } from "../src/input/timeline.js";
import { parseMarks } from "../src/parsers/marks.js";
import { parseRecArmed, parseRecFile, parseRecStatus, parseRecWrote } from "../src/parsers/rec.js";
import { DEFAULT_REC_FIELDS } from "../src/recorder/record.js";
import { parseClockStatus, type ClockStatus } from "../src/parsers/clock.js";
import { parseCheckpoint, type Checkpoint } from "../src/parsers/checkpoint.js";
import { ENGINES, engineFixture, type Engine } from "./fakes/fixtures.js";

// The PROTOCOL.md contract, checked against one real captured reply per CCMD from each engine in ENGINES.
const capture = (engine: Engine, name: string): string[] => engineFixture(engine, `${name}.txt`);

const status = (lines: string[]) => parseStatus(lines[0], lines[0].split(" ")[0]);
// Keep wire fields that the host's clock status parser intentionally omits.
const clockStatus = (lines: string[]) => ({ clock: parseClockStatus(lines)!, raw: parseKvLines(lines, "MCP_CLOCK")[0] });

/** Every row kind of a dumped recording (PROTOCOL.md, Per-tic recorder). */
const REC_KINDS = ["seen", "spawn", "sample", "destroy", "state", "damage", "death", "script_start", "script_end", "var"];

/** A value's structure: key names and value types, never the values themselves. */
function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return [...new Set(v.map((x) => JSON.stringify(shapeOf(x))))].sort();
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]),
    );
  }
  return typeof v;
}

/** `v` with every key in `drop` removed at any depth. */
function without(v: unknown, drop: string[]): unknown {
  if (Array.isArray(v)) return v.map((x) => without(x, drop));
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v).filter(([k]) => !drop.includes(k)).map(([k, x]) => [k, without(x, drop)]),
  );
}

/** Whether `key` appears anywhere in `v`. */
function hasKey(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKey(x, key));
  if (v === null || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => k === key || hasKey(x, key));
}

interface Contract<T> {
  /** Capture file name (without `.txt`). */
  capture: string;
  parse(lines: string[]): T;
  /** The header line the host gates on (`hasHeader`), when the reply has one. */
  header?: string;
  /** Fixed facts about the reply, asserted for each engine. */
  expect(parsed: T, engine: Engine): void;
  /** Fields only that engine prints: each must stay present there and absent elsewhere. */
  only?: Partial<Record<Engine, string[]>>;
  /** Fields engines print with different value types, left out of the shape check; `expect` pins each side. */
  retyped?: string[];
}

// Types each `expect` by its parser's result; the list itself holds them as `unknown`.
const contract = <T>(c: Contract<T>): Contract<unknown> => c as Contract<unknown>;

const CONTRACT: Contract<unknown>[] = [
  contract({
    capture: "status",
    parse: status,
    expect: (s) => expect(s).toMatchObject({ gamestate: "level", player: "alive", pending: "0", acstemp: "0", health: "100" }),
  }),
  contract({
    capture: "status_acstemp",
    parse: status,
    expect: (s) => expect(s).toMatchObject({ pending: "0", acstemp: "1" }),
  }),
  contract({
    capture: "currentpos",
    parse: parsePlayerState,
    expect: (p) => expect(p).toMatchObject({ x: -800, y: 700, z: 8, angle: 90, floorHeight: 8, sector: 11, light: 224 }),
  }),
  contract({
    capture: "spawnat",
    parse: (l) => parseKvLines(l, "spawned"),
    expect: ([s]) => expect(s).toMatchObject({ class: "DoomImp", hp: 60, x: -800, y: 828, flags: "mso" }),
  }),
  contract({
    capture: "spawnat_find",
    parse: (l) => parseKvLines(l, "spawned"),
    expect: ([s]) => {
      expect(s).toMatchObject({ class: "DoomImp", hp: 60, flags: "mso" });
      expect(s.moved).toBeGreaterThan(0);
      expect(s.moved).toBeLessThanOrEqual(128);
    },
  }),
  contract({
    capture: "setview",
    parse: (l) => parseKvLines(l, "view"),
    expect: ([v]) => expect(v).toMatchObject({ angle: 90, class: "DoomImp" }),
  }),
  contract({
    capture: "linetarget",
    parse: parseTarget,
    expect: (t) => expect(t).toEqual({ target: "DoomImp", health: 60, spawnHealth: 60 }),
  }),
  contract({
    capture: "dumpactor_player",
    header: "MCP_ACTOR",
    parse: parseActorState,
    expect: (a) => {
      expect(a).toMatchObject({ class: "DoomPlayer", health: 100, weapon: "Pistol", morphTics: 0 });
      expect(a.state).toMatchObject({ id: "DoomPlayer.0", label: "Spawn" });
      expect(a.inventory).toContainEqual({ class: "Clip", amount: 50, maxAmount: 200 });
      expect(a.player).toMatchObject({ input: { buttons: [] }, modInput: { buttons: [] }, refire: 0 });
      expect(a.player!.psprites).toContainEqual(expect.objectContaining({ layer: "weapon", id: "Pistol.0", label: "Ready" }));
    },
  }),
  contract({
    capture: "dumpactor_tid",
    header: "MCP_ACTOR",
    parse: parseActorState,
    expect: (a) =>
      expect(a).toMatchObject({
        class: "DoomImp",
        health: 60,
        pos: { x: -800, y: 828, z: 8 },
        state: { id: "DoomImp.0", label: "Spawn" },
      }),
  }),
  contract({
    capture: "dumpactor_firing",
    header: "MCP_ACTOR",
    parse: parseActorState,
    expect: (a) => {
      expect(a.player!.input!.buttons).toContain("attack");
      expect(a.player!.psprites).toContainEqual(
        expect.objectContaining({ layer: "weapon", id: expect.any(String), label: expect.any(String) }),
      );
    },
  }),
  contract({
    capture: "dumpactor_missing",
    header: "MCP_ACTOR",
    parse: (l) => ({ lines: l, actor: parseActorState(l) }),
    expect: ({ lines, actor }) => {
      expect(lines).toEqual(["MCP_ACTOR", "actor none"]);
      expect(actor).toMatchObject({ class: null, health: null, inventory: [] });
    },
  }),
  contract({
    capture: "actorsnear",
    header: "MCP_ACTORS",
    parse: parseActorsNear,
    expect: (a) => expect(a).toContainEqual(expect.objectContaining({ class: "DoomImp", health: 60, x: -800, y: 828 })),
  }),
  contract({
    capture: "findactors",
    header: "MCP_FOUND",
    parse: parseFindActors,
    expect: (f) => {
      expect(f.actors).toHaveLength(8);
      expect(f.actors[0]).toMatchObject({ class: "DoomImp", dist: 128, flags: "monster,shootable,solid" });
    },
  }),
  contract({
    capture: "findactors_tid",
    header: "MCP_FOUND",
    parse: parseFindActors,
    expect: (f) => expect(f.actors).toEqual([expect.objectContaining({ class: "DoomImp", dist: 128, index: 0 })]),
  }),
  contract({
    capture: "setprop_write",
    parse: (l) => parseKvLines(l, "setprop"),
    expect: ([p]) => expect(p).toMatchObject({ prop: "health", old: 60, new: 50, hp: 50, class: "DoomImp" }),
  }),
  contract({
    capture: "setprop_read",
    parse: (l) => parseKvLines(l, "setprop"),
    expect: ([p]) => {
      expect(p).toMatchObject({ prop: "speed", old: 8 });
      expect(p).not.toHaveProperty("new");
    },
  }),
  contract({
    capture: "setprop_error",
    parse: firstError,
    expect: (e) => expect(e).toBe("no actor with tid 9999 index 0"),
  }),
  contract({
    capture: "place",
    parse: (l) => parseKvLines(l, "placed"),
    expect: ([p]) => {
      expect(p).toMatchObject({ class: "DoomImp", vx: 0, vy: 0, vz: 0 });
      expect([p.x, p.y]).not.toEqual([p.fromx, p.fromy]);
    },
  }),
  contract({
    capture: "place_error",
    parse: firstError,
    expect: (e) => expect(e).toBe("no actor with tid 9999 index 0"),
  }),
  contract({
    capture: "damage",
    parse: (l) => parseKvLines(l, "damaged"),
    expect: ([d]) => expect(d).toMatchObject({ class: "DoomImp", dealt: 10, hp: Number(d.oldhp) - 10, type: "None" }),
  }),
  contract({
    capture: "damage_error",
    parse: firstError,
    expect: (e) => expect(e).toBe("no source actor with tid 9999"),
  }),
  contract({
    capture: "inv_give",
    parse: (l) => parseKvLines(l, "inv"),
    expect: ([i]) => expect(i).toMatchObject({ op: "give", item: "Clip", held: "Clip", after: Number(i.before) + 5, tid: 0 }),
  }),
  contract({
    capture: "inv_take",
    parse: (l) => parseKvLines(l, "inv"),
    expect: ([i]) => expect(i).toMatchObject({ op: "take", item: "Clip", held: "Clip", after: Number(i.before) - 5, tid: 0 }),
  }),
  contract({
    capture: "inv_error",
    parse: firstError,
    expect: (e) => expect(e).toBe("not an inventory class NoSuchItem"),
  }),
  contract({
    capture: "remove",
    parse: (l) => ({ removed: parseKvLines(l, "removed"), total: parseKvLines(l, "removed_total") }),
    expect: ({ removed, total }) => {
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ class: "DoomImp" });
      expect(total).toEqual([{ count: 1 }]);
    },
  }),
  contract({
    capture: "remove_error",
    parse: firstError,
    expect: (e) => expect(e).toBe("no actor with tid 9999"),
  }),
  contract({
    capture: "dumpplayers",
    header: "MCP_PLAYERS",
    parse: (l) => parseKvLines(l, "player"),
    expect: ([p]) => expect(p).toMatchObject({ slot: 0, bot: 0, host: 1, state: "live", hp: 100, weapon: "Pistol", name: "player" }),
    only: { zandronum: ["spec", "deadspec", "deaths", "points", "wins", "ping"] },
  }),
  contract({
    capture: "dumprenderer",
    header: "MCP_RENDERER",
    parse: parseRenderInfo,
    expect: (r) => {
      expect(r).toMatchObject({ renderer: expect.any(String), screenblocks: expect.any(Number) });
      // Zandronum's st_scale/hud_scale are bool cvars.
      for (const k of ["st_scale", "hud_scale"]) expect(typeof r[k]).toBe("string");
    },
    only: { zandronum: ["gl_vendor", "gl_shadermodel", "gl_maxtexsize", "vid_renderer", "fullscreen"] },
  }),
  contract({
    capture: "dumpmodules",
    header: "MCP_MODULES",
    parse: parseModules,
    expect: (m) => expect(m).toEqual([{ id: 0, name: "MCPCONF" }]),
  }),
  contract({
    capture: "dumpscripts",
    header: "MCP_SCRIPTS",
    parse: parseScripts,
    expect: (s) => {
      expect(s.map((x: { name: string | null }) => x.name)).toEqual(["ConfLoop", "ConfHud", null]);
      expect(s[2]).toMatchObject({ module: 0, number: 901, args: 1 });
    },
  }),
  contract({
    capture: "dumpfunctions",
    header: "MCP_FUNCTIONS",
    parse: parseFunctions,
    expect: (f) => expect(f).toEqual([{ module: 0, index: 0, name: "confadd" }]),
  }),
  contract({ capture: "getmapvar", parse: parseMapVar, expect: (v) => expect(v).toBe(42) }),
  contract({ capture: "setmapvar", parse: parseMapVar, expect: (v) => expect(v).toBe(43) }),
  contract({
    capture: "getmapvar_missing",
    parse: (l) => ({ lines: l, value: parseMapVar(l) }),
    expect: (v) => expect(v).toEqual({ lines: ["mapvar NoSuchVar not found"], value: null }),
  }),
  contract({ capture: "getmaparray", parse: parseMapArray, expect: (v) => expect(v).toBe(33) }),
  contract({ capture: "setmaparray", parse: parseMapArray, expect: (v) => expect(v).toBe(5) }),
  contract({
    capture: "getmaparray_missing",
    parse: (l) => ({ lines: l, value: parseMapArray(l) }),
    expect: (v) => expect(v).toEqual({ lines: ["maparray NoSuchArr not found"], value: null }),
  }),
  // test/fixtures/mapslot/res: hidden ms_hid (slot 4) and mn_hid_pts[1].y (slot 6, element 11).
  contract({
    capture: "mapslot_get",
    parse: parseMapSlot,
    expect: (m) => expect(m).toMatchObject({ slot: 4, value: 103, name: "MAPSLOT" }),
  }),
  contract({
    capture: "mapslot_set",
    parse: parseMapSlot,
    expect: (m) => expect(m).toMatchObject({ slot: 4, value: 107, name: "MAPSLOT" }),
  }),
  contract({
    capture: "mapslot_array",
    parse: parseMapSlot,
    expect: (m) => expect(m).toMatchObject({ slot: 6, index: 11, value: 205, name: "MAPSLOTN" }),
  }),
  contract({
    capture: "mapslot_nomatch",
    parse: parseMapSlotNoMatch,
    expect: (e) => expect(e).toMatchObject({ map: "MAP01", modules: expect.any(Number) }),
  }),
  contract({
    capture: "getacsvar",
    parse: parseAcsVars,
    expect: (v) => expect(v).toEqual([{ scope: "world", index: 1, value: 7 }]),
  }),
  contract({
    capture: "setacsvar",
    parse: parseAcsVars,
    expect: (v) => expect(v).toEqual([{ scope: "global", index: 2, value: 10 }]),
  }),
  contract({
    capture: "dumpacsvars",
    header: "MCP_ACSVARS",
    parse: parseAcsVars,
    expect: (v) =>
      expect(v).toEqual([
        { scope: "world", index: 1, value: 7 },
        { scope: "global", index: 2, value: 10 },
      ]),
  }),
  contract({
    capture: "scriptstat",
    parse: parseScriptStat,
    expect: (s) => expect(s).toEqual([{ number: null, name: "ConfLoop", state: "Delayed" }]),
  }),
  contract({
    capture: "acsprofile",
    parse: parseAcsProfile,
    expect: (rows) =>
      expect(rows.map((p: { section: string; name: string }) => [p.section, p.name])).toEqual([
        ["script", '"ConfLoop"'],
        ["script", "901"],
        ["function", "confadd"],
      ]),
  }),
  contract({
    capture: "acsprofile_sorted",
    parse: parseAcsProfile,
    expect: (rows) => {
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ section: "function", module: "MCPCONF", name: "confadd", runs: 1 });
    },
  }),
  contract({
    // A limit <= 0 prints `All scripts:`/`All functions:` instead of `Top <n> ...:`, over the same rows.
    capture: "acsprofile_all",
    parse: parseAcsProfile,
    expect: (rows, e) => {
      expect(capture(e, "acsprofile_all").filter((l) => /All (scripts|functions):$/.test(l))).toHaveLength(2);
      expect(rows.map((p: { section: string; module: string; name: string }) => [p.section, p.module, p.name])).toEqual([
        ["script", "MCPCONF", '"ConfLoop"'],
        ["script", "MCPCONF", "901"],
        ["function", "MCPCONF", "confadd"],
      ]);
      expect(rows[1]).toMatchObject({ total: 9, runs: 1 });
    },
  }),
  contract({
    capture: "dumphud",
    header: "MCP_HUD",
    parse: parseHud,
    expect: (h) => {
      const correlators = h.text.some((t: { text: string }) => isCorrelatorLine(t.text));
      expect(correlators).toBe(false);
      expect(h.messages).toEqual([expect.objectContaining({ left: 0.5, top: 0.25, text: "conformance hud" })]);
      expect(h.text).toContainEqual(expect.objectContaining({ text: "conformance hud" }));
      // The capture's step left the game paused.
      expect(h.images).toContainEqual(expect.objectContaining({ name: "M_PAUSE" }));
    },
  }),
  contract({
    capture: "runacs",
    parse: parseRunAcs,
    expect: (r) => expect(r).toEqual({ module: 1, scripts: 1, started: "ConfProbe", deferred: false }),
  }),
  contract({
    capture: "runscript",
    parse: (l) => ({ reply: parseRunScript(l), printed: scriptOutput(l, "MCP_RUNSCRIPT").printed }),
    expect: (r) =>
      // result 42 is the probe's SetResultValue(a * 6), not the engine default of 1; module 1
      // is the snippet `runacs` loaded.
      expect(r).toEqual({
        reply: { script: "ConfProbe", started: true, result: 42, finished: true, module: 1 },
        printed: ["ConfProbe 7"],
      }),
  }),
  contract({
    capture: "pointinfo",
    header: "MCP_POINT",
    parse: (l) => ({ point: parseKvLines(l, "point")[0], fit: parseKvLines(l, "fit")[0] }),
    expect: ({ point, fit }) => {
      expect(point.sector).toEqual(expect.any(Number));
      // Zandronum prints inmap only with GL nodes, so its capture runs on the OpenGL renderer.
      expect(point.inmap).toBe(1);
      expect(fit.ok).toBe(1);
    },
  }),
  contract({
    capture: "checksight",
    header: "MCP_SIGHT",
    parse: (l) => parseKvLines(l, "sight")[0],
    expect: (s) => expect(s).toMatchObject({ visible: 1, from: "player0" }),
  }),
  contract({
    capture: "tracemove",
    header: "MCP_TRACE",
    parse: (l) => parseKvLines(l, "trace")[0],
    expect: (t) => expect(t).toMatchObject({ ok: 0, reason: "line", line: 334 }),
  }),
  contract({
    capture: "mcp_mark",
    parse: (l) => parseMarks(l.map((text, i) => ({ line: i + 1, text }))),
    expect: (m) => expect(m).toEqual([expect.objectContaining({ n: 1, map: "MAP01", note: "conf note" })]),
  }),
  contract({ capture: "unblock", parse: (l) => l, expect: (l) => expect(l).toEqual(["unblock ok"]) }),
  contract({ capture: "input_clear", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_INPUT cleared"]) }),
  contract({ capture: "input_seg", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_INPUT seg 1 total=5"]) }),
  contract({
    capture: "input_seg_bad",
    parse: firstError,
    expect: (e) =>
      expect(e).toMatch(
        /^unknown button 'nosuch' \(known: attack,altattack,use,jump,crouch,reload,zoom,speed,strafe,turn180,user1,user2,user3,user4\)$/,
      ),
  }),
  contract({
    capture: "input_go_bad",
    parse: firstError,
    expect: (e) => expect(e).toBe("bad timeline: a seg failed, mcp_input clear first"),
  }),
  contract({
    // The run's segment and end markers land in the bridge log after the armed line.
    capture: "input_go",
    parse: (l) => ({ armed: parseInputArmed(l)!, segs: [...splitLog(l).keys()], end: parseKvLines(l, "MCP_INPUT_END")[0] }),
    expect: ({ armed, segs, end }) => {
      expect(armed).toMatchObject({ segs: 2, tics: 5, limit: 5 });
      expect(segs).toEqual([1, 2]);
      expect(end).toEqual({ reason: "done", consumed: 5, maptime: armed.maptime + 5 });
    },
  }),
  contract({
    capture: "input_status",
    parse: (l) => parseInputStatus(l)!,
    expect: (s) =>
      expect(s).toEqual({ active: false, consumed: 5, total: 5, seg: 2, maptime: s.maptime, reason: "done", done: 2, limit: 5, net: false }),
  }),
  contract({
    capture: "input_trail",
    header: "MCP_INPUT_TRAIL",
    parse: parseInputTrail,
    expect: ({ start, rows }: { start: InputRow; rows: InputRow[] }) => {
      expect(start).toMatchObject({ seg: 0, health: 100, buttons: [] });
      // One row per tic, on consecutive map tics from the armed one.
      expect(rows.map((r) => [r.seg, r.maptime - start.maptime, r.buttons])).toEqual([
        [1, 0, []],
        [1, 1, []],
        [1, 2, []],
        [2, 3, ["attack"]],
        [2, 4, ["attack"]],
      ]);
      expect(Math.hypot(rows[2].x - start.x, rows[2].y - start.y)).toBeGreaterThan(1);
    },
  }),
  contract({
    capture: "input_trail_ends",
    header: "MCP_INPUT_TRAIL",
    parse: parseInputTrail,
    expect: ({ rows }: { rows: InputRow[] }) => expect(rows.map((r) => r.seg)).toEqual([1, 2]),
  }),
  contract({ capture: "input_stop", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_INPUT idle"]) }),
  contract({
    capture: "input_walk_bad",
    parse: firstError,
    expect: (e) => expect(e).toBe("target must be pt:x,y, tid:N or class:Name"),
  }),
  contract({
    capture: "input_walk",
    parse: (l) => l,
    expect: (l) => expect(l).toEqual(["MCP_INPUT cleared", "MCP_INPUT walk 1"]),
  }),
  contract({
    // A walk has no nominal tics: the limit defaults to 2100, here passed as 350.
    capture: "input_walk_go",
    parse: (l) => ({ armed: parseInputArmed(l)!, segs: [...splitLog(l).keys()], end: parseKvLines(l, "MCP_INPUT_END")[0] }),
    expect: ({ armed, segs, end }) => {
      expect(armed).toMatchObject({ segs: 1, tics: 0, limit: 350 });
      expect(segs).toEqual([1]);
      expect(end.reason).toBe("done");
      expect(end.consumed).toBeGreaterThan(0);
      expect(end.maptime).toBe(armed.maptime + Number(end.consumed));
    },
  }),
  contract({
    // After the 100-unit walk above: on the point, with the tics its end line counted.
    capture: "input_walk_status",
    parse: (l) => parseInputStatus(l)!,
    expect: (s, engine) => {
      expect(s).toMatchObject({ active: false, total: 0, seg: 1, reason: "done", done: 1, limit: 350, net: false });
      expect(s.target).toEqual({ x: -800, y: 800 });
      expect(s.dist).toBeLessThanOrEqual(0.1);
      expect(s.consumed).toBe(parseKvLines(capture(engine, "input_walk_go"), "MCP_INPUT_END")[0].consumed);
    },
  }),
  contract({
    // A 70-tic run-mode recording: a rocket kills a watched imp, ConfHud runs, world[5] is sampled.
    capture: "rec_file",
    parse: (l) => {
      const f = parseRecFile(l.join("\n"))!;
      return { header: f.header, count: f.rows.length, kinds: Object.fromEntries(REC_KINDS.map((k) => [k, f.rows.find((r) => r.k === k)])) };
    },
    expect: ({ header, count, kinds }, engine) => {
      expect(header).toMatchObject({ map: "MAP01", ran: 70, dropped: 0, reason: "done", fields: [...DEFAULT_REC_FIELDS] });
      expect(count).toBe(header.rows);
      for (const k of REC_KINDS) expect(kinds[k], `a ${k} row`).toBeDefined();
      expect(kinds.damage).toMatchObject({ src: "player0", inf: expect.stringMatching(/^Rocket#/) });
      expect(kinds.script_start).toMatchObject({ script: -1, module: "MCPCONF", act: "player0", name: "ConfHud" });
      expect(kinds.var).toEqual({ t: header.start, k: "var", var: 1, value: 0, name: "world[5]" });
      // The finished status and the dump count the rows the file holds.
      expect(parseRecStatus(capture(engine, "rec_status_done"))?.rows).toBe(header.rows);
      expect(parseRecWrote(capture(engine, "rec_dump"))?.rows).toBe(header.rows);
    },
  }),
  contract({
    capture: "rec_file_player",
    parse: (l) => parseRecFile(l.join("\n"))!,
    expect: ({ header, rows }) => {
      expect(header).toMatchObject({ map: "MAP01", ran: 35, dropped: 0, reason: "done" });
      expect(rows).toHaveLength(header.rows);
      const samples = rows.filter((r) => r.k === "sample");
      expect(samples).toHaveLength(36);
      expect(samples[0]).toMatchObject({ buttons: 0, modbuttons: 0, wclass: "Pistol", wlabel: "Ready" });
      for (const row of samples.slice(1)) {
        expect(row).toMatchObject({ buttons: 1, modbuttons: 1, wclass: "Pistol", wstate: expect.any(String),
          wlabel: expect.any(String), wsprite: "PISG", wframe: expect.any(String), wtics: expect.any(Number) });
      }
      expect(samples.at(-1)!.refire).toBeGreaterThan(0);
      const events = rows.filter((r) => r.k === "psprite");
      expect(events).toContainEqual(expect.objectContaining({ layer: 1, wlabel: "Fire", wtics: 4 }));
      expect(events).toContainEqual(expect.objectContaining({ layer: 1000, wlabel: "Flash", wtics: 7 }));
      expect(events).toContainEqual(expect.objectContaining({ layer: 1000, wstate: "none" }));
      expect(new Set(events.map((r) => `${r.t}:${r.layer}:${r.wstate}`)).size).toBe(events.length);
    },
  }),
  contract({
    capture: "rec_status_done",
    parse: parseRecStatus,
    expect: (s) => expect(s).toMatchObject({ active: false, ran: 70, tics: 70, dropped: 0, untracked: 0, reason: "done" }),
  }),
  contract({ capture: "rec_dump", parse: parseRecWrote, expect: (w) => expect(w).toMatchObject({ dropped: 0 }) }),
  contract({ capture: "rec_stop_idle", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_REC idle"]) }),
  contract({
    capture: "rec_watch_bad",
    parse: firstError,
    expect: (e) => expect(e).toBe("unknown class NoSuchClass"),
  }),
  contract({
    capture: "rec_go_refused",
    parse: firstError,
    expect: (e) => expect(e).toBe("bad setup: a line failed, mcp_rec clear first"),
  }),
  contract({
    capture: "rec_var",
    parse: (l) => parseKvLines(l, "MCP_REC var"),
    expect: (v) => expect(v).toEqual([{ n: 1 }]),
  }),
  contract({
    capture: "rec_var_bad",
    parse: firstError,
    expect: (e) => expect(e).toBe("mapvar NoSuchRecorderVar not found"),
  }),
  contract({
    capture: "rec_go_nothing",
    parse: firstError,
    expect: (e) => expect(e).toBe("nothing to record: add a watch, scripts or a var"),
  }),
  contract({ capture: "rec_clear", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_REC cleared"]) }),
  contract({ capture: "rec_watch", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_REC watch n=1"]) }),
  contract({
    capture: "rec_armed",
    parse: parseRecArmed,
    expect: (a) => expect(a).toMatchObject({ watches: 1, tracked: 1, vars: 1, tics: 500 }),
  }),
  contract({
    // Armed while paused, so no tic has run: baseline actor and variable rows only.
    capture: "rec_status",
    parse: parseRecStatus,
    // The armed watch's baseline rows plus the world[5] var's baseline.
    expect: (s) => expect(s).toMatchObject({ active: true, ran: 0, tics: 500, rows: 3, tracked: 1, reason: "-" }),
  }),
  contract({ capture: "rec_stop", parse: (l) => l, expect: (l) => expect(l).toEqual(["MCP_REC stopped ran=0"]) }),
  contract({ capture: "clock_step_refused", parse: firstError, expect: (e) => expect(e).toBe("not frozen") }),
  contract({ capture: "clock_frametime_refused", parse: firstError, expect: (e) => expect(e).toBe("not frozen") }),
  contract({
    capture: "clock_frametime_on",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: (f) => expect(f).toEqual([{ frametime: 1, framems: 0 }]),
  }),
  contract({
    capture: "clock_frametime_off",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: (f, engine) => expect(f).toEqual([
      { frametime: 0, framems: clockStatus(capture(engine, "clock_status_after")).raw.framems },
    ]),
  }),
  contract({
    capture: "clock_freeze",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: ([f]) => {
      expect(f).toMatchObject({ frozen: 1, restore: 0, jobs: 1 });
      expect(f.maptime).toBeGreaterThan(0);
    },
  }),
  contract({
    // The freeze's own live tic has run and counts as a step.
    capture: "clock_status",
    parse: clockStatus,
    expect: ({ clock, raw }, engine) => {
      expect(clock).toMatchObject({ frozen: true, interp: true, jobs: 0, steps: 1, shots: 0, reason: "done", armedDemo: false });
      expect(raw).toMatchObject({ frametime: 0, framems: 0, armed: 0 });
      expect(clock.maptime).toBe(Number(parseKvLines(capture(engine, "clock_freeze"), "MCP_CLOCK")[0].maptime) + 1);
    },
  }),
  contract({ capture: "clock_step", parse: (l) => parseKvLines(l, "MCP_CLOCK queued"), expect: (q) => expect(q).toEqual([{ jobs: 1 }]) }),
  contract({ capture: "clock_shot", parse: (l) => parseKvLines(l, "MCP_CLOCK queued"), expect: (q) => expect(q).toEqual([{ jobs: 1 }]) }),
  contract({
    // After `step 3` and one shot: exactly 3 more tics.
    capture: "clock_status_after",
    parse: clockStatus,
    expect: ({ clock, raw }, engine) => {
      expect(clock).toMatchObject({ frozen: true, jobs: 0, steps: 4, shots: 1, reason: "done", armedDemo: false });
      expect(raw).toMatchObject({ frametime: 1, armed: 0 });
      expect(Number.isInteger(raw.framems)).toBe(true);
      expect(raw.framems).toBeGreaterThan(0);
      expect(clock.maptime).toBe(parseClockStatus(capture(engine, "clock_status"))!.maptime + 3);
    },
  }),
  contract({
    capture: "clock_stop",
    parse: (l) => parseKvLines(l, "MCP_CLOCK stopped"),
    expect: (r) => expect(r).toEqual([{ dropped: 1 }]),
  }),
  contract({
    capture: "clock_thaw",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: ([t], engine) =>
      expect(t).toEqual({ frozen: 0, maptime: parseClockStatus(capture(engine, "clock_status_after"))!.maptime, paused: 0 }),
  }),
  // The demo_* run (fixtures README): checkpoints and refusals while recording, then the held playback.
  contract({
    capture: "checkpoint",
    parse: parseCheckpoint,
    expect: (c: Checkpoint) => {
      expect(c.maptime).toBeGreaterThan(0);
      expect(c.actors).toBeGreaterThan(0);
      for (const v of [c.rng, c.hash, ...Object.values(c.groups)]) expect(v).toMatch(/^[0-9a-f]{8}$/);
      expect(c.rows).toEqual([]);
    },
  }),
  contract({
    capture: "checkpoint_rows",
    parse: parseCheckpoint,
    expect: (c: Checkpoint) => {
      expect(c.rows).toHaveLength(c.actors);
      expect(c.rows.map((r) => r.i)).toEqual(c.rows.map((_, k) => k));
      expect(c.rows.some((r) => r.class === "DoomPlayer")).toBe(true);
      for (const r of c.rows) {
        expect(r.h).toMatch(/^[0-9a-f]{8}$/);
        expect(r.sprite).toMatch(/^\S{4}$/);
        expect(r.frame).toMatch(/^[A-Z\\[\]^]$/);
      }
    },
  }),
  contract({
    // Held at the demo's first tic: every field replay-stable, so no gametic.
    capture: "checkpoint_demo",
    parse: parseCheckpoint,
    expect: (c: Checkpoint) => expect(c).toMatchObject({ maptime: 1, rows: [] }),
  }),
  contract({
    capture: "input_go_recording",
    parse: firstError,
    expect: (e) => expect(e).toBe("recording: a pause would desync the demo; freeze the clock first"),
  }),
  contract({
    capture: "rec_go_recording",
    parse: firstError,
    expect: (e) => expect(e).toBe("recording: a pause would desync the demo; freeze the clock first"),
  }),
  contract({
    // Frozen over a bridge pause while recording: thaw restores none.
    capture: "clock_freeze_recording",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: ([f]) => expect(f).toMatchObject({ frozen: 1, restore: 1, jobs: 1 }),
  }),
  contract({
    capture: "clock_thaw_recording",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: ([t], engine) =>
      expect(t).toEqual({
        frozen: 0,
        maptime: Number(parseKvLines(capture(engine, "clock_freeze_recording"), "MCP_CLOCK")[0].maptime) + 1,
        paused: 0,
        restore_skipped: "demo",
      }),
  }),
  contract({
    capture: "clock_freeze_demo",
    parse: (l) => l,
    expect: (l) => expect(l).toEqual(["MCP_CLOCK armed=demo frozen=0"]),
  }),
  contract({
    // The engage line, gamelog only, after the tic that started the demo ran its first ticcmd.
    capture: "clock_demo_engaged",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: (e) => expect(e).toEqual([{ frozen: 1, maptime: 1, restore: 0, jobs: 0, armed: "demo" }]),
  }),
  contract({
    // Engaging queues no step and clears the arm.
    capture: "clock_demo_status",
    parse: parseClockStatus,
    expect: (s) => expect(s).toMatchObject({ frozen: true, maptime: 1, jobs: 0, steps: 0, reason: "done", armedDemo: false }),
  }),
  contract({
    // `step 5000` past the end: the tic that read DEM_STOP counts, and the clock stays frozen.
    capture: "clock_demo_end",
    parse: parseClockStatus,
    expect: (s: ClockStatus) => {
      expect(s).toMatchObject({ frozen: true, jobs: 0, reason: "demo_end" });
      expect(s.steps).toBe(s.maptime - 1);
    },
  }),
  contract({
    // Demo over, so a plain thaw.
    capture: "clock_demo_thaw",
    parse: (l) => parseKvLines(l, "MCP_CLOCK"),
    expect: ([t], engine) =>
      expect(t).toEqual({ frozen: 0, maptime: parseClockStatus(capture(engine, "clock_demo_end"))!.maptime, paused: 0 }),
  }),
];

describe("bridge contract (PROTOCOL.md) over the captured replies", () => {
  for (const c of CONTRACT) {
    describe(c.capture, () => {
      const parsed = Object.fromEntries(ENGINES.map((e) => [e, c.parse(capture(e, c.capture))])) as Record<
        Engine,
        unknown
      >;

      for (const e of ENGINES) {
        it(`parses the ${e} reply`, () => {
          if (c.header) expect(hasHeader(capture(e, c.capture), c.header)).toBe(true);
          c.expect(parsed[e], e);
        });
      }

      // Generates no tests until ENGINES lists a second engine.
      const [first, ...rest] = ENGINES;
      for (const e of rest) {
        it(`gives ${e} the same shape as ${first}, engine-only fields aside`, () => {
          const drop = [...Object.values(c.only ?? {}).flat(), ...(c.retyped ?? [])];
          expect(shapeOf(without(parsed[e], drop))).toEqual(shapeOf(without(parsed[first], drop)));
        });
      }

      for (const [e, keys] of Object.entries(c.only ?? {}) as [Engine, string[]][]) {
        it(`still has the ${e}-only fields, and only there`, () => {
          for (const k of keys) {
            expect(hasKey(parsed[e], k), `${e} prints ${k}`).toBe(true);
            for (const other of ENGINES.filter((x) => x !== e)) {
              expect(hasKey(parsed[other], k), `${other} now prints ${k}: drop it from \`only\``).toBe(false);
            }
          }
        });
      }
    });
  }
});
