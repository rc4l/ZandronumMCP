import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { startHarness, collectTools, type Harness } from "./fakes/tool-harness.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { InstanceRegistry } from "./../src/process/registry.js";
import type { ContextIo, ServerConfig } from "../src/context.js";
import { buildWad, buildZip, sectorsLump, doomLinedefsLump, sidedefsLump, vertexesLump } from "./fakes/wad-builder.js";
import { buildBehaviorAcse, buildBehaviorExports } from "./fakes/acs-builder.js";
import { readFileSync } from "node:fs";

/**
 * Drives every registered tool through a real MCP client/server pair — the
 * layer that used to be excluded from coverage as "just wiring".
 */

let bridge: FakeBridge | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
  bridge = undefined;
});

interface LiveOptions {
  caps?: string[];
  responses?: Record<string, string[]>;
  config?: Partial<ServerConfig>;
  io?: Partial<ContextIo>;
}

/**
 * Harness wired to a fake engine bridge on a real loopback port.
 *
 * Do NOT add "status" to this default cap list: `registerLive` (tools.ts)
 * wraps every live tool, including `verify_menu`, and would start sending a
 * refresh probe whenever a tool ran no command of its own — breaking the "no
 * command was sent" assertions below (e.g. "screenshots without opening or
 * navigating") that only hold on a bridge with no `status` cap. Use
 * `liveStatus()` for status-cap-specific tests instead.
 */
async function live(opts: LiveOptions = {}): Promise<Harness> {
  bridge = await FakeBridge.start({
    hello: { v: 1, t: "hello", engine: "fake", caps: opts.caps ?? ["cmd", "event", "time"] },
  });
  for (const [match, lines] of Object.entries(opts.responses ?? {})) bridge.respondTo(match, lines);
  harness = await startHarness({
    config: { basePort: bridge.port, ...opts.config },
    io: opts.io,
  });
  // Instance numbers are per-session now: a session must claim one before the
  // other tools will talk to it. Real callers get this from launch_instance.
  await harness.call("attach_instance");
  return harness;
}

/** `live()` on a status-capable bridge, with the fake's default all-normal snapshot. */
const withStatus = (opts: LiveOptions = {}) => live({ ...opts, caps: ["cmd", "event", "time", "status"] });

/** The text of every console command the fake bridge has received. */
const cmds = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");

/** Wait for a fire-and-forget send to reach the fake bridge. */
async function settle(done: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries && !done(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(done()).toBe(true);
}

/** Harness with no engine — for the file-backed and process-management tools. */
async function offline(config: Partial<ServerConfig> = {}, io: Partial<ContextIo> = {}) {
  harness = await startHarness({ config, io });
  return harness;
}

const WAD = buildWad("PWAD", [
  { name: "MAP01" },
  { name: "THINGS" },
  {
    name: "LINEDEFS",
    data: doomLinedefsLump([
      { v1: 0, v2: 1, flags: 1, special: 0, tag: 3, front: 0, back: 0xffff },
    ]),
  },
  {
    name: "SIDEDEFS",
    data: sidedefsLump([{ xoff: 0, yoff: 0, upper: "-", lower: "-", middle: "BRICK1", sector: 0 }]),
  },
  { name: "VERTEXES", data: vertexesLump([{ x: 0, y: 0 }, { x: 64, y: 0 }]) },
  {
    name: "SECTORS",
    data: sectorsLump([
      { floor: 0, ceil: 128, floorTex: "FLAT1", ceilTex: "F_SKY1", light: 160, special: 0, tag: 3 },
    ]),
  },
]);

const wadIo = { readFileSync: () => WAD };

describe("console, cheat and script tools", () => {
  it("runs a raw command and returns its output", async () => {
    const h = await live({ responses: { version: ["Zandronum 3.2.1"] } });
    expect(await h.text("run_command", { text: "version" })).toBe("Zandronum 3.2.1");
  });

  it("reports silent commands as (no output)", async () => {
    const h = await live();
    expect(await h.text("run_command", { text: "nothing" })).toBe("(no output)");
  });

  it("lists actor classes as structured data", async () => {
    const h = await live({
      responses: {
        dumpactors: ["DoomImp\t3001\t5\tDoom\tzandronum.pk3:actors/imp.txt"],
      },
    });
    const result = await h.call("list_actor_classes");
    expect(result.structuredContent?.actors).toEqual([
      { name: "DoomImp", edNum: 3001, spawnId: 5, filter: "Doom", source: "zandronum.pk3:actors/imp.txt" },
    ]);
  });

  it("summons with the verb matching the requested kind", async () => {
    const h = await live();
    await h.text("summon", { className: "DoomImp" });
    await h.text("summon", { className: "DoomImp", kind: "friend" });
    await h.text("summon", { className: "DoomImp", kind: "foe" });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^summon DoomImp/);
    expect(sent[1]).toMatch(/^summonfriend DoomImp/);
    expect(sent[2]).toMatch(/^summonfoe DoomImp/);
  });

  it("falls back to a confirmation when summon prints nothing", async () => {
    const h = await live();
    expect(await h.text("summon", { className: "DoomImp" })).toBe("summoned DoomImp");
  });

  it("gives and takes items with and without an amount", async () => {
    const h = await live({ responses: { "give Clip 50": ["gave it"] } });
    expect(await h.text("give", { item: "Clip", amount: 50 })).toBe("gave it");
    expect(await h.text("give", { item: "Berserk" })).toBe("gave Berserk");
    expect(await h.text("take", { item: "Clip", amount: 5 })).toBe("took Clip");
    expect(await h.text("take", { item: "Berserk" })).toBe("took Berserk");
  });

  it("loads a map by lump name", async () => {
    const h = await live({ responses: { "map MAP07": ["MAP07 - Dead Simple"] } });
    expect(await h.text("load_map", { mapName: "MAP07" })).toBe("MAP07 - Dead Simple");
    expect(await h.text("load_map", { mapName: "E1M1" })).toBe("loaded E1M1");
  });

  it("lists running scripts", async () => {
    const h = await live({ responses: { scriptstat: ["script 5: Running"] } });
    const result = await h.call("list_running_scripts");
    expect(result.structuredContent?.scripts).toEqual([{ number: 5, name: null, state: "Running" }]);
  });

  it("pukes scripts by number and by name", async () => {
    const h = await live();
    expect(await h.text("run_script", { script: 12, args: [1, 2] })).toBe("ran 12");
    expect(await h.text("run_script", { script: "OpenDoor", always: true })).toBe("ran OpenDoor");
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^puke 12 1 2/);
    expect(sent[1]).toMatch(/^pukename "OpenDoor" always/);
  });

  it("returns a screenshot as an image", async () => {
    const h = await live();
    const result = await h.call("screenshot");
    expect(result.content?.[0]).toMatchObject({ type: "image", mimeType: "image/png", data: "UE5H" });
  });

  it("saves a kept screenshot and returns only its absolute path", async () => {
    const seen: Array<{ name?: string; keep?: boolean } | undefined> = [];
    const h = await live({
      config: { screenshotDir: "/shots" },
      io: {
        capture: (_c, dir, opts) => {
          seen.push(opts);
          return Promise.resolve({ base64: "UE5H", path: `${dir}/${opts?.name ?? "auto"}.png` });
        },
      },
    });
    const named = await h.call("screenshot_file", { name: "wall_1" });
    expect(named.content?.[0]).toEqual({ type: "text", text: "/shots/wall_1.png" });
    expect(named.structuredContent).toEqual({ path: "/shots/wall_1.png" });
    expect(await h.text("screenshot_file")).toBe("/shots/auto.png");
    expect(seen).toEqual([
      { name: "wall_1", keep: true },
      { name: undefined, keep: true },
    ]);
  });

  it("rejects a screenshot name that would break the console command line", async () => {
    const h = await live();
    expect((await h.call("screenshot_file", { name: "a b" })).isError).toBe(true);
    expect((await h.call("screenshot_file", { name: "x;quit" })).isError).toBe(true);
  });
});

