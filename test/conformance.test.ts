import { describe, it, expect } from "vitest";
import { parseStatus } from "../src/parsers/status.js";
import { parsePlayerState, parseTarget } from "../src/parsers/playerstate.js";
import { parseActorState, parseActorsNear, parseFindActors } from "../src/parsers/actorstate.js";
import { hasHeader, parseKvLines } from "../src/parsers/lines.js";
import { parseRenderInfo } from "../src/parsers/renderinfo.js";
import { parseMapArray, parseMapVar, parseModules } from "../src/parsers/mapvars.js";
import { parseFunctions, parseScripts } from "../src/parsers/scripts.js";
import { parseAcsVars } from "../src/parsers/acsvars.js";
import { parseScriptStat } from "../src/parsers/scriptstat.js";
import { parseAcsProfile } from "../src/parsers/acsprofile.js";
import { parseHud } from "../src/parsers/hud.js";
import { parseRunAcs } from "../src/parsers/runacs.js";
import { ENGINES, engineFixture, type Engine } from "./fakes/fixtures.js";

// The PROTOCOL.md contract, checked against one real reply per CCMD from each engine in ENGINES.
// Captures: test/fixtures/<engine>/<name>.txt, recorded per test/fixtures/conformance/README.md.
const capture = (engine: Engine, name: string): string[] => engineFixture(engine, `${name}.txt`);

const status = (lines: string[]) => parseStatus(lines[0], lines[0].split(" ")[0]);

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

interface Contract {
  /** Capture file name (without `.txt`). */
  capture: string;
  parse: (lines: string[]) => unknown;
  /** The header line the host gates on (`hasHeader`), when the reply has one. */
  header?: string;
  /** Fixed facts about the reply, asserted for each engine. */
  expect: (parsed: any, engine: Engine) => void;
  /** Fields only that engine prints: each must stay present there and absent elsewhere. */
  only?: Partial<Record<Engine, string[]>>;
  /** Fields engines print with different value types, left out of the shape check; `expect` pins each side. */
  retyped?: string[];
  /** Engines whose overlay has no such CCMD yet, so no capture: left out until one is recorded. */
  pending?: Engine[];
}