describe("input tools", () => {
  it("sends a single menu key", async () => {
    const h = await live();
    const received = bridge!.waitForEvent();
    expect(await h.text("menu_key", { key: "down" })).toBe("sent down");
    expect((await received).evtype).toBeGreaterThanOrEqual(0);
  });

  it("sends a sequence of menu keys, releasing each one", async () => {
    const h = await live();
    expect(await h.text("menu_nav", { steps: ["down", "down", "enter"] })).toBe(
      "sent 3 key(s): down down enter",
    );

    // TWO events per key: the press and the release. Sending only the press latches the key in the
    // engine's MenuButtons[] and M_Ticker repeats it for ever, so one "down" walks the selection down
    // the whole list -- an auto-repeat, not the keypress the caller asked for.
    await settle(() => bridge!.events.length === 6);

    const subtypes = bridge!.events.map((e: { subtype: number }) => e.subtype);
    expect(subtypes).toEqual([1, 3, 1, 3, 1, 3]); // EV_GUI_KeyDown, EV_GUI_KeyUp, ...
  });

  it("moves the pointer", async () => {
    const h = await live();
    expect(await h.text("mouse_move", { x: 120, y: 240 })).toBe("pointer at 120,240");
    await settle(() => bridge!.events.length === 1);

    const ev = bridge!.events[0];
    expect(ev.subtype).toBe(6); // EV_GUI_MouseMove
    expect(ev.data1).toBe(120);
    expect(ev.data2).toBe(240);
  });

  it("clicks by moving, pressing and releasing", async () => {
    const h = await live();
    expect(await h.text("mouse_click", { x: 10, y: 20 })).toBe("clicked 10,20");

    // The MOVE first matters: menus track the pointer from motion, so a press at a position they
    // have never seen it at lands on whatever was hovered last.
    await settle(() => bridge!.events.length === 3);
    expect(bridge!.events.map((e: { subtype: number }) => e.subtype)).toEqual([6, 7, 8]);
  });

  it("sends a double-click when asked", async () => {
    const h = await live();
    expect(await h.text("mouse_click", { x: 10, y: 20, double: true })).toBe(
      "clicked 10,20 (double)",
    );
    await settle(() => bridge!.events.length === 3);
    expect(bridge!.events[1].subtype).toBe(9); // EV_GUI_LButtonDblClick
  });

  it("drags through intermediate positions", async () => {
    const h = await live();
    expect(await h.text("mouse_click", { x: 0, y: 0, toX: 100, toY: 40 })).toBe(
      "dragged 0,0 -> 100,40",
    );

    // Move, press, four steps along the way, release. A drag that jumped straight to the end would
    // never give the menu the motion it is meant to be tracking.
    await settle(() => bridge!.events.length === 7);
    expect(bridge!.events.map((e: { subtype: number }) => e.subtype)).toEqual([6, 7, 6, 6, 6, 6, 8]);

    const last = bridge!.events[bridge!.events.length - 1];
    expect(last.data1).toBe(100);
    expect(last.data2).toBe(40);
  });

  it("scrolls the wheel up and down", async () => {
    const h = await live();
    expect(await h.text("mouse_wheel", { notches: 2 })).toBe("2 notch(es) up");
    await settle(() => bridge!.events.length === 2);
    expect(bridge!.events.every((e: { subtype: number }) => e.subtype === 16)).toBe(true);

    expect(await h.text("mouse_wheel", { notches: -1 })).toBe("1 notch(es) down");
    await settle(() => bridge!.events.length === 3);
    expect(bridge!.events[2].subtype).toBe(17);
  });

  it("caps a silly number of wheel notches", async () => {
    const h = await live();
    expect(await h.text("mouse_wheel", { notches: 5000 })).toBe("30 notch(es) up");
    await settle(() => bridge!.events.length === 30);
  });

  it("refuses mouse input when the bridge cannot post events", async () => {
    const h = await live({ caps: ["cmd"] });

    for (const [tool, args] of [
      ["mouse_move", { x: 1, y: 1 }],
      ["mouse_click", { x: 1, y: 1 }],
      ["mouse_wheel", { notches: 1 }],
    ] as const) {
      const result = await h.call(tool, args);
      expect(result.isError).toBe(true);
    }
  });

  it("types a string one character at a time", async () => {
    const h = await live();
    expect(await h.text("menu_text", { text: "hi" })).toBe('typed "hi"');
    await settle(() => bridge!.events.length === 2);
  });

  it("opens, navigates and screenshots a menu", async () => {
    const h = await live({ responses: { menu_options: ["opened"] } });
    const result = await h.call("verify_menu", { open: "menu_options", steps: ["down"] });
    expect(result.content?.[0]).toMatchObject({ type: "image" });
    await settle(() => bridge!.events.length === 2); // press + release
  });

  it("screenshots without opening or navigating when neither is asked for", async () => {
    const h = await live();
    const result = await h.call("verify_menu");
    expect(result.content?.[0]).toMatchObject({ type: "image" });
    // No `open` command, no key events — the capture itself is stubbed out.
    expect(bridge!.received).toHaveLength(0);
  });

  it("reports missing input support on an older bridge", async () => {
    const h = await live({ caps: ["cmd"] });
    for (const [tool, args] of [
      ["menu_key", { key: "up" }],
      ["menu_nav", { steps: ["up"] }],
      ["menu_text", { text: "x" }],
      ["verify_menu", { steps: ["up"] }],
    ] as const) {
      const result = await h.call(tool, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/no input support/);
    }
  });
});

describe("time control tools", () => {
  it("pauses and resumes", async () => {
    const h = await live();
    expect(await h.text("set_pause", { paused: true })).toBe("paused");
    expect(await h.text("set_pause", { paused: false })).toBe("resumed");
    await settle(() => bridge!.pauses.length === 2);
    expect(bridge!.pauses).toEqual([1, 0]);
  });

  it("steps the simulation forward and re-pauses", async () => {
    const h = await live();
    expect(await h.text("step", { tics: 70 })).toBe("advanced ~70 tic(s)");
    await settle(() => bridge!.pauses.length === 2);
    expect(bridge!.pauses).toEqual([0, 1]);
  });

  it("reports missing time support on an older bridge", async () => {
    const h = await live({ caps: ["cmd"] });
    expect((await h.call("set_pause", { paused: true })).content?.[0]?.text).toMatch(/no time-control/);
    expect((await h.call("step")).content?.[0]?.text).toMatch(/no time-control/);
  });
});

describe("ACS variable tools", () => {
  it("reads and writes world/global variables", async () => {
    const h = await live({
      responses: { getacsvar: ["acsvar world 5 = 42"], setacsvar: ["acsvar world 5 = 7"] },
    });
    const get = await h.call("get_acs_var", { scope: "world", index: 5 });
    expect(get.structuredContent).toEqual({ scope: "world", index: 5, value: 42 });
    const set = await h.call("set_acs_var", { scope: "world", index: 5, value: 7 });
    expect(set.content?.[0]?.text).toBe("world[5] = 7");
  });

  it("surfaces engine complaints when a variable read or write yields nothing", async () => {
    const h = await live({ responses: { getacsvar: ["index out of range (0-255)"] } });
    const get = await h.call("get_acs_var", { scope: "world", index: 999 });
    expect(get.isError).toBe(true);
    expect(get.content?.[0]?.text).toBe("index out of range (0-255)");

    const set = await h.call("set_acs_var", { scope: "global", index: 1, value: 2 });
    expect(set.isError).toBe(true);
    expect(set.content?.[0]?.text).toBe("set failed");
  });

  it("falls back to a generic message when the engine says nothing at all", async () => {
    const h = await live();
    expect((await h.call("get_acs_var", { scope: "world", index: 0 })).content?.[0]?.text).toBe("no value");
  });

  it("lists non-zero vars, optionally filtered by scope", async () => {
    const h = await live({
      responses: { dumpacsvars: ["acsvar world 0 = 1", "acsvar global 2 = 100"] },
    });
    const all = await h.call("list_acs_vars");
    expect(all.content?.[0]?.text).toBe("2 non-zero ACS var(s)");
    const world = await h.call("list_acs_vars", { scope: "world" });
    expect(world.content?.[0]?.text).toBe("1 non-zero ACS var(s)");
  });
});

describe("map-scope ACS tools", () => {
  it("lists loaded modules", async () => {
    const h = await live({ responses: { dumpmodules: ["module 0 ACSLEVEL"] } });
    expect(await h.text("list_modules")).toBe("1 module(s)");
  });

  it("gets and sets map variables and array elements", async () => {
    const h = await live({
      responses: {
        getmapvar: ["mapvar deathtoll = 42"],
        setmapvar: ["mapvar deathtoll = 9"],
        getmaparray: ["maparray Credits[2] = 500"],
        setmaparray: ["maparray Credits[2] = 7"],
      },
    });
    expect(await h.text("get_map_var", { name: "deathtoll" })).toBe("42");
    expect(await h.text("set_map_var", { name: "deathtoll", value: 9 })).toBe("deathtoll = 9");
    expect(await h.text("get_map_array", { name: "Credits", index: 2 })).toBe("500");
    expect(await h.text("set_map_array", { name: "Credits", index: 2, value: 7 })).toBe("Credits[2] = 7");
  });

  it("reports map vars and arrays that don't exist", async () => {
    const h = await live();
    for (const [tool, args, expected] of [
      ["get_map_var", { name: "Nope" }, "map var 'Nope' not found"],
      ["set_map_var", { name: "Nope", value: 1 }, "map var 'Nope' not found"],
      ["get_map_array", { name: "Nope", index: 0 }, "map array 'Nope' not found"],
      ["set_map_array", { name: "Nope", index: 0, value: 1 }, "map array 'Nope' not found"],
    ] as const) {
      const result = await h.call(tool, args as Record<string, unknown>);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe(expected);
    }
  });
});

describe("ACS source and bytecode tools", () => {
  const sources: Record<string, string> = {
    "main.acs": "#define GOLD 7\nscript 1 OPEN { }\nfunction void Give(void) { }",
  };
  const acsIo = {
    readdirSync: () => ["main.acs"],
    readTextSync: (p: string) => sources[path.basename(p)],
  };

  it("summarises an indexed ACS source directory", async () => {
    const h = await offline({ acsSrc: "/mods/acs" }, acsIo);
    const result = await h.call("acs_index");
    expect(result.structuredContent).toMatchObject({ scripts: 1, functions: 1, defines: 1 });
  });

  it("resolves a symbol to its source location", async () => {
    const h = await offline({}, acsIo);
    const result = await h.call("find_acs_symbol", { ref: "Give", dir: "/mods/acs" });
    expect(result.content?.[0]?.text).toBe("1 match(es) for Give");
  });

  it("errors when no ACS source directory is configured", async () => {
    const h = await offline();
    const result = await h.call("acs_index");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No ACS source dir/);
  });

  it("reads names out of compiled bytecode", async () => {
    const wad = buildWad("PWAD", [
      { name: "BEHAVIOR", data: buildBehaviorAcse(["GiveCredits"], ["OpenDoor"]) },
    ]);
    const h = await offline({}, { readFileSync: () => wad });
    const result = await h.call("behavior_names", { file: "/mods/x.wad" });
    expect(result.structuredContent).toEqual({
      functions: ["GiveCredits"],
      namedScripts: ["OpenDoor"],
    });
  });

  describe("list_map_exports", () => {
    const pk3 = buildZip([
      { name: "acs/mymod.o", data: buildBehaviorExports(["credits", "round"], [{ index: 0, size: 17 }]) },
      { name: "acs/other.o", data: buildBehaviorExports(["x"]) },
    ]);

    it("lists every module's exports, arrays sized", async () => {
      const h = await offline({}, { readFileSync: () => pk3 });
      const result = await h.call("list_map_exports", { file: "/mods/x.pk3" });
      expect(result.content?.[0]?.text).toBe(
        "acs/mymod.o: 2 export(s)\n  0: credits[17]\n  1: round\nacs/other.o: 1 export(s)\n  0: x",
      );
      expect(result.structuredContent?.modules).toHaveLength(2);
    });

    it("narrows to one module by basename or full name", async () => {
      const h = await offline({}, { readFileSync: () => pk3 });
      const byBase = await h.call("list_map_exports", { file: "/mods/x.pk3", lump: "MyMod" });
      expect(byBase.structuredContent?.modules).toEqual([
        {
          module: "acs/mymod.o",
          exports: [
            { name: "credits", index: 0, isArray: true, size: 17 },
            { name: "round", index: 1, isArray: false },
          ],
        },
      ]);
      const byFull = await h.call("list_map_exports", { file: "/mods/x.pk3", lump: "acs/other.o" });
      expect(byFull.content?.[0]?.text).toBe("acs/other.o: 1 export(s)\n  0: x");
    });

    it("names a raw compiled file after itself", async () => {
      const h = await offline({}, { readFileSync: () => buildBehaviorExports(["v"]) });
      expect(await h.text("list_map_exports", { file: "/build/lib.o" })).toBe("lib.o: 1 export(s)\n  0: v");
    });

    it("errors with the available module names when lump matches nothing", async () => {
      const h = await offline({}, { readFileSync: () => pk3 });
      const result = await h.call("list_map_exports", { file: "/mods/x.pk3", lump: "nope" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/Modules: acs\/mymod\.o, acs\/other\.o$/);
    });

    it("says so when the file has no ACS modules at all", async () => {
      const h = await offline({}, { readFileSync: () => buildZip([{ name: "decorate.txt", data: Buffer.from("x") }]) });
      expect(await h.text("list_map_exports", { file: "/e.pk3", lump: "a" })).toMatch(/Modules: none$/);
    });
  });
});

describe("savegame and demo tools", () => {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  function textChunk(key: string, val: string): Buffer {
    const data = Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(val, "latin1")]);
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write("tEXt", 4, "latin1");
    data.copy(b, 8);
    return b;
  }
  const save = Buffer.concat([SIG, textChunk("Title", "My Save"), textChunk("Current Map", "MAP07")]);

  it("lists savegames with metadata read from the file", async () => {
    const h = await offline(
      { saveDir: "/saves" },
      { readdirSync: () => ["a.zds", "notes.txt"], readFileSync: () => save },
    );
    const result = await h.call("list_saves");
    expect(result.content?.[0]?.text).toBe("1 save(s) in /saves");
    expect(result.structuredContent?.saves).toMatchObject([{ title: "My Save", map: "MAP07" }]);
  });

  it("errors when no save directory can be determined", async () => {
    const h = await offline();
    expect((await h.call("list_saves")).isError).toBe(true);
  });

  it("accepts a confirmed or silent (queued) save and fails on any other output", async () => {
    const h = await live({ responses: { "save good": ["Game saved."], "save bad": ["not in a level"] } });
    const ok = await h.call("save_game", { name: "good", description: "a slot" });
    expect(ok.isError).toBe(false);
    expect(ok.content?.[0]?.text).toBe("Game saved.");

    const queued = await h.call("save_game", { name: "later" });
    expect(queued.isError).toBe(false);
    expect(queued.content?.[0]?.text).toBe("save queued; confirm with list_saves");

    const bad = await h.call("save_game", { name: "bad" });
    expect(bad.isError).toBe(true);
    expect(bad.content?.[0]?.text).toBe("not in a level");
  });

  it("loads a savegame and plays a demo", async () => {
    const h = await live({ responses: { "load slot1": ["Loading..."], "playdemo d1": ["Playing"] } });
    expect(await h.text("load_game", { name: "slot1" })).toBe("Loading...");
    expect(await h.text("load_game", { name: "other" })).toBe("(loaded)");
    expect(await h.text("play_demo", { name: "d1" })).toBe("Playing");
    expect(await h.text("play_demo", { name: "other" })).toBe("(playing)");
  });

  describe("waiting for a queued load (status cap)", () => {
    const statusCaps = { caps: ["cmd", "event", "time", "status"] };
    const probes = () => bridge!.received.filter((m) => m.t === "cmd" && /^mcp_status /.test(m.text ?? ""));

    it("polls until pending clears, so the note describes the new map", async () => {
      const h = await live(statusCaps);
      bridge!.clearReceived();
      bridge!.queueStatus({ pending: "1" }, { pending: "1" }, { pending: "0", gamestate: "level" });
      const result = await h.call("load_map", { mapName: "MAP02" });
      expect(result.content).toEqual([{ type: "text", text: "loaded MAP02" }]);
      expect(probes()).toHaveLength(2);
    });

    it("returns what the engine printed after the command, e.g. a load error", async () => {
      const h = await live(statusCaps);
      bridge!.respondTo("load bad", [], ["Could not read savegame 'bad'"]);
      expect(await h.text("load_game", { name: "bad" })).toBe("Could not read savegame 'bad'");
    });

    it("strips the level-start banner's bar glyphs and colour escapes", async () => {
      const h = await live(statusCaps);
      const bar = "\x1d" + "\x1e".repeat(30) + "\x1f";
      bridge!.respondTo("map MAP01", [], [`\n${bar}\n`, "\n\x1c+MAP01 - entryway\n\n"]);
      expect(await h.text("load_map", { mapName: "MAP01" })).toBe("MAP01 - entryway");
    });

    it("re-reads after a probe the busy engine never answered", async () => {
      const h = await live(statusCaps);
      bridge!.clearReceived();
      bridge!.swallowProbes(1);
      expect(await h.text("play_demo", { name: "d1" })).toBe("(playing)");
      expect(probes()).toHaveLength(2);
    });

    it("says so when the load is still pending at the end of the budget", async () => {
      const h = await live(statusCaps);
      bridge!.setStatus({ pending: "1" });
      const result = await h.call("load_map", { mapName: "MAP02" });
      expect(result.content?.[0]?.text).toBe("(load still pending after ~5 s; the engine-state note may predate it)");
      expect(result.content?.at(-1)?.text).toBe("Engine state: a map/save/demo load is pending.");
    });
  });
});