const CONTRACT: Contract[] = [
  {
    capture: "status",
    parse: status,
    expect: (s) => expect(s).toMatchObject({ gamestate: "level", player: "alive", pending: "0", acstemp: "0", health: "100" }),
  },
  {
    capture: "status_acstemp",
    parse: status,
    expect: (s) => expect(s).toMatchObject({ pending: "0", acstemp: "1" }),
  },
  {
    capture: "currentpos",
    parse: parsePlayerState,
    expect: (p) => expect(p).toMatchObject({ x: -800, y: 700, z: 8, angle: 90, floorHeight: 8, sector: 11, light: 224 }),
  },
  {
    capture: "spawnat",
    parse: (l) => parseKvLines(l, "spawned"),
    expect: ([s]) => expect(s).toMatchObject({ class: "DoomImp", hp: 60, x: -800, y: 828, flags: "mso" }),
  },
  {
    capture: "setview",
    parse: (l) => parseKvLines(l, "view"),
    expect: ([v]) => expect(v).toMatchObject({ angle: 90, class: "DoomImp" }),
  },
  {
    capture: "linetarget",
    parse: parseTarget,
    expect: (t) => expect(t).toEqual({ target: "DoomImp", health: 60, spawnHealth: 60 }),
  },
  {
    capture: "dumpactor_player",
    header: "MCP_ACTOR",
    parse: parseActorState,
    expect: (a) => {
      expect(a).toMatchObject({ class: "DoomPlayer", health: 100, weapon: "Pistol", morphTics: 0 });
      expect(a.state).toEqual({ sprite: "PLAY", frame: "A", tics: -1 });
      expect(a.inventory).toContainEqual({ class: "Clip", amount: 50, maxAmount: 200 });
    },
  },
  {
    capture: "dumpactor_tid",
    header: "MCP_ACTOR",
    parse: parseActorState,
    expect: (a) =>
      expect(a).toMatchObject({
        class: "DoomImp",
        health: 60,
        pos: { x: -800, y: 828, z: 8 },
        state: { sprite: "TROO", frame: "A", tics: 10 },
      }),
  },
  {
    capture: "dumpactor_missing",
    header: "MCP_ACTOR",
    parse: (l) => ({ lines: l, actor: parseActorState(l) }),
    expect: ({ lines, actor }) => {
      expect(lines).toEqual(["MCP_ACTOR", "actor none"]);
      expect(actor).toMatchObject({ class: null, health: null, inventory: [] });
    },
  },
  {
    capture: "actorsnear",
    header: "MCP_ACTORS",
    parse: parseActorsNear,
    expect: (a) => expect(a).toContainEqual(expect.objectContaining({ class: "DoomImp", health: 60, x: -800, y: 828 })),
  },
  {
    capture: "findactors",
    header: "MCP_FOUND",
    parse: parseFindActors,
    expect: (f) => {
      expect(f.actors).toHaveLength(8);
      expect(f.actors[0]).toMatchObject({ class: "DoomImp", dist: 128, flags: "monster,shootable,solid" });
    },
  },
  {
    capture: "findactors_tid",
    header: "MCP_FOUND",
    parse: parseFindActors,
    expect: (f) => expect(f.actors).toEqual([expect.objectContaining({ class: "DoomImp", dist: 128, index: 0 })]),
  },
  {
    capture: "dumpplayers",
    header: "MCP_PLAYERS",
    parse: (l) => parseKvLines(l, "player"),
    expect: ([p]) => expect(p).toMatchObject({ slot: 0, bot: 0, state: "live", hp: 100, weapon: "Pistol", name: "player" }),
    only: { zandronum: ["spec", "deadspec", "deaths", "points", "wins", "ping"] },
  },
  {
    capture: "dumprenderer",
    header: "MCP_RENDERER",
    parse: parseRenderInfo,
    expect: (r) => {
      expect(r).toMatchObject({ renderer: expect.any(String), screenblocks: expect.any(Number) });
      // Zandronum's st_scale/hud_scale are bool cvars.
      for (const k of ["st_scale", "hud_scale"]) expect(typeof r[k]).toBe("string");
    },
    only: { zandronum: ["gl_vendor", "gl_shadermodel", "gl_maxtexsize", "vid_renderer", "fullscreen"] },
  },
  {
    capture: "dumpmodules",
    header: "MCP_MODULES",
    parse: parseModules,
    expect: (m) => expect(m).toEqual([{ id: 0, name: "MCPCONF" }]),
  },
  {
    capture: "dumpscripts",
    header: "MCP_SCRIPTS",
    parse: parseScripts,
    expect: (s) => {
      expect(s.map((x: { name: string | null }) => x.name)).toEqual(["ConfLoop", "ConfHud", null]);
      expect(s[2]).toMatchObject({ module: 0, number: 901, args: 1 });
    },
  },
  {
    capture: "dumpfunctions",
    header: "MCP_FUNCTIONS",
    parse: parseFunctions,
    expect: (f) => expect(f).toEqual([{ module: 0, index: 0, name: "confadd" }]),
  },
  { capture: "getmapvar", parse: parseMapVar, expect: (v) => expect(v).toBe(42) },
  { capture: "setmapvar", parse: parseMapVar, expect: (v) => expect(v).toBe(43) },
  {
    capture: "getmapvar_missing",
    parse: (l) => ({ lines: l, value: parseMapVar(l) }),
    expect: (v) => expect(v).toEqual({ lines: ["mapvar NoSuchVar not found"], value: null }),
  },
  { capture: "getmaparray", parse: parseMapArray, expect: (v) => expect(v).toBe(33) },
  { capture: "setmaparray", parse: parseMapArray, expect: (v) => expect(v).toBe(5) },
  {
    capture: "getmaparray_missing",
    parse: (l) => ({ lines: l, value: parseMapArray(l) }),
    expect: (v) => expect(v).toEqual({ lines: ["maparray NoSuchArr not found"], value: null }),
  },
  {
    capture: "getacsvar",
    parse: parseAcsVars,
    expect: (v) => expect(v).toEqual([{ scope: "world", index: 1, value: 7 }]),
  },
  {
    capture: "setacsvar",
    parse: parseAcsVars,
    expect: (v) => expect(v).toEqual([{ scope: "global", index: 2, value: 10 }]),
  },
  {
    capture: "dumpacsvars",
    header: "MCP_ACSVARS",
    parse: parseAcsVars,
    expect: (v) =>
      expect(v).toEqual([
        { scope: "world", index: 1, value: 7 },
        { scope: "global", index: 2, value: 10 },
      ]),
  },
  {
    capture: "scriptstat",
    parse: parseScriptStat,
    expect: (s) => expect(s).toEqual([{ number: null, name: "ConfLoop", state: "Delayed" }]),
  },
  {
    capture: "acsprofile",
    parse: parseAcsProfile,
    expect: (rows) =>
      expect(rows.map((p: { section: string; name: string }) => [p.section, p.name])).toEqual([
        ["script", '"ConfLoop"'],
        ["script", "901"],
        ["function", "confadd"],
      ]),
  },
  {
    capture: "acsprofile_sorted",
    parse: parseAcsProfile,
    expect: (rows) => {
      expect(rows).toHaveLength(3);
      expect(rows[2]).toMatchObject({ section: "function", module: "MCPCONF", name: "confadd", runs: 1 });
    },
  },
  {
    capture: "dumphud",
    header: "MCP_HUD",
    parse: parseHud,
    expect: (h) => {
      const correlators = h.text.some((t: { text: string }) => t.text.startsWith("__MCPDONE_"));
      expect(correlators).toBe(false);
      expect(h.messages).toEqual([expect.objectContaining({ left: 0.5, top: 0.25, text: "conformance hud" })]);
      expect(h.text).toContainEqual(expect.objectContaining({ text: "conformance hud" }));
      // The capture's step left the game paused.
      expect(h.images).toContainEqual(expect.objectContaining({ name: "M_PAUSE" }));
    },
  },
  {
    capture: "runacs",
    parse: (l) => parseRunAcs(l)?.reply,
    expect: (r) => expect(r).toEqual({ module: 1, scripts: 1, started: "ConfProbe", deferred: false }),
  },
  { capture: "unblock", parse: (l) => l, expect: (l) => expect(l).toEqual(["unblock ok"]) },
];

describe("bridge contract (PROTOCOL.md) over the captured replies", () => {
  for (const c of CONTRACT) {
    describe(c.capture, () => {
      const engines = ENGINES.filter((e) => !c.pending?.includes(e));
      const parsed = Object.fromEntries(engines.map((e) => [e, c.parse(capture(e, c.capture))])) as Record<
        Engine,
        unknown
      >;

      for (const e of engines) {
        it(`parses the ${e} reply`, () => {
          if (c.header) expect(hasHeader(capture(e, c.capture), c.header)).toBe(true);
          c.expect(parsed[e], e);
        });
      }

      for (const e of c.pending ?? []) {
        it(`has no ${e} capture yet: once recorded, drop ${e} from \`pending\``, () => {
          expect(() => capture(e, c.capture)).toThrow(/ENOENT/);
        });
      }

      // With a capture pending there is only one side to compare.
      if (engines.length < ENGINES.length) return;

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