describe("live state tools", () => {
  it("reads player state", async () => {
    const h = await live({
      responses: {
        currentpos: [
          "Current player position: (128.500,-64.000,0.000), angle: 270.000, floorheight: -8.000, sector:12, lightlevel: 144",
        ],
      },
    });
    const result = await h.call("player_state");
    expect(result.structuredContent).toMatchObject({ sector: 12, light: 144, x: 128.5 });
  });

  it("reports when there is no player", async () => {
    const h = await live();
    const result = await h.call("player_state");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/no player/);
  });

  it("reads actor state for the player and for a TID", async () => {
    const h = await live({
      responses: { dumpactor: ["MCP_ACTOR", "class DoomPlayer", "health 100", "state TNT1 A 0"] },
    });
    const player = await h.call("actor_state");
    expect(player.structuredContent).toMatchObject({ class: "DoomPlayer", health: 100 });
    await h.call("actor_state", { tid: 42 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^dumpactor ;/);
    expect(sent[1]).toMatch(/^dumpactor 42/);
  });

  it("reports a missing actor", async () => {
    const h = await live();
    const result = await h.call("actor_state", { tid: 999 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/no actor/);
  });

  it("reads the HUD", async () => {
    const h = await live({
      responses: {
        dumphud: ["MCP_HUD", "text 100 50 Press space", "image 10 20 MEDIA0", "msg 0 0.5 0.9 70 Credits"],
      },
    });
    const result = await h.call("read_hud");
    expect(result.content?.[0]?.text).toBe("1 strings, 1 images, 1 hud messages");
  });

  it("lists nearby actors, with and without an explicit radius", async () => {
    const h = await live({ responses: { actorsnear: ["MCP_ACTORS", "near DoomImp 60 100.0 200.0 TROO"] } });
    expect(await h.text("actors_near")).toBe("1 actor(s) nearby");
    await h.call("actors_near", { radius: 256 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[1]).toMatch(/^actorsnear 256/);
  });

  it("inspects the aimed target, or reports none", async () => {
    const h = await live({ responses: { linetarget: ["Target=DoomImp, Health=60, Spawnhealth=60"] } });
    const hit = await h.call("inspect_target");
    expect(hit.structuredContent).toMatchObject({ target: "DoomImp", health: 60 });
  });

  it("reports no target in view", async () => {
    const h = await live();
    expect(await h.text("inspect_target")).toBe("no target in view");
  });
});

describe("test-session tools", () => {
  it("drills into the nth actor sharing a TID, and needs a tid for index", async () => {
    const h = await live({ responses: { dumpactor: ["MCP_ACTOR", "class DoomImp", "pitch 5.0"] } });
    const res = await h.call("actor_state", { tid: 7, index: 2 });
    expect(res.structuredContent).toMatchObject({ class: "DoomImp", pitch: 5 });
    expect(cmds().at(-1)).toMatch(/^dumpactor 7 2 /);
    const bad = await h.call("actor_state", { index: 1 });
    expect(bad.isError).toBe(true);
    expect(bad.content?.[0]?.text).toBe("index needs a tid");
  });

  describe("set_cheat", () => {
    it("is a no-op when the bit already matches", async () => {
      const h = await withStatus();
      bridge!.setStatus({ cheats: String(1 << 1) });
      bridge!.clearReceived();
      expect(await h.text("set_cheat", { name: "god", on: true })).toBe("god already on; no change");
      expect(cmds().some((c) => c.startsWith("god"))).toBe(false);
      expect(await h.text("set_cheat", { name: "notarget", on: false })).toBe(
        "notarget already off; no change",
      );
    });

    it("toggles once and waits for the bit to flip", async () => {
      const h = await withStatus();
      bridge!.onCommand("god", () => bridge!.setStatus({ cheats: "2" }));
      expect(await h.text("set_cheat", { name: "god", on: true })).toBe("god on");
      expect(cmds().filter((c) => /^god\b/.test(c))).toHaveLength(1);
    });

    it("polls until a late flip lands", async () => {
      const h = await withStatus();
      let toggled = false;
      let probesAfter = 0;
      bridge!.onCommand("noclip2", () => (toggled = true));
      // An empty match sees every command, bare status probes included.
      bridge!.onCommand("", () => {
        if (toggled && ++probesAfter === 4) bridge!.setStatus({ cheats: String(1 << 30) });
      });
      expect(await h.text("set_cheat", { name: "noclip2", on: true })).toBe("noclip2 on");
      expect(probesAfter).toBe(4);
    });

    it("reports a toggle that never lands, with the engine's own output", async () => {
      const h = await withStatus({ responses: { buddha: ["sv_cheats must be true"] } });
      const res = await h.call("set_cheat", { name: "buddha", on: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("buddha did not turn on; the engine said: sv_cheats must be true");
      const silent = await h.call("set_cheat", { name: "fly", on: true });
      expect(silent.content?.[0]?.text).toBe("fly did not turn on; the engine said: (no output)");
    });

    it("fails a toggle whose status snapshot drops the cheats field", async () => {
      const h = await withStatus();
      bridge!.onCommand("notarget", () => bridge!.setStatus({ cheats: undefined }));
      const res = await h.call("set_cheat", { name: "notarget", on: false });
      expect(res.content?.[0]?.text).toBe("notarget already off; no change");
      const gone = await h.call("set_cheat", { name: "notarget", on: true });
      expect(gone.content?.[0]?.text).toBe("notarget did not turn on; the engine said: (no output)");
    });

    it("refuses when the snapshot has no cheats field", async () => {
      const h = await withStatus();
      bridge!.setStatus({ cheats: undefined });
      const res = await h.call("set_cheat", { name: "god", on: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/no cheats= field/);
    });

    it("refuses on a bridge without the status cap", async () => {
      const h = await live();
      const res = await h.call("set_cheat", { name: "god", on: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/no status support/);
    });
  });

  describe("set_view", () => {
    it("sets an absolute angle, with and without pitch", async () => {
      const h = await live({ responses: { mcp_setview: ["view angle=90.0 pitch=-10.0"] } });
      const res = await h.call("set_view", { angle: 90, pitch: -10.5 });
      expect(res.structuredContent).toEqual({ angle: 90, pitch: -10 });
      await h.call("set_view", { angle: 45 });
      expect(cmds()[0]).toMatch(/^mcp_setview 90 -10\.5 /);
      expect(cmds()[1]).toMatch(/^mcp_setview 45 /);
    });

    it("faces an actor by tid or class", async () => {
      const h = await live({
        responses: { mcp_setview: ["view angle=12.0 pitch=3.0 tid=0 class=DoomImp"] },
      });
      expect(await h.text("set_view", { tid: 5 })).toMatch(/"class":"DoomImp"/);
      await h.call("set_view", { class: "DoomImp" });
      expect(cmds()[0]).toMatch(/^mcp_setview tid=5 /);
      expect(cmds()[1]).toMatch(/^mcp_setview class=DoomImp /);
    });

    it("rejects zero or several modes, and pitch without angle", async () => {
      const h = await live();
      for (const args of [{}, { angle: 1, tid: 2 }, { tid: 1, pitch: 5 }]) {
        const res = await h.call("set_view", args);
        expect(res.isError).toBe(true);
        expect(res.content?.[0]?.text).toMatch(/exactly one of angle, tid or class/);
      }
      expect(cmds()).toHaveLength(0);
    });

    it("surfaces an engine error line, or raw output when there's no view line", async () => {
      const h = await live({
        responses: { "tid=9": ["error no actor with tid 9"], "class=Foo": ["Unknown command"] },
      });
      expect(await h.text("set_view", { tid: 9 })).toBe("no actor with tid 9");
      expect(await h.text("set_view", { class: "Foo" })).toBe("Unknown command");
      expect(await h.text("set_view", { angle: 3 })).toBe("(no output)");
    });
  });

  describe("summon_at", () => {
    const SPAWNED =
      "spawned class=DoomImp tid=7 hp=60 spawnhp=60 x=100.0 y=-32.5 z=0.0 angle=90.0 pitch=0.0 flags=mso";

    it("sends only the given options and reports the spawned actor", async () => {
      const h = await live({ responses: { mcp_spawnat: [SPAWNED] } });
      const res = await h.call("summon_at", { className: "DoomImp", x: 100, y: -32.5 });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ class: "DoomImp", tid: 7, x: 100, y: -32.5, flags: "monster,shootable,solid" });
      expect(res.content?.[0]?.text).toBe(
        "spawned DoomImp tid=7 at 100,-32.5,0; follow up with actor_state(tid 7) / find_actors(class, tid)",
      );
      await h.call("summon_at", {
        className: "DoomImp", x: 1.5, y: 2, z: 64, angle: 45.5, tid: 3, kind: "friend", force: true,
        health: 5, special: 80, args: [1, 2], ambush: true, dormant: true,
      });
      await h.call("summon_at", { className: "DoomImp", x: 0, y: 0, kind: "normal", force: false, ambush: false, dormant: false });
      await h.call("summon_at", { className: "DoomImp", x: 0, y: 0, kind: "foe" });
      expect(cmds()[0]).toMatch(/^mcp_spawnat DoomImp 100 -32\.5 ;/);
      expect(cmds()[1]).toMatch(
        /^mcp_spawnat DoomImp 1\.5 2 z=64 angle=45\.5 tid=3 kind=friend force=1 health=5 special=80 args=1,2,0,0,0 ambush=1 dormant=1 ;/,
      );
      expect(cmds()[2]).toMatch(/^mcp_spawnat DoomImp 0 0 ;/);
      expect(cmds()[3]).toMatch(/^mcp_spawnat DoomImp 0 0 kind=foe ;/);
    });

    it("passes tid 0 through and drops the tid follow-up hint", async () => {
      const h = await live({ responses: { mcp_spawnat: [SPAWNED.replace("tid=7", "tid=0").replace("flags=mso", "flags=-")] } });
      const res = await h.call("summon_at", { className: "DoomImp", x: 1, y: 2, tid: 0 });
      expect(cmds()[0]).toMatch(/^mcp_spawnat DoomImp 1 2 tid=0 ;/);
      expect(res.structuredContent?.flags).toBe("");
      expect(res.content?.[0]?.text).toMatch(/no tid, so find it with find_actors\(class\) by position$/);
    });

    it("reports the replacement class and requested name", async () => {
      const h = await live({ responses: { mcp_spawnat: [SPAWNED.replace("DoomImp", "MyImp") + " requested=DoomImp"] } });
      const res = await h.call("summon_at", { className: "DoomImp", x: 1, y: 2 });
      expect(res.structuredContent).toMatchObject({ class: "MyImp", requested: "DoomImp" });
    });

    it("rejects args without special before sending anything", async () => {
      const h = await live();
      const res = await h.call("summon_at", { className: "DoomImp", x: 1, y: 2, args: [1] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("args needs special");
      expect(cmds()).toHaveLength(0);
    });

    it("refuses coordinates outside the engine's fixed-point range before sending anything", async () => {
      const h = await live();
      for (const at of [{ x: 40000, y: 0 }, { x: 0, y: -32769 }, { x: 0, y: 0, z: 32768 }]) {
        expect((await h.call("summon_at", { className: "DoomImp", ...at })).isError).toBe(true);
      }
      expect((await h.call("summon_at", { className: "DoomImp", x: -32768, y: 32767 })).content?.[0]?.text).toBe(
        "(no output)",
      );
      expect(cmds()).toHaveLength(1);
    });

    it("surfaces each engine error shape, or raw output without a spawned line", async () => {
      const h = await live({
        responses: {
          Nope: ["error unknown class Nope"],
          "DoomImp 1 ": ["error blocked by player0"],
          "DoomImp 2 ": ["error client: spawn on the server instance"],
          "DoomImp 3 ": ["Unknown command"],
        },
      });
      expect(await h.text("summon_at", { className: "Nope", x: 0, y: 0 })).toBe("unknown class Nope");
      expect(await h.text("summon_at", { className: "DoomImp", x: 1, y: 0 })).toBe("blocked by player0");
      expect(await h.text("summon_at", { className: "DoomImp", x: 2, y: 0 })).toBe("client: spawn on the server instance");
      expect(await h.text("summon_at", { className: "DoomImp", x: 3, y: 0 })).toBe("Unknown command");
      const res = await h.call("summon_at", { className: "DoomImp", x: 4, y: 0 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("(no output)");
    });
  });

  it("lists players", async () => {
    const h = await live({
      responses: { dumpplayers: ["MCP_PLAYERS", "player slot=0 bot=0 name=Player", "player slot=1 bot=1 name=Bot"] },
    });
    const res = await h.call("list_players");
    expect(res.content?.[0]?.text).toBe("2 player(s)");
    expect(res.structuredContent?.players).toEqual([
      { slot: 0, bot: 0, name: "Player" },
      { slot: 1, bot: 1, name: "Bot" },
    ]);
  });

  it("fails list_players when dumpplayers never ran (no MCP_PLAYERS header)", async () => {
    const h = await live({ responses: { dumpplayers: ['Unknown command "dumpplayers"'] } });
    const res = await h.call("list_players");
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toBe('Unknown command "dumpplayers"');
  });

  describe("find_actors", () => {
    it("passes only the given filters and reports the count", async () => {
      const h = await live({ responses: { findactors: ["MCP_FOUND", "found class=DoomImp tid=0 flags=m"] } });
      expect(await h.text("find_actors")).toBe("1 actor(s) found");
      await h.call("find_actors", { class: "DoomImp", tid: 3, radius: 100, limit: 5, detail: true });
      await h.call("find_actors", { detail: false });
      expect(cmds()[0]).toMatch(/^findactors ;/);
      expect(cmds()[1]).toMatch(/^findactors class=DoomImp tid=3 radius=100 limit=5 detail=1 /);
      expect(cmds()[2]).toMatch(/^findactors ;/);
    });

    it("reports truncation", async () => {
      const h = await live({
        responses: { findactors: ["MCP_FOUND", "found class=A tid=0", "truncated shown=1 total=4"] },
      });
      const res = await h.call("find_actors", { limit: 1 });
      expect(res.content?.[0]?.text).toBe("1 actor(s) found (showing 1 of 4)");
      expect(res.structuredContent?.truncated).toEqual({ shown: 1, total: 4 });
    });

    it("surfaces an engine error", async () => {
      const h = await live({ responses: { findactors: ["MCP_FOUND", "error unknown class Nope"] } });
      const res = await h.call("find_actors", { class: "Nope" });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("unknown class Nope");
    });

    it("fails when findactors never ran (no MCP_FOUND header)", async () => {
      const h = await live({ responses: { findactors: ['Unknown command "findactors"'] } });
      const res = await h.call("find_actors");
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe('Unknown command "findactors"');
    });

    it("carries each TID match's actor_state index", async () => {
      const h = await live({
        responses: { findactors: ["MCP_FOUND", "found class=A tid=7 dist=10.0 index=2", "found class=A tid=7 dist=50.0 index=0"] },
      });
      const res = await h.call("find_actors", { tid: 7 });
      expect((res.structuredContent?.actors as Array<{ index: number }>).map((a) => a.index)).toEqual([2, 0]);
    });

    it("rejects a class name with spaces", async () => {
      const h = await live();
      const res = await h.call("find_actors", { class: "Doom Imp" });
      expect(res.isError).toBe(true);
    });
  });

  /** Advance the fake's maptime by one on every command, status probes included. */
  const ticking = () => {
    let t = 0;
    bridge!.onCommand("", () => bridge!.setStatus({ maptime: String(++t) }));
  };

  describe("ensure_live", () => {
    it("reports live, leaves the pause state as found, and fixes nothing without fix", async () => {
      const h = await withStatus();
      bridge!.setStatus({ paused: "1" });
      ticking();
      bridge!.clearReceived();
      const res = await h.call("ensure_live");
      expect(res.content?.[0]?.text).toBe("live (maptime 1 -> 2)");
      expect(res.structuredContent).toEqual({ live: true, maptime: { before: 1, after: 2 }, found: [], remaining: [] });
      expect(bridge!.pauses.slice(-2)).toEqual([0, 1]);
      expect(cmds().some((c) => /closemenu|mcp_unblock/.test(c))).toBe(false);
    });

    it("reports a stuck sim with its blockers", async () => {
      const h = await withStatus();
      bridge!.setStatus({ menu: "on" });
      const res = await h.call("ensure_live");
      expect(res.content?.[0]?.text).toBe("NOT live (maptime 0 -> 0); blockers: a menu is open");
      expect(res.structuredContent).toMatchObject({ live: false, found: ["a menu is open"] });
    });

    it("with fix, closes the menu and unblocks, reporting what cleared and what didn't", async () => {
      const h = await withStatus();
      bridge!.setStatus({ menu: "on", console: "down", chat: "1", automap: "1" });
      bridge!.onCommand("closemenu", () => bridge!.setStatus({ menu: "off" }));
      bridge!.onCommand("mcp_unblock", () => bridge!.setStatus({ console: "up", chat: "0" }));
      ticking();
      bridge!.clearReceived();
      const res = await h.call("ensure_live", { fix: true });
      expect(res.content?.[0]?.text).toBe(
        "live (maptime 3 -> 4); fixed: a menu is open, console is down, chat input is open; blockers: automap is open",
      );
      expect(res.structuredContent).toMatchObject({
        fixed: ["a menu is open", "console is down", "chat input is open"],
        remaining: ["automap is open"],
      });
      expect(bridge!.pauses.slice(-1)).toEqual([0]);
      expect(cmds().filter((c) => /closemenu|mcp_unblock/.test(c))).toHaveLength(2);
    });

    it("asks for a retry, not a rebuild, when the second status read comes back empty", async () => {
      const h = await withStatus();
      bridge!.onCommand("closemenu", () => bridge!.blankStatus());
      const res = await h.call("ensure_live", { fix: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "can't check liveness: status read timed out (engine busy, e.g. loading a map); retry",
      );
    });

    it("fails when a fix command's own status line comes back without maptime", async () => {
      const h = await withStatus();
      bridge!.onCommand("mcp_unblock", () => bridge!.setStatus({ maptime: undefined }));
      const pauses = bridge!.pauses.length;
      const res = await h.call("ensure_live", { fix: true });
      // Caught before the probe: the sim was never unpaused.
      expect(bridge!.pauses).toHaveLength(pauses);
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/^can't check liveness: the engine's status snapshot has no maptime= field/);
    });

    it("lists a load still pending after the wait as a blocker", async () => {
      const h = await withStatus();
      bridge!.setStatus({ pending: "1" });
      const res = await h.call("ensure_live");
      expect(res.content?.[0]?.text).toBe("NOT live (maptime 0 -> 0); blockers: a map/save/demo load is pending");
      expect(res.structuredContent).toMatchObject({ found: ["a map/save/demo load is pending"] });
    });

    it("waits out a pending load before measuring, so the map change doesn't read as not live", async () => {
      const h = await withStatus();
      bridge!.setStatus({ maptime: "6" });
      bridge!.queueStatus({ pending: "1", maptime: "50" }, { pending: "0", maptime: "1" });
      const res = await h.call("ensure_live");
      expect(res.content?.[0]?.text).toBe("live (maptime 1 -> 6); waited for a pending map/save/demo load first");
      expect(res.structuredContent).toMatchObject({ live: true, found: [] });
    });

    it("needs the time cap and a maptime= field", async () => {
      const noTime = await live({ caps: ["cmd", "status"] });
      expect((await noTime.call("ensure_live")).content?.[0]?.text).toMatch(/no time-control/);
      await harness!.close();
      await bridge!.close();
      const noStatus = await live();
      expect((await noStatus.call("ensure_live")).content?.[0]?.text).toMatch(/no status support/);
      await harness!.close();
      await bridge!.close();
      const old = await withStatus();
      bridge!.setStatus({ maptime: undefined });
      expect((await old.call("ensure_live")).content?.[0]?.text).toMatch(/no maptime= field/);
    });
  });

  describe("step_until", () => {
    const mapvar = (op: string, value: number) => ({ kind: "mapvar", name: "hp", op, value });

    it("steps in chunks until a map var meets the condition, counting map tics", async () => {
      const h = await withStatus();
      const out = ["mapvar hp = 0"];
      let n = 0;
      bridge!.respondTo("getmapvar", out);
      bridge!.onCommand("getmapvar", () => (out[0] = `mapvar hp = ${++n * 10}`));
      ticking();
      bridge!.clearReceived();
      const res = await h.call("step_until", { condition: mapvar(">=", 30), maxTics: 100 });
      expect(res.content?.[0]?.text).toBe("met after 2 tic(s): 30 >= 30");
      expect(res.structuredContent).toEqual({ met: true, tics: 2, value: 30 });
      expect(bridge!.pauses.slice(-4)).toEqual([0, 1, 0, 1]);
    });

    it("returns at once when the condition already holds", async () => {
      const h = await withStatus({ responses: { getacsvar: ["acsvar global 3 = 7"] } });
      bridge!.clearReceived();
      const res = await h.call("step_until", {
        condition: { kind: "acsvar", scope: "global", index: 3, op: "==", value: 7 },
        maxTics: 10,
      });
      expect(res.content?.[0]?.text).toBe("met after 0 tic(s): 7 == 7");
      expect(bridge!.pauses).toEqual([]);
    });

    it("stops at maxTics with a short last chunk", async () => {
      const h = await withStatus({ responses: { getmaparray: ["maparray a[2] = 1"] } });
      ticking();
      const res = await h.call("step_until", {
        condition: { kind: "maparray", name: "a", index: 2, op: "!=", value: 1 },
        maxTics: 12,
      });
      expect(res.content?.[0]?.text).toBe("not met within 3 tic(s): 1 != 1");
      expect(res.structuredContent).toMatchObject({ met: false });
      expect(cmds().filter((c) => c.startsWith("getmaparray"))).toHaveLength(4);
    });

    it("runs only the tics left in the last chunk", async () => {
      const sleeps: number[] = [];
      const h = await withStatus({
        responses: { getmapvar: ["mapvar hp = 0"] },
        io: { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) },
      });
      ticking();
      sleeps.length = 0;
      await h.call("step_until", { condition: mapvar("==", 1), maxTics: 12, chunkTics: 5 });
      expect(sleeps.map((ms) => Math.round((ms * 35) / 1000))).toEqual([5, 5, 2]);
    });

    it("compares a player field against a number or another field", async () => {
      const h = await withStatus({
        responses: {
          currentpos: [
            "Current player position: (1.0,2.0,32.0), angle: 90.0, floorheight: 0.0, sector:4, lightlevel: 160",
          ],
        },
      });
      ticking();
      const floor = await h.call("step_until", {
        condition: { kind: "player", field: "z", op: ">", value: "floorHeight" },
        maxTics: 5,
      });
      expect(floor.content?.[0]?.text).toBe("met after 0 tic(s): 32 > 0");
      const hp = await h.call("step_until", {
        condition: { kind: "player", field: "health", op: "<", value: 50 },
        maxTics: 5,
      });
      expect(hp.content?.[0]?.text).toBe("not met within 1 tic(s): 100 < 50");
    });

    it("fails fast when the sim stops advancing, with the blockers", async () => {
      const h = await withStatus({ responses: { getmapvar: ["mapvar hp = 0"] } });
      const clean = await h.call("step_until", { condition: mapvar("==", 1), maxTics: 50 });
      expect(clean.isError).toBe(true);
      expect(clean.content?.[0]?.text).toBe(
        "the sim stopped advancing (maptime stuck at 0); no blocker reported. Try ensure_live with fix.",
      );
      bridge!.setStatus({ menu: "on" });
      const blocked = await h.call("step_until", { condition: mapvar("<=", -1), maxTics: 50 });
      expect(blocked.content?.[0]?.text).toMatch(/stuck at 0\); a menu is open\./);
    });

    it("treats a snapshot that loses maptime mid-run as a stall", async () => {
      const h = await withStatus({ responses: { getmapvar: ["mapvar hp = 0"] } });
      ticking();
      let reads = 0;
      bridge!.onCommand("getmapvar", () => ++reads === 2 && bridge!.setStatus({ maptime: undefined }));
      const res = await h.call("step_until", { condition: mapvar("==", 1), maxTics: 50 });
      expect(res.content?.[0]?.text).toMatch(/\(maptime unreadable\); no blocker reported/);
    });

    it("reports reads that can't be made", async () => {
      const h = await withStatus({
        responses: { currentpos: ["Current player position: (0.0,0.0,0.0), angle: 0.0, floorheight: 0.0, sector:0, lightlevel: 0"] },
      });
      const errText = async (condition: Record<string, unknown>) =>
        (await h.call("step_until", { condition, maxTics: 5 })).content?.[0]?.text;
      expect(await errText(mapvar("==", 1))).toBe("map var 'hp' not found");
      expect(await errText({ kind: "maparray", name: "a", index: 0, op: "==", value: 1 })).toBe(
        "map array 'a' not found",
      );
      const acsvar = { kind: "acsvar", scope: "world", index: 2, op: "==", value: 1 };
      expect(await errText(acsvar)).toBe("no value");
      bridge!.respondTo("getacsvar", ["index out of range (0-255)"]);
      expect(await errText(acsvar)).toBe("index out of range (0-255)");
      bridge!.setStatus({ armor: undefined });
      expect(await errText({ kind: "player", field: "z", op: "==", value: "armor" })).toMatch(/health\/armor/);
      bridge!.setStatus({ health: undefined });
      expect(await errText({ kind: "player", field: "health", op: "==", value: 1 })).toMatch(/health\/armor/);
    });

    it("needs a player, the time cap and a maptime= field", async () => {
      const h = await withStatus();
      const noPlayer = await h.call("step_until", {
        condition: { kind: "player", field: "x", op: "==", value: 0 },
        maxTics: 5,
      });
      expect(noPlayer.content?.[0]?.text).toBe("no player (not in a level?)");
      bridge!.setStatus({ maptime: undefined });
      expect((await h.call("step_until", { condition: mapvar("==", 1), maxTics: 5 })).content?.[0]?.text).toMatch(
        /can't count tics: .*no maptime= field/,
      );
      await harness!.close();
      await bridge!.close();
      const noTime = await live({ caps: ["cmd", "status"] });
      expect(
        (await noTime.call("step_until", { condition: mapvar("==", 1), maxTics: 5 })).content?.[0]?.text,
      ).toMatch(/no time-control/);
    });
  });
});

describe("script listing and profiling tools", () => {
  it("lists scripts and functions", async () => {
    const h = await live({
      responses: { dumpscripts: ["script 0 1 - 1 0"], dumpfunctions: ["function 0 0 GiveCredits"] },
    });
    expect(await h.text("list_scripts")).toBe("1 script(s)");
    expect(await h.text("list_functions")).toBe("1 function(s)");
  });

  it("profiles scripts with and without sort/limit", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    expect(await h.text("profile_scripts")).toBe("1 profiled");
    await h.call("profile_scripts", { sort: "avg" });
    await h.call("profile_scripts", { sort: "total", limit: 5 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^acsprofile ;/);
    expect(sent[1]).toMatch(/^acsprofile avg ;/);
    expect(sent[2]).toMatch(/^acsprofile total 5 ;/);
  });

  it("profiles a time window, clearing first", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    expect(await h.text("profile_window", { seconds: 2 })).toBe("1 profiled over 2s");
    await h.call("profile_window", { sort: "runs", limit: 3 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^acsprofile clear/);
    expect(sent[3]).toMatch(/^acsprofile runs 3 ;/);
  });
});

describe("renderer inspection tools", () => {
  const responses = {
    dumprenderer: [
      "MCP_RENDERER",
      "renderer=opengl",
      "screen_width=1920",
      "view_x=0",
      "statusbar_y=1048",
      "crosshair=1",
    ],
  };

  it("returns renderer, viewport and HUD slices of the same dump", async () => {
    const h = await live({ responses });
    expect((await h.call("renderer_info")).structuredContent).toMatchObject({
      renderer: "opengl",
      screen_width: 1920,
    });
    expect((await h.call("viewport_info")).structuredContent).toMatchObject({ view_x: 0 });
    expect((await h.call("hud_info")).structuredContent).toMatchObject({
      statusbar_y: 1048,
      crosshair: 1,
    });
  });
});

describe("map geometry tools", () => {
  it("summarises a map read straight from a WAD", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("map_info", { map: "MAP01" });
    expect(result.structuredContent).toEqual({
      format: "doom",
      sectors: 1,
      linedefs: 1,
      sidedefs: 1,
      vertices: 2,
    });
  });

  it("errors when no WAD is configured or passed", async () => {
    const h = await offline();
    const result = await h.call("map_info", { map: "MAP01" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No WAD specified/);
  });

  it("returns a sector by index", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_sector", { map: "MAP01", index: 0 });
    expect(result.structuredContent?.sector).toMatchObject({ tag: 3, light: 160 });
  });

  it("reports an out-of-range sector index", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_sector", { map: "MAP01", index: 99 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("No sector 99 (map has 1).");
  });

  it("returns a linedef with its sidedefs resolved", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_linedef", { map: "MAP01", index: 0 });
    const { line, sides } = result.structuredContent as { line: Record<string, number>; sides: unknown[] };
    expect(line.tag).toBe(3);
    expect(sides).toHaveLength(1); // the -1 back side is filtered out
  });

  it("reports an out-of-range linedef index", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    const result = await h.call("get_linedef", { map: "MAP01", index: 99 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("No linedef 99 (map has 1).");
  });

  it("finds sectors by tag", async () => {
    const h = await offline({ iwad: "/game/doom2.wad" }, wadIo);
    expect(await h.text("find_sectors_by_tag", { map: "MAP01", tag: 3 })).toBe("1 sector(s) with tag 3");
    expect(await h.text("find_sectors_by_tag", { map: "MAP01", tag: 9 })).toBe("0 sector(s) with tag 9");
  });
});

describe("process management tools", () => {
  it("refuses to launch without an engine configured", async () => {
    const h = await offline();
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Set ZANDRONUM_EXE/);
  });

  it("refuses to launch an engine path that doesn't exist", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/not found at/);
  });

  it("refuses to launch a build without the MCP bridge", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, hasBridge: () => false },
    );
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/has no MCP bridge/);
  });

  it("launches, attaches, and remembers the port it picked", async () => {
    bridge = await FakeBridge.start();
    const registry = new InstanceRegistry();
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        findFreePort: (start) => Promise.resolve(start),
        launchIo: {
          spawn: () => ({ pid: undefined, kill: () => {} }),
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
        },
      },
      registry,
    });
    const result = await harness.call("launch_instance");
    expect(result.content?.[0]?.text).toBe(`launched instance 1 on bridge port ${bridge.port}`);
    expect(harness.ctx.logPathFor(1)).toBe(path.join("/engine", `mcp-bridge-${bridge.port}.log`));
  });

  it("surfaces compile errors from the engine log when the bridge never opens", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: () => true,
        hasBridge: () => true,
        readTextSync: () => "Script error, \"DECORATE\" line 7:\nUnknown actor 'Foo'",
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          waitForPort: () => Promise.reject(new Error("bridge port never opened")),
          clearQuarantine: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Engine log shows:[\s\S]*Unknown actor/);
  });

  it("says so when a failed launch left no explanation in the log", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: (p: string) => !p.endsWith(".log"),
        hasBridge: () => true,
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          // A non-Error rejection must still be reported, not swallowed.
          waitForPort: () => Promise.reject("boom"),
          clearQuarantine: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/failed to come up: boom\. \(no compile errors/);
  });

  it("reports a log that exists but holds no recognisable errors", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: () => true,
        hasBridge: () => true,
        readTextSync: () => "all quiet\n",
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          waitForPort: () => Promise.reject(new Error("timeout")),
          clearQuarantine: () => {},
        },
      },
    );
    expect((await h.call("launch_instance")).content?.[0]?.text).toMatch(/no compile errors found/);
  });

  it("reports an instance that quit on request", async () => {
    bridge = await FakeBridge.start();
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        launchIo: {
          // A PID that is not (and cannot be) running, so the graceful-quit
          // wait sees the engine already gone on its first poll.
          spawn: () => ({ pid: 0x7ffffff0, kill: () => {} }),
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
        },
      },
    });
    await harness.call("launch_instance");
    expect(await harness.text("kill_instance")).toBe("instance 1 quit cleanly");
    // The remembered launch goes with it — no log path pinned to that port.
    expect(harness.ctx.logPathFor(1)).toBe(
      path.join("/engine", `mcp-bridge-${bridge.port}.log`),
    );
  });

  it("reports an instance that had to be force-killed", async () => {
    const registry = new InstanceRegistry();
    harness = await startHarness({ registry });
    // Nothing launched: quit() finds no child and reports a forced stop.
    expect(await harness.text("kill_instance")).toBe(
      "instance 1 did not quit on request — force-killed",
    );
  });

  it("resets without an orphan sweep when no engine is configured", async () => {
    const h = await offline();
    expect(await h.text("reset")).toMatch(/ZANDRONUM_EXE unset, so no orphan sweep/);
  });

  it("resets and reports reaped orphans", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { reap: () => Promise.resolve({ found: [1, 2], killed: [1, 2], survivors: [] }) },
    );
    expect(await h.text("reset")).toBe("Reset complete. Reaped 2 orphaned engine process(es).");
  });

  it("calls out engine processes that survived SIGKILL", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { reap: () => Promise.resolve({ found: [7], killed: [], survivors: [7] }) },
    );
    expect(await h.text("reset")).toMatch(/survived SIGKILL \(PIDs 7\)/);
  });
});

describe("diagnostic tools", () => {
  it("reports when there is no engine log to read", async () => {
    const h = await offline();
    const result = await h.call("get_startup_errors");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No engine log for instance 1/);
  });

  it("reports when the derived log path doesn't exist", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    expect((await h.call("get_startup_errors")).isError).toBe(true);
  });

  it("surfaces error lines from the engine log", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => "ok\nScript error, bad syntax\n" },
    );
    expect(await h.text("get_startup_errors")).toMatch(/Detected 1 error line\(s\)/);
  });

  it("falls back to the log tail when nothing looks like an error", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => "all quiet\n" },
    );
    expect(await h.text("get_startup_errors")).toMatch(/Last lines of the engine log[\s\S]*all quiet/);
  });

  it("read_log reports when there is no engine log", async () => {
    const result = await (await offline()).call("read_log");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No engine log for instance 1/);
  });

  it("read_log returns numbered lines without sentinels, with a resume point", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => "a\n__MCPDONE_1__\nGod ON\nb\n" },
    );
    const all = await h.call("read_log", { maxLines: 2 });
    expect(all.content?.[0]?.text).toBe("2 line(s), nextLine=4, 1 more matching line(s) not shown\n3: God ON\n4: b");
    expect(all.structuredContent).toMatchObject({ nextLine: 4, omitted: 1 });
    expect(await h.text("read_log", { pattern: "god", sinceLine: 1 })).toBe("1 line(s), nextLine=4\n3: God ON");
  });

  it("read_log surfaces an invalid pattern as a tool error", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => true, readTextSync: () => "a\n" });
    expect((await h.call("read_log", { pattern: "(" })).isError).toBe(true);
  });

  it("reports no crash when there is no crash file", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    expect(await h.text("get_crash")).toMatch(/No crash recorded for instance 1/);
  });

  it("reports no crash when the instance has no log path at all", async () => {
    const h = await offline();
    expect(await h.text("get_crash")).toMatch(/No crash recorded/);
  });

  const written = new Date("2026-09-22T06:10:00Z");
  const crashFile = path.join("/engine", "mcp-bridge-7777.log.crash");
  const crashReport = (pid: number) =>
    `=== MCP ENGINE CRASH ===\nsignal: 11 SIGSEGV\npid: ${pid}\n\nbacktrace:\n#0 R_DrawColumn`;
  const mtimeOnly = (file: string) => (p: string) => {
    if (p !== file) throw new Error(`unexpected mtimeOf ${p} in test`);
    return written;
  };
  const crashed = (pid: number) =>
    offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, readTextSync: () => crashReport(pid), mtimeOf: mtimeOnly(crashFile) },
    );

  it("returns the report verbatim when its pid matches this instance's engine", async () => {
    const h = await crashed(4242);
    h.ctx.rememberEngine(1, 4242);
    expect(await h.text("get_crash")).toBe(crashReport(4242));
  });

  it("names another engine's report instead of returning it", async () => {
    const h = await crashed(99);
    h.ctx.rememberEngine(1, 4242);
    expect(await h.text("get_crash")).toBe(
      `No crash recorded for instance 1 (PID 4242). ${crashFile} holds ` +
        "another engine's crash (PID 99, written 2026-09-22T06:10:00.000Z), not this one's.",
    );
  });

  it("stops matching the previous engine's PID once a relaunch fails", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 4242 } });
    let bridgeOpens = true;
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        readTextSync: () => crashReport(4242),
        mtimeOf: mtimeOnly(path.join("/engine", `mcp-bridge-${bridge.port}.log.crash`)),
        launchIo: {
          spawn: () => ({ pid: undefined, kill: () => {} }),
          waitForPort: () =>
            bridgeOpens ? Promise.resolve() : Promise.reject(new Error("timeout")),
          clearQuarantine: () => {},
        },
      },
    });
    await harness.call("launch_instance");
    expect(await harness.text("get_crash")).toBe(crashReport(4242));

    bridgeOpens = false;
    expect((await harness.call("launch_instance")).isError).toBe(true);
    expect(await harness.text("get_crash")).toMatch(
      /^Unverified: this instance's engine PID is unknown/,
    );
  });
});

describe("progress reporting on slow tools", () => {
  it("reports progress while sampling a profiling window", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    const { result, progress } = await h.callWithProgress("profile_window", { seconds: 30 });
    expect(result.content?.[0]?.text).toBe("1 profiled over 30s");
    expect(progress).toEqual([{ progress: 1000, total: 30000, message: "sampling for 30s" }]);
  });

  it("reports progress while waiting for a launching engine", async () => {
    bridge = await FakeBridge.start();
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        launchIo: {
          spawn: () => ({ pid: undefined, kill: () => {} }),
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
        },
      },
    });
    const { progress } = await harness.callWithProgress("launch_instance");
    expect(progress[0]).toMatchObject({ total: 42000, message: "waiting for the engine" });
  });

  it("reports progress for stepping, typing, navigating and capturing", async () => {
    const h = await live({ responses: { menu_options: ["opened"] } });
    expect((await h.callWithProgress("step", { tics: 350 })).progress[0]).toMatchObject({
      total: 10000,
      message: "advancing 350 tic(s)",
    });
    expect((await h.callWithProgress("menu_text", { text: "abc" })).progress[0]).toMatchObject({
      total: 120,
      message: "typing",
    });
    expect((await h.callWithProgress("menu_nav", { steps: ["up", "down"] })).progress[0]).toMatchObject({
      total: 120,
      message: "sending menu keys",
    });
    expect((await h.callWithProgress("screenshot")).progress[0]).toMatchObject({
      message: "capturing screenshot",
    });
    expect((await h.callWithProgress("verify_menu", { open: "menu_options" })).progress[0]).toMatchObject({
      message: "opening and capturing menu",
    });
  });

  it("caps the reported progress at the estimate when work overruns it", async () => {
    // Five ticks against a 2s estimate: progress must not climb past the total.
    let ticks = 0;
    const h = await live({
      responses: { acsprofile: [] },
      io: {
        every: (_ms, fn) => {
          for (ticks = 0; ticks < 5; ticks++) fn();
          return () => {};
        },
      },
    });
    const { progress } = await h.callWithProgress("profile_window", { seconds: 2 });
    expect(progress.map((p) => p.progress)).toEqual([1000, 2000, 2000, 2000, 2000]);
  });

  it("keeps working when the client has stopped listening for progress", async () => {
    // A real client/server pair can't make sendNotification reject on demand,
    // so drive the handler directly against a live fake bridge.
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    const handlers = collectTools(h.ctx);
    const result = await handlers.get("profile_window")!(
      { instance: 1, seconds: 1 },
      {
        _meta: { progressToken: 7 },
        sendNotification: () => Promise.reject(new Error("client went away")),
      },
    );
    // The failed notification must not take the profiling run down with it.
    expect(result.content?.[0]?.text).toBe("1 profiled over 1s");
  });
});

describe("session-scoped instances", () => {
  it("refuses to drive an instance this session never started", async () => {
    // The collision that motivated this: four editor windows, four MCP servers,
    // all of which would call the conventional port "instance 1".
    bridge = await FakeBridge.start();
    harness = await startHarness({ config: { basePort: bridge.port } });
    const result = await harness.call("run_command", { text: "version" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/isn't running in this session/);
    expect(result.content?.[0]?.text).toMatch(/another editor window's game/);
  });

  it("attaches explicitly to an engine started outside the session", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 999 } });
    harness = await startHarness({ config: { basePort: bridge.port } });
    bridge.respondTo("version", ["Zandronum 3.2.1"]);

    expect(await harness.text("attach_instance")).toBe(
      `attached instance 1 to port ${bridge.port} (engine PID 999)`,
    );
    // Now the rest of the tools work against it.
    expect(await harness.text("run_command", { text: "version" })).toBe("Zandronum 3.2.1");
  });

  it("attaches to an explicitly given port", async () => {
    bridge = await FakeBridge.start();
    harness = await startHarness({ config: { basePort: 1 } });
    expect(await harness.text("attach_instance", { instance: 2, port: bridge.port })).toBe(
      `attached instance 2 to port ${bridge.port}`,
    );
  });

  it("reports a failed attach and leaves no binding behind", async () => {
    bridge = await FakeBridge.start();
    const deadPort = bridge.port;
    await bridge.close();
    bridge = undefined;
    harness = await startHarness({ config: { basePort: deadPort } });

    const result = await harness.call("attach_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Could not attach instance 1/);
    expect(harness.ctx.isBound(1)).toBe(false);
  });

  it("frees the instance number again after kill_instance", async () => {
    const h = await live();
    expect(h.ctx.isBound(1)).toBe(true);
    await h.call("kill_instance");
    expect(h.ctx.isBound(1)).toBe(false);
  });
});

describe("reset scoping", () => {
  it("sweeps only orphans by default, sparing other live sessions", async () => {
    const seen: Array<boolean | undefined> = [];
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        reap: (_exe, opts) => {
          seen.push(opts?.onlyOrphans);
          return Promise.resolve({ found: [1], killed: [1], survivors: [] });
        },
      },
    );
    expect(await h.text("reset")).toBe("Reset complete. Reaped 1 orphaned engine process(es).");
    expect(seen).toEqual([true]);
  });

  it("sweeps everything for this build when explicitly asked", async () => {
    const seen: Array<boolean | undefined> = [];
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        reap: (_exe, opts) => {
          seen.push(opts?.onlyOrphans);
          return Promise.resolve({ found: [1, 2], killed: [1, 2], survivors: [] });
        },
      },
    );
    expect(await h.text("reset", { all: true })).toBe("Reset complete. Reaped 2 engine process(es).");
    expect(seen).toEqual([false]);
  });
});

describe("attach_instance failure reporting", () => {
  it("reports a rejection that isn't an Error", async () => {
    harness = await startHarness();
    // Connect failures are normally Errors; make sure a stray non-Error
    // rejection still reaches the caller instead of becoming "undefined".
    (harness.ctx.registry as unknown as { attach: unknown }).attach = () =>
      Promise.reject("socket exploded");
    const handlers = collectTools(harness.ctx);
    const result = await handlers.get("attach_instance")!({ instance: 1, port: 9 }, {});
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/socket exploded/);
    expect(harness.ctx.isBound(1)).toBe(false);
  });
});

describe("engine-state note (registerLive)", () => {
  /**
   * Harness wired to a status-capable fake bridge, defaulted to an unusual
   * snapshot (paused) so most tools get a note without per-test setup.
   * `clearReceived()` drops `live()`'s own `attach_instance` traffic (that
   * call is itself wrapped by `registerLive` and refreshes on attach), so
   * wire-count assertions in each test start from zero.
   */
  async function liveStatus(opts: LiveOptions = {}): Promise<Harness> {
    const h = await live({ ...opts, caps: opts.caps ?? ["cmd", "event", "time", "status"] });
    bridge!.setStatus({ paused: "1" });
    bridge!.clearReceived();
    return h;
  }

  const cmdsSent = () => bridge!.received.filter((m) => m.t === "cmd");

  it("appends the note after content without touching structuredContent", async () => {
    const h = await liveStatus({
      responses: { dumpactors: ["DoomImp\t3001\t5\tDoom\tzandronum.pk3:actors/imp.txt"] },
    });
    const result = await h.call("list_actor_classes");
    expect(result.structuredContent?.actors).toEqual([
      { name: "DoomImp", edNum: 3001, spawnId: 5, filter: "Doom", source: "zandronum.pk3:actors/imp.txt" },
    ]);
    const content = result.content ?? [];
    expect(content[content.length - 1]).toEqual({ type: "text", text: "Engine state: paused." });
  });

  it("appends the note after image content via a bare refresh probe (the stub capture runs no command)", async () => {
    const h = await liveStatus();
    const result = await h.call("screenshot");
    expect(result.content).toEqual([
      { type: "image", data: "UE5H", mimeType: "image/png" },
      { type: "text", text: "Engine state: paused." },
    ]);
    const statusOnly = cmdsSent().filter((m) => /^mcp_status /.test(m.text ?? ""));
    expect(statusOnly).toHaveLength(1);
  });

  it("appends the note to an isError result", async () => {
    const h = await liveStatus();
    const result = await h.call("get_acs_var", { scope: "world", index: 0 });
    expect(result.isError).toBe(true);
    const content = result.content ?? [];
    expect(content[content.length - 1]).toEqual({ type: "text", text: "Engine state: paused." });
  });

  it("refreshes via exactly one bare probe for an input-only tool", async () => {
    const h = await liveStatus();
    expect(await h.tail("menu_key", { key: "down" })).toBe("Engine state: paused.");
    expect(cmdsSent()).toHaveLength(1);
    expect(cmdsSent()[0].text).toMatch(/^mcp_status /);
  });

  it("waits ~2 tics after posted input events before the probe, and not otherwise", async () => {
    const sleeps: Array<{ ms: number; cmds: number }> = [];
    const sleep = (ms: number) => {
      sleeps.push({ ms, cmds: cmdsSent().length });
      return Promise.resolve();
    };
    const h = await liveStatus({ io: { sleep } });
    sleeps.length = 0;
    await h.call("menu_key", { key: "back" });
    expect(sleeps).toEqual([{ ms: 60, cmds: 0 }]);
    expect(cmdsSent()).toHaveLength(1);
    sleeps.length = 0;
    await h.call("screenshot");
    expect(sleeps).toEqual([]);
  });

  it("rides the note on the command's own sentinel line, sending exactly one command", async () => {
    const h = await liveStatus();
    expect(await h.tail("run_command", { text: "version" })).toBe("Engine state: paused.");
    expect(cmdsSent()).toHaveLength(1);
  });

  it("adds no note and sends no extra command on a legacy echo bridge", async () => {
    const h = await live({ caps: ["cmd", "event", "time"] }); // no "status" cap
    bridge!.clearReceived();
    const result = await h.call("menu_key", { key: "down" });
    expect(result.content).toHaveLength(1);
    expect(cmdsSent()).toHaveLength(0);
  });
});

describe("run_acs", () => {
  const REPLY = "MCP_RUNACS module=2 scripts=3 started=1 deferred=0";
  const OBJECT = buildBehaviorAcse([], []);
  const IMPORTING = readFileSync(new URL("./fixtures/runacs-import.o", import.meta.url));

  /** A compileAcs stub that records its requests and the dirs removed after. */
  function compiler(result: { ok: true; token?: string } | { ok: false; diagnostics: string; exe?: string } = { ok: true }) {
    const requests: unknown[] = [];
    const removed: string[] = [];
    const io: Partial<ContextIo> = {
      compileAcs: (req) => {
        requests.push(req);
        const object = "/tmp/mcp-runacs-1/snippet.o";
        return result.ok
          ? { ok: true, dir: "/tmp/mcp-runacs-1", object, token: result.token ?? object }
          : { ok: false, dir: "/tmp/mcp-runacs-1", diagnostics: result.diagnostics, exe: result.exe };
      },
      removeDir: (dir) => void removed.push(dir),
      readFileSync: () => OBJECT,
    };
    return { io, requests, removed };
  }

  it("compiles with bcc, loads, runs and reports the script's own output", async () => {
    const c = compiler();
    const h = await live({ responses: { mcp_runacs: ["runacs ok", "", REPLY] }, io: c.io });
    const res = await h.call("run_acs", { source: "script 1 (void) {}", script: 1, args: [5, -2] });
    expect(res.isError).toBeFalsy();
    expect(c.requests).toEqual([{ compiler: "bcc", exe: undefined, source: "script 1 (void) {}", includeDirs: undefined }]);
    expect(c.removed).toEqual(["/tmp/mcp-runacs-1"]);
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o 1 5 -2 ;/);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/^loaded snippet as module 2 \(3 script\(s\)\), started 1\nrunacs ok\nsave_game refuses/);
    expect(text).not.toMatch(/DEATH/);
    expect(res.structuredContent).toEqual({ module: 2, scripts: 3, started: "1", deferred: false, output: ["runacs ok"] });
  });

  it("uses the configured acc, include dirs, a named script and open, and warns about deferred scripts", async () => {
    const c = compiler();
    const h = await live({
      responses: { mcp_runacs: ["MCP_RUNACS module=0 scripts=2 started=named deferred=1"] },
      io: c.io,
      config: { acc: "/opt/acc", bcc: "/opt/bcc" },
    });
    const res = await h.call("run_acs", { source: "x", script: "named", compiler: "acc", includeDirs: ["/mod/scripts"], open: true });
    expect(c.requests[0]).toMatchObject({ compiler: "acc", exe: "/opt/acc", includeDirs: ["/mod/scripts"] });
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o named open=1 ;/);
    expect(res.content?.[0]?.text).toMatch(/DEATH\/ENTER\/RESPAWN/);
    await h.call("run_acs", { source: "x", open: false });
    expect(cmds()[1]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o ;/);
    await h.call("run_acs", { source: "x" });
    expect(c.requests[2]).toMatchObject({ exe: "/opt/bcc" });
  });

  it("sends the object as compileAcs's console token, quoted if it has to be", async () => {
    const c = compiler({ ok: true, token: '"C:/Users/First Last/Temp/mcp-runacs-1/snippet.o"' });
    const h = await live({ responses: { mcp_runacs: [REPLY] }, io: c.io });
    const res = await h.call("run_acs", { source: "x", script: 1 });
    expect(res.isError).toBeFalsy();
    expect(cmds()[0]).toMatch(/^mcp_runacs "C:\/Users\/First Last\/Temp\/mcp-runacs-1\/snippet\.o" 1 ;/);
  });

  it("treats a blank configured compiler as unset", async () => {
    const c = compiler();
    const h = await live({ responses: { mcp_runacs: [REPLY] }, io: c.io, config: { bcc: "  " } });
    await h.call("run_acs", { source: "x" });
    expect(c.requests[0]).toMatchObject({ exe: undefined });
  });

  it("returns compile diagnostics without sending anything, and still cleans up", async () => {
    const c = compiler({ ok: false, diagnostics: "snippet.acs:1:30: syntax error" });
    const h = await live({ io: c.io });
    const res = await h.call("run_acs", { source: "x", script: 1 });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toBe("compile failed (bcc), nothing sent to the engine:\nsnippet.acs:1:30: syntax error");
    expect(cmds()).toHaveLength(0);
    expect(c.removed).toEqual(["/tmp/mcp-runacs-1"]);
    const named = await live({ io: compiler({ ok: false, diagnostics: "boom", exe: "/usr/bin/bcc" }).io });
    expect((await named.call("run_acs", { source: "x" })).content?.[0]?.text).toBe(
      "compile failed (bcc: /usr/bin/bcc), nothing sent to the engine:\nboom",
    );
  });

  it("refuses args without a script, or stepTics without the time cap, before compiling", async () => {
    const c = compiler();
    const h = await live({ io: c.io, caps: ["cmd"] });
    expect(await h.text("run_acs", { source: "x", args: [1] })).toBe("args needs script");
    expect(await h.text("run_acs", { source: "x", stepTics: 3 })).toMatch(/no time-control support/);
    expect(c.requests).toHaveLength(0);
  });

  it("surfaces the engine's refusal with everything it printed", async () => {
    const c = compiler();
    const h = await live({
      responses: {
        "snippet.o 1": ["Could not find ACS function Foo for use in BEHAVIOR.", "error bad module (unresolved import or import mismatch)"],
        "snippet.o 2": [],
      },
      io: c.io,
    });
    const res = await h.call("run_acs", { source: "x", script: 1 });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toBe(
      "Could not find ACS function Foo for use in BEHAVIOR.\nerror bad module (unresolved import or import mismatch)",
    );
    expect(await h.text("run_acs", { source: "x", script: 2 })).toBe("(no output)");
  });

  it("steps the sim and returns the log lines printed meanwhile", async () => {
    let reads = 0;
    const logs = ["a\nb\n", "a\nb\nafter delay\n"];
    const c = compiler();
    const h = await live({
      responses: { mcp_runacs: ["before delay", REPLY] },
      config: { exe: "/engine/zandronum" },
      io: { ...c.io, existsSync: () => true, readTextSync: () => logs[Math.min(reads++, 1)] },
    });
    const res = await h.call("run_acs", { source: "x", script: 2, stepTics: 2 });
    await settle(() => bridge!.pauses.length === 2);
    expect(bridge!.pauses).toEqual([0, 1]);
    expect(res.content?.[0]?.text).toMatch(/\nbefore delay\nlog after 2 tic\(s\):\nafter delay\n/);
    expect(res.structuredContent?.log).toEqual(["after delay"]);
  });

  it("says so when there is no engine log to read after stepping", async () => {
    const c = compiler();
    const h = await live({ responses: { mcp_runacs: [REPLY] }, io: c.io });
    const res = await h.call("run_acs", { source: "x", script: 1, stepTics: 1 });
    expect(res.content?.[0]?.text).toMatch(/ran 1 tic\(s\); no engine log to read/);
    expect(res.structuredContent?.log).toBeUndefined();
  });

  it("makes save_game refuse while a snippet module is loaded", async () => {
    const h = await withStatus();
    bridge!.setStatus({ acstemp: "2" });
    const res = await h.call("save_game", { name: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toMatch(/^refused: 2 run_acs snippet module\(s\) are loaded/);
    expect(cmds().some((t) => t.startsWith("save "))).toBe(false);
    bridge!.setStatus({ acstemp: "0" });
    bridge!.respondTo("save s1", ["Game saved."]);
    expect((await h.call("save_game", { name: "s1" })).isError).toBe(false);
    expect(cmds().some((t) => /^mcp_status ;/.test(t))).toBe(false);
  });

  it("makes save_game refuse when the status read comes back empty", async () => {
    const h = await withStatus();
    bridge!.blankStatus();
    const res = await h.call("save_game", { name: "s1" });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toMatch(/^refused: status read timed out/);
    expect(cmds().some((t) => t.startsWith("save "))).toBe(false);
  });

  it("sends a snippet whose imports are all loaded", async () => {
    const c = compiler();
    const h = await live({
      responses: { dumpmodules: ["MCP_MODULES", "module 0 MCPLIB"], mcp_runacs: [REPLY] },
      io: { ...c.io, readFileSync: () => IMPORTING },
    });
    expect((await h.call("run_acs", { source: "x", script: 1 })).isError).toBeFalsy();
    expect(cmds().filter((t) => t.startsWith("mcp_runacs"))).toHaveLength(1);
  });

  it("refuses an import that isn't loaded before sending anything (Zandronum can't unload it)", async () => {
    const c = compiler();
    const h = await live({
      responses: { dumpmodules: ["MCP_MODULES", "module 0 OTHER"] },
      io: { ...c.io, readFileSync: () => IMPORTING },
    });
    expect(await h.text("run_acs", { source: "x", script: 1 })).toBe(
      "imports mcplib, not loaded in this level; nothing sent to the engine",
    );
    expect(cmds().some((t) => t.startsWith("mcp_runacs"))).toBe(false);
    expect(c.removed).toEqual(["/tmp/mcp-runacs-1"]);
  });

  it("refuses compiler output that isn't an ACS object", async () => {
    const c = compiler();
    const h = await live({ io: { ...c.io, readFileSync: () => Buffer.from("not bytecode") } });
    expect(await h.text("run_acs", { source: "x" })).toBe("bcc produced no ACS object; nothing sent to the engine");
    expect(cmds()).toHaveLength(0);
  });
});
