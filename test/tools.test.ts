import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";
import { startHarness, collectTools, type Harness } from "./fakes/tool-harness.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { InstanceRegistry } from "./../src/process/registry.js";
import { configPathFor, isolatedConfigPathFor } from "../src/process/launch.js";
import { envName, type EngineAdapter, type NetgameCaps } from "../src/adapter.js";
import { engine } from "../src/engine.js";
import type { ContextIo, LaunchArgs, ServerConfig } from "../src/context.js";
import type { MapSlotRequest, MapSlotResult } from "../src/acs/probe.js";
import { buildWad, buildZip, sectorsLump, doomLinedefsLump, sidedefsLump, vertexesLump } from "./fakes/wad-builder.js";
import { buildBehaviorAcse, buildBehaviorExports } from "./fakes/acs-builder.js";
import { readFileSync } from "node:fs";
import { engineFixture } from "./fakes/fixtures.js";
import type { KvRecord } from "../src/parsers/lines.js";
import { MAPSLOT_DIGESTS } from "./fixtures/mapslot/digests.js";
import { abs, norm, PathMap, sepRe } from "./fakes/paths.js";

/**
 * Drives every registered tool through a real MCP client/server pair — the
 * layer that used to be excluded from coverage as "just wiring".
 */

let bridge: FakeBridge | undefined;
let harness: Harness | undefined;

const CLIENT_NOTE =
  "a paused client stops processing server traffic: relayed log lines and world updates wait until it is unpaused";
const SERVER_NOTE = "pause doesn't stop a server's sim: maptime keeps advancing";
// Pinned rather than read from this repo's adapter, so the suite doesn't depend on this repo's adapter values.
const LAN_CAPS: NetgameCaps = {
  hostFlag: "-host",
  clientFlag: "-connect",
  joinCommand: "join",
  stepLeavesClientRunning: true,
  pauseNotes: { server: SERVER_NOTE, client: CLIENT_NOTE },
};
const LAN_ENGINE: EngineAdapter = { ...engine, netgame: LAN_CAPS };

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
  engine?: EngineAdapter;
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
    engine: opts.engine,
  });
  // Instance numbers are per-session now: a session must claim one before the
  // other tools will talk to it. Real callers get this from launch_instance.
  await harness.call("attach_instance");
  return harness;
}

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

  it("refuses what the adapter's refuseCommand flags, before sending it", async () => {
    const refuseCommand = (text: string) => (text.startsWith("debug_restart") ? "refused: needs -iwad" : undefined);
    const h = await live({ engine: { ...engine, refuseCommand }, responses: { version: ["v1"] } });
    const result = await h.call("run_command", { text: "debug_restart -file a.pk3" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("refused: needs -iwad");
    expect(bridge!.received.some((m) => m.t === "cmd" && m.text?.includes("debug_restart"))).toBe(false);
    expect(await h.text("run_command", { text: "version" })).toBe("v1");
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

  it("pukes a numbered script with always as puke's negated number", async () => {
    const h = await live();
    expect(await h.text("run_script", { script: 12, args: [1, 2], always: true })).toBe("ran 12");
    expect(await h.text("run_script", { script: 12, always: false })).toBe("ran 12");
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent.map((c) => c.replace(/ ;.*$/, ""))).toEqual(["puke -12 1 2", "puke 12"]);
  });

  it("accepts name as an alias for script, but not both or neither", async () => {
    const h = await live();
    expect(await h.text("run_script", { name: "OpenDoor" })).toBe("ran OpenDoor");
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[0]).toMatch(/^pukename "OpenDoor"/);
    for (const args of [{}, { script: 1, name: "OpenDoor" }]) {
      const result = await h.call("run_script", args);
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe("pass exactly one of script or name");
    }
  });

  describe("run_script on a bridge with the runscript cap", () => {
    const caps = ["cmd", "event", "time", "runscript"];
    const sent = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    const reply = (script: string, rest: string) => `MCP_RUNSCRIPT script=${script} ${rest}`;

    it("runs the script inside the call and returns its result and Log() lines", async () => {
      const h = await live({
        caps,
        responses: { mcp_runscript: ["\x1cGhi  \n\nsecond line", reply("12", "started=1 result=42 finished=1 module=0")] },
      });
      const res = await h.call("run_script", { script: 12, args: [1, 2], always: true });
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("ran 12 (module 0): result 42\nhi\nsecond line");
      expect(res.structuredContent).toEqual({
        result: 42,
        finished: true,
        started: true,
        module: 0,
        output: ["hi", "second line"],
      });
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatch(/^mcp_runscript 12 always=1 1 2 ;/);
    });

    it("says when a named script paused at a delay, with the value so far", async () => {
      const h = await live({
        caps,
        responses: { mcp_runscript: [reply("Open Door", "started=1 result=-7 finished=0 module=2")] },
      });
      const res = await h.call("run_script", { name: "Open Door", args: [3] });
      expect(res.content?.[0]?.text).toBe(
        "ran Open Door (module 2): result -7 (paused at a delay or a wait: the result is its value so far)",
      );
      expect(res.structuredContent).toEqual({ result: -7, finished: false, started: true, module: 2, output: [] });
      expect(sent()[0]).toMatch(/^mcp_runscript "Open Door" name=1 3 ;/);
    });

    it("marks every string a name, so a name made of digits is not read as a number", async () => {
      const h = await live({ caps, responses: { mcp_runscript: [reply("5", "started=1 result=1 finished=1 module=1")] } });
      await h.call("run_script", { name: "5" });
      await h.call("run_script", { script: "5", always: true, args: [9] });
      await h.call("run_script", { script: 5 });
      expect(sent().map((c) => c.replace(/ ;.*$/, ""))).toEqual([
        'mcp_runscript "5" name=1',
        'mcp_runscript "5" name=1 always=1 9',
        "mcp_runscript 5",
      ]);
    });

    it("reports a script that is already running as not started", async () => {
      const h = await live({
        caps,
        responses: { mcp_runscript: [reply("Later", "started=0 result=0 finished=0 module=3")] },
      });
      const res = await h.call("run_script", { script: "Later" });
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("Later (module 3) is already running (pass always to start another copy)");
      expect(res.structuredContent).toMatchObject({ started: false, finished: false, module: 3 });
    });

    it("falls back to puke on a netgame and says no result is available", async () => {
      const h = await live({ caps, responses: { mcp_runscript: ["error netgame"], "puke 5": ["puked 5"] } });
      const plain = await h.call("run_script", { script: 12, args: [1] });
      expect(plain.content).toEqual([{ type: "text", text: "ran 12 (netgame: no result value)" }]);
      expect(plain.structuredContent).toBeUndefined();
      expect(await h.text("run_script", { script: "OpenDoor", always: true })).toBe("ran OpenDoor (netgame: no result value)");
      expect(await h.text("run_script", { script: 12, args: [1], always: true })).toBe("ran 12 (netgame: no result value)");
      const stepped = await h.call("run_script", { script: 5, stepTics: 1 });
      expect(stepped.content?.[0]?.text).toBe("puked 5 (netgame: no result value)\nran 1 tic(s); no engine log to read");
      expect(stepped.structuredContent).toEqual({
        output: ["puked 5"],
        notes: ["netgame: no result value", "ran 1 tic(s); no engine log to read"],
      });
      expect(sent().map((c) => c.replace(/ ;.*$/, ""))).toEqual([
        "mcp_runscript 12 1",
        "puke 12 1",
        'mcp_runscript "OpenDoor" name=1 always=1',
        'pukename "OpenDoor" always',
        "mcp_runscript 12 always=1 1",
        "puke -12 1",
        "mcp_runscript 5",
        "puke 5",
      ]);
    });

    it("passes any other engine error through, or the raw output without a reply line", async () => {
      const h = await live({
        caps,
        responses: { Nope: ["error no script Nope"], Odd: ["Unknown command"] },
      });
      for (const [script, text] of [["Nope", "no script Nope"], ["Odd", "Unknown command"], ["Silent", "(no output)"]]) {
        const res = await h.call("run_script", { script });
        expect(res.isError).toBe(true);
        expect(res.content?.[0]?.text).toBe(text);
      }
      expect(sent().every((c) => c.startsWith("mcp_runscript "))).toBe(true);
    });
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
    expect(named.content?.[0]).toEqual({ type: "text", text: abs("/shots/wall_1.png") });
    expect(named.structuredContent).toEqual({ path: abs("/shots/wall_1.png") });
    expect(await h.text("screenshot_file")).toBe(abs("/shots/auto.png"));
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

describe("stepTics and logPattern", () => {
  const cmds = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
  /** An engine log read as `before` for the baseline, then `before + after` for every read after it. */
  function growingLog(before: string, after: string): Partial<ContextIo> {
    let reads = 0;
    return { existsSync: () => true, readTextSync: () => (reads++ === 0 ? before : before + after) };
  }
  const acsIo: Partial<ContextIo> = {
    compileAcs: () => ({ ok: true, dir: "/tmp/mcp-runacs-1", object: "/tmp/mcp-runacs-1/snippet.o", token: "/tmp/mcp-runacs-1/snippet.o" }),
    removeDir: () => {},
    readFileSync: () => buildBehaviorAcse([], []),
  };
  const ACTIONS = [
    { tool: "run_command", args: { text: "god" }, head: "god out", output: ["god out"], responses: { god: ["god out"] }, io: {} },
    { tool: "run_script", args: { script: 12 }, head: "ran 12", output: [], responses: {}, io: {} },
    {
      tool: "run_acs",
      args: { source: "x", script: 1 },
      head: "loaded snippet as module 2 (3 script(s)), started 1",
      output: [],
      responses: { mcp_runacs: ["MCP_RUNACS module=2 scripts=3 started=1 deferred=0"] },
      io: acsIo,
    },
  ];
  type Action = (typeof ACTIONS)[number];
  const start = (a: Action, log: Partial<ContextIo> | undefined, opts: LiveOptions = {}) =>
    live({ responses: a.responses, config: { exe: "/engine/zandronum" }, ...opts, io: { ...a.io, ...log } });

  it.each(ACTIONS)("$tool steps after the action and returns only the new log lines, sentinels dropped", async (a) => {
    const h = await start(a, growingLog("a\nb\n", "__MCPDONE_9__\nGod ON\n"));
    const res = await h.call(a.tool, { ...a.args, stepTics: 2 });
    await settle(() => bridge!.pauses.length === 2);
    expect(bridge!.pauses).toEqual([0, 1]);
    const text = res.content?.[0]?.text ?? "";
    expect(text.startsWith(a.head)).toBe(true);
    expect(text).toContain(`${a.head}\nlog after 2 tic(s):\nGod ON`);
    expect(text).not.toMatch(/MCPDONE|\n[ab]\n/);
    expect(res.structuredContent).toMatchObject({ output: a.output, log: ["God ON"], logOmitted: 0, logNextLine: 4 });
  });

  it.each(ACTIONS)("$tool filters the stepped lines with logPattern and names it", async (a) => {
    const h = await start(a, growingLog("tick 0\n", "God ON\ntick 1\nTICK 2\n"));
    const text = (await h.call(a.tool, { ...a.args, stepTics: 2, logPattern: "tick" })).content?.[0]?.text;
    expect(text).toContain("log after 2 tic(s) matching /tick/:\ntick 1\nTICK 2");
    expect(text).not.toMatch(/God ON|tick 0/);
  });

  it.each(ACTIONS)("$tool caps the lines and names a read_log resume point", async (a) => {
    const lines = Array.from({ length: 53 }, (_, i) => `l${i + 1}\n`).join("");
    const h = await start(a, growingLog("a\n", lines));
    const res = await h.call(a.tool, { ...a.args, stepTics: 2 });
    const text = res.content?.[0]?.text ?? "";
    expect(text).toContain("\nl1\n");
    expect(text).toContain("\nl50\n(3 more line(s); read_log sinceLine=51)");
    expect(text).not.toContain("l51");
    expect(res.structuredContent).toMatchObject({ logOmitted: 3, logNextLine: 51 });
    expect((res.structuredContent?.log as string[]).length).toBe(50);
    const filtered = await (await start(a, growingLog("a\n", lines))).call(a.tool, { ...a.args, stepTics: 2, logPattern: "l" });
    expect(filtered.content?.[0]?.text).toContain("(3 more line(s); read_log sinceLine=51 pattern=l)");
  });

  it.each(ACTIONS)("$tool says when there is no engine log to read, with no log keys", async (a) => {
    const h = await start(a, undefined);
    const res = await h.call(a.tool, { ...a.args, stepTics: 1 });
    expect(res.content?.[0]?.text).toContain(`${a.head}\nran 1 tic(s); no engine log to read`);
    expect(res.structuredContent?.log).toBeUndefined();
    expect(res.structuredContent?.logNextLine).toBeUndefined();
    expect(res.structuredContent?.output).toEqual(a.output);
    expect(res.structuredContent?.notes).toContain("ran 1 tic(s); no engine log to read");
  });

  it.each(ACTIONS)("$tool refuses logPattern without stepTics, or stepTics without the time cap, sending nothing", async (a) => {
    const h = await start(a, undefined, { caps: ["cmd"] });
    const pattern = await h.call(a.tool, { ...a.args, logPattern: "x" });
    expect(pattern.isError).toBe(true);
    expect(pattern.content?.[0]?.text).toBe("logPattern needs stepTics");
    const capless = await h.call(a.tool, { ...a.args, stepTics: 3 });
    expect(capless.isError).toBe(true);
    expect(capless.content?.[0]?.text).toMatch(/no time-control support/);
    expect(cmds()).toEqual([]);
  });

  it.each([...ACTIONS, { tool: "step", args: { tics: 2 }, head: "", responses: {}, io: {} }])(
    "$tool rejects an invalid logPattern in schema validation, before anything is sent",
    async (a) => {
      const h = await start(a, growingLog("", "x\n"));
      const step = a.tool === "step" ? {} : { stepTics: 2 };
      const res = await h.call(a.tool, { ...a.args, ...step, logPattern: "(" });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/not a valid regex/);
      expect(cmds()).toEqual([]);
      expect(bridge!.pauses).toEqual([]);
    },
  );

  it("refreshes status after the step, so the engine-state note doesn't predate it", async () => {
    const h = await live({ caps: ["cmd", "event", "time", "status"], responses: { god: ["god out"] } });
    bridge!.clearReceived();
    await h.call("run_command", { text: "god", stepTics: 2 });
    expect(cmds().map((t) => t.replace(/__MCPDONE_\w+__/, "S"))).toEqual(["god ; mcp_status S", "mcp_status S"]);
  });

  it("run_command trims each raw print's newline from output, as the step log does", async () => {
    const h = await live({ caps: ["cmd", "event", "time"], responses: { mark: ["MCP_MARK n=1 tic=5\n", "second\n"] } });
    const res = await h.call("run_command", { text: "mark", stepTics: 1 });
    expect(res.structuredContent?.output).toEqual(["MCP_MARK n=1 tic=5", "second"]);
    expect(res.content?.[0]?.text).toMatch(/^MCP_MARK n=1 tic=5\nsecond\n\S/);
  });

  it("run_command without stepTics replies with the cleaned lines: no colour escapes or blank lines", async () => {
    const h = await live({ caps: ["cmd"], responses: { hdr: ["\x1cIAll scripts:\n", "\n", "row 1\n"] } });
    const res = await h.call("run_command", { text: "hdr" });
    expect(res.content?.[0]?.text).toBe("All scripts:\nrow 1");
    expect(res.structuredContent).toBeUndefined();
  });

  it("merges the step log into run_script's structured result", async () => {
    const h = await live({
      caps: ["cmd", "event", "time", "runscript"],
      responses: { mcp_runscript: ["MCP_RUNSCRIPT script=12 started=1 result=42 finished=0 module=0"] },
      config: { exe: "/engine/zandronum" },
      io: growingLog("", "tick\n"),
    });
    const res = await h.call("run_script", { script: 12, stepTics: 5 });
    expect(res.content?.[0]?.text).toBe(
      "ran 12 (module 0): result 42 (paused at a delay or a wait: the result is its value so far)\nlog after 5 tic(s):\ntick",
    );
    expect(res.structuredContent).toEqual({
      result: 42, finished: false, started: true, module: 0, output: [], log: ["tick"], logOmitted: 0, logNextLine: 1,
    });
  });

  it("leaves notes out of a structured reply that has no caveat lines", async () => {
    const h = await live({
      caps: ["cmd", "event", "time", "runscript"],
      responses: { mcp_runscript: ["MCP_RUNSCRIPT script=12 started=1 result=7 finished=1 module=0"] },
      config: { exe: "/engine/zandronum" },
      io: growingLog("", "tick\n"),
    });
    const res = await h.call("run_script", { script: 12, stepTics: 5 });
    expect(res.content?.[0]?.text).toBe("ran 12 (module 0): result 7\nlog after 5 tic(s):\ntick");
    expect(res.structuredContent).toMatchObject({ result: 7, finished: true, log: ["tick"] });
    expect(res.structuredContent).not.toHaveProperty("notes");
  });

  it("run_command adds its output to the structured half only with stepTics", async () => {
    const h = await live({ responses: { god: ["god out"] }, config: { exe: "/engine/zandronum" }, io: growingLog("", "tick\n") });
    const plain = await h.call("run_command", { text: "god" });
    expect(plain.content).toEqual([{ type: "text", text: "god out" }]);
    expect(plain.structuredContent).toBeUndefined();
  });

  it("step reads the log after its last status round trip, so the last tic's lines are in it", async () => {
    let probes = 0;
    const log = () => Array.from({ length: probes }, (_, i) => `p${i + 1}\n`).join("");
    const h = await live({
      caps: ["cmd", "event", "time", "status"],
      config: { exe: "/engine/zandronum" },
      io: { existsSync: () => true, readTextSync: log },
    });
    bridge!.onCommand("", (c) => void (c === "" && probes++));
    const res = await h.call("step", { tics: 3 });
    expect((res.structuredContent as { log: string[] }).log.at(-1)).toBe(`p${probes}`);
  });

  it("step appends the log lines printed meanwhile, filtered by logPattern", async () => {
    const h = await live({ config: { exe: "/engine/zandronum" }, io: growingLog("old\n", "God ON\ntick 1\n") });
    const res = await h.call("step", { tics: 3 });
    expect(res.content?.[0]?.text).toBe("advanced ~3 tic(s)\nlog after 3 tic(s):\nGod ON\ntick 1");
    expect(res.structuredContent).toEqual({ log: ["God ON", "tick 1"], logOmitted: 0, logNextLine: 3, notes: ["advanced ~3 tic(s)"] });
    const h2 = await live({ config: { exe: "/engine/zandronum" }, io: growingLog("old\n", "God ON\ntick 1\n") });
    expect(await h2.text("step", { tics: 3, logPattern: "^tick" })).toBe("advanced ~3 tic(s)\nlog after 3 tic(s) matching /^tick/:\ntick 1");
  });

  it("step replies exactly as before on a quiet window or with no engine log", async () => {
    const quiet = await live({ config: { exe: "/engine/zandronum" }, io: growingLog("old\n", "__MCPDONE_3__\n") });
    const res = await quiet.call("step", { tics: 7 });
    expect(res.content).toEqual([{ type: "text", text: "advanced ~7 tic(s)" }]);
    expect(res.structuredContent).toEqual({ log: [], logOmitted: 0, logNextLine: 2, notes: ["advanced ~7 tic(s)"] });
    const unlogged = await live();
    const bare = await unlogged.call("step", { tics: 7 });
    expect(bare.content).toEqual([{ type: "text", text: "advanced ~7 tic(s)" }]);
    expect(bare.structuredContent).toBeUndefined();
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

describe("map vars by sourceFile", () => {
  const DIGEST = MAPSLOT_DIGESTS.mapslot;
  const LIB = { name: "acs/mapslot.o", data: buildBehaviorAcse([], []) };
  const SRC = "/mods/src/mapslot.bcs";
  const CAPS = ["cmd", "event", "time", "mapslot"];
  const HEAD = `mcp_mapslot 4 v=1 code=44 first=SPTR md5=${DIGEST.md5}`;

  /** IO whose resolveMapSlot records each request and answers `result`; launch files read as one library. */
  function resolver(result: MapSlotResult) {
    const seen: MapSlotRequest[] = [];
    const io: Partial<ContextIo> = {
      resolveMapSlot: (r) => (seen.push(r), result),
      readFileSync: () => LIB.data,
    };
    return { seen, io };
  }
  /** A live harness with the mapslot cap, its instance launched with `args`. */
  async function launched(io: Partial<ContextIo>, responses: Record<string, string[]> = {}, args: LaunchArgs = { files: ["/mods/mapslot.o"] }) {
    const h = await live({ caps: CAPS, io, responses, config: { bcc: " /opt/bcc " } });
    h.ctx.rememberLaunchArgs(1, args, bridge!.port, "/tmp/log");
    return h;
  }
  const sent = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
  const scalar = { slot: 4, digest: DIGEST, module: LIB };

  it("refuses object or includeDirs without sourceFile, sending nothing", async () => {
    const h = await live({ caps: CAPS });
    for (const extra of [{ object: "/x.pk3" }, { includeDirs: ["/inc"] }]) {
      const result = await h.call("get_map_var", { name: "v", ...extra });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe("object and includeDirs need sourceFile");
    }
    expect(sent()).toEqual([]);
  });

  it("refuses on a bridge without the mapslot cap, compiling nothing", async () => {
    const r = resolver(scalar);
    const h = await live({ io: r.io });
    const result = await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/^This engine build has no slot-addressed map var access for sourceFile/);
    expect(r.seen).toEqual([]);
  });

  it("asks for object when the instance has no launch files", async () => {
    for (const args of [{}, { files: [] }]) {
      const r = resolver(scalar);
      const h = await launched(r.io, {}, args);
      const result = await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC });
      expect(result.content?.[0]?.text).toBe(
        "instance 1 has no launch files to find the source's build in (attached, or launched without files): pass object, the deployed file",
      );
      expect(r.seen).toEqual([]);
      await harness?.close();
      await bridge?.close();
    }
    const r = resolver(scalar);
    const h = await live({ caps: CAPS, io: r.io });
    expect((await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC })).content?.[0]?.text).toMatch(/pass object/);
  });

  it("resolves against the launch files' modules, or object's, and names the refusing guard, sending nothing", async () => {
    const r = resolver({ guard: "deployed", refused: "build A equals no deployed module" });
    const h = await launched(r.io);
    const result = await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC, includeDirs: ["/inc"] });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("ms_hid refused by the deployed check, nothing sent to the engine: build A equals no deployed module");
    expect(r.seen).toEqual([{ sourceFile: SRC, expr: "ms_hid", exe: "/opt/bcc", includeDirs: ["/inc"], deployed: [{ name: "mapslot.o", data: LIB.data }], engine }]);
    await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC, object: "/other/lib.o" });
    expect(r.seen[1]).toMatchObject({ deployed: [{ name: "lib.o" }], includeDirs: undefined });
    expect(sent()).toEqual([]);
  });

  it("keeps the engine-state footer on a no-launch-files source refusal", async () => {
    const h = await live({ caps: [...CAPS, "status"] });
    bridge!.setStatus({ menu: "on" });
    const res = await h.call("get_map_var", { name: "v", sourceFile: SRC });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toContain("pass object, the deployed file");
    expect(res.content?.at(-1)?.text).toBe("Engine state: a menu is open.");
    expect(sent().some((c) => c.startsWith("mcp_mapslot"))).toBe(false);
  });

  it("passes over a launch file that holds no ACS, such as a DEHACKED patch", async () => {
    const r = resolver({ guard: "deployed", refused: "x" });
    const deh = Buffer.from("Patch File for DeHackEd v3.0\n");
    const h = await launched({ ...r.io, readFileSync: (p) => (p.endsWith(".deh") ? deh : LIB.data) }, {}, { files: ["/mods/x.deh", "/mods/mapslot.o"] });
    await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC });
    expect(r.seen[0].deployed).toEqual([{ name: "mapslot.o", data: LIB.data }]);
  });

  it("reads relative launch files from the engine's folder and refuses an unreadable one by name", async () => {
    const r = resolver({ guard: "deployed", refused: "x" });
    const read: string[] = [];
    const readFileSync = (p: string) => {
      read.push(p);
      if (p.endsWith("gone.pk3")) throw new Error(`ENOENT: ${p}`);
      return LIB.data;
    };
    const h = await launched({ ...r.io, readFileSync }, {}, { files: ["mods/mapslot.o"] });
    h.ctx.rememberLaunchArgs(1, { files: ["mods/mapslot.o"] }, bridge!.port, "/games/zan/mcp-bridge-1.log");
    await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC });
    expect(read).toEqual([abs("/games/zan/mods/mapslot.o")]);
    h.ctx.rememberLaunchArgs(1, { files: ["gone.pk3", "mods/mapslot.o"] }, bridge!.port, "/games/zan/mcp-bridge-1.log");
    const result = await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(`can't read ${abs("/games/zan/gone.pk3")} to find the source's build in: ENOENT: ${abs("/games/zan/gone.pk3")}`);
    expect(r.seen).toHaveLength(1);
  });

  it("searches PATH for the compiler when the configured one is blank", async () => {
    const r = resolver({ guard: "compile", refused: "x" });
    const h = await live({ caps: CAPS, io: r.io, config: { bcc: "  " } });
    await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC, object: "/lib.o" });
    expect(r.seen[0].exe).toBeUndefined();
  });

  it("reads and writes a scalar by slot, checking the reply echoes what was sent", async () => {
    const r = resolver(scalar);
    const reply = ["MCP_MAPSLOT module=0 slot=4 value=103 name=MAPSLOT"];
    const h = await launched(r.io, { "mcp_mapslot 4 v=1": reply });
    const got = await h.call("get_map_var", { name: "ms_hid", sourceFile: SRC });
    expect(got.content?.[0]?.text).toBe("103 (slot 4 of module 0 MAPSLOT, acs/mapslot.o)");
    expect(got.structuredContent).toEqual({ name: "ms_hid", value: 103, slot: 4, module: { id: 0, name: "MAPSLOT", deployed: "acs/mapslot.o" } });
    expect(sent()[0]).toMatch(new RegExp(`^${HEAD} ;`));
    reply[0] = "MCP_MAPSLOT module=0 slot=4 value=7 name=MAPSLOT";
    expect(await h.text("set_map_var", { name: "ms_hid", value: 7, sourceFile: SRC })).toBe("ms_hid = 7 (slot 4 of module 0 MAPSLOT, acs/mapslot.o)");
    expect(sent()[1]).toMatch(new RegExp(`^${HEAD} set=7 ;`));
    // A reply with another value, slot or index than the ones sent.
    for (const body of ["slot=4 value=8", "slot=5 value=7", "slot=4 index=0 value=7"]) {
      reply[0] = `MCP_MAPSLOT module=0 ${body} name=MAPSLOT`;
      const bad = await h.call("set_map_var", { name: "ms_hid", value: 7, sourceFile: SRC });
      expect(bad.isError).toBe(true);
      expect(bad.content?.[0]?.text).toBe(`the engine's reply doesn't echo the slot, index and value sent (${HEAD} set=7): ${reply[0]}`);
    }
  });

  it("reads and writes an array element at name[index], sending the resolved offset", async () => {
    const r = resolver({ slot: 6, index: 5, digest: DIGEST, module: LIB });
    const head = "mcp_mapslot 6 v=1 code=44 first=SPTR";
    const reply = ["MCP_MAPSLOT module=1 slot=6 index=5 value=104 name=MAPSLOT"];
    const h = await launched(r.io, { [head]: reply });
    const got = await h.call("get_map_array", { name: "ms_hid_arr", index: 2, sourceFile: SRC });
    expect(r.seen[0].expr).toBe("ms_hid_arr[2]");
    expect(got.content?.[0]?.text).toBe("104 (slot 6[5] of module 1 MAPSLOT, acs/mapslot.o)");
    expect(got.structuredContent).toEqual({
      name: "ms_hid_arr",
      index: 2,
      value: 104,
      slot: 6,
      offset: 5,
      module: { id: 1, name: "MAPSLOT", deployed: "acs/mapslot.o" },
    });
    expect(sent()[0]).toMatch(new RegExp(`^${head} md5=${DIGEST.md5} index=5 ;`));
    reply[0] = "MCP_MAPSLOT module=1 slot=6 index=5 value=9 name=MAPSLOT";
    expect(await h.text("set_map_array", { name: "ms_hid_arr", index: 2, value: 9, sourceFile: SRC })).toBe(
      "ms_hid_arr[2] = 9 (slot 6[5] of module 1 MAPSLOT, acs/mapslot.o)",
    );
    expect(sent()[1]).toMatch(/ index=5 set=9 ;/);
    // An element reply without its index, or with another, is not the one sent.
    for (const body of ["slot=6 value=104", "slot=6 index=4 value=104"]) {
      reply[0] = `MCP_MAPSLOT module=1 ${body} name=MAPSLOT`;
      expect((await h.call("get_map_array", { name: "ms_hid_arr", index: 2, sourceFile: SRC })).isError).toBe(true);
    }
  });

  it("explains a loaded module that isn't the one resolved, naming the map and the module's kind", async () => {
    const nomatch = { "mcp_mapslot 4": ["error no module matches map=NMORIG modules=3"] };
    const lib = await launched(resolver(scalar).io, nomatch);
    expect(await lib.text("get_map_var", { name: "ms_hid", sourceFile: SRC })).toBe(
      `The loaded module isn't the one resolved: none of the 3 loaded on map NMORIG matches acs/mapslot.o (a library), built from ${SRC}. ` +
        "Another map is loaded, the map has no BEHAVIOR of its own, or the file was rebuilt after launch (relaunch to load it).",
    );
    await harness?.close();
    await bridge?.close();
    const map = { name: "maps/ARENA.WAD:ARENA", data: LIB.data, map: "ARENA" };
    const beh = await launched(resolver({ ...scalar, module: map }).io, nomatch);
    expect(await beh.text("get_map_var", { name: "round_num", sourceFile: SRC })).toMatch(
      /matches maps\/ARENA\.WAD:ARENA \(the BEHAVIOR of map ARENA\), built from/,
    );
  });

  it("passes any other engine refusal through", async () => {
    const reply = ["error ambiguous modules=1,2"];
    const h = await launched(resolver(scalar).io, { "mcp_mapslot 4": reply });
    expect(await h.text("get_map_var", { name: "ms_hid", sourceFile: SRC })).toBe("ambiguous modules=1,2");
    reply.length = 0;
    expect(await h.text("get_map_var", { name: "ms_hid", sourceFile: SRC })).toBe("(no output)");
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
    const pk3Entries = [
      { name: "acs/mymod.o", data: buildBehaviorExports(["credits", "round"], [{ index: 0, size: 17 }]) },
      { name: "acs/other.o", data: buildBehaviorExports(["x"]) },
    ];
    const pk3 = buildZip(pk3Entries);

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

    it("matches a map's BEHAVIOR by BEHAVIOR or its marker", async () => {
      const inner = buildWad("PWAD", [
        { name: "ARENA" },
        { name: "THINGS" },
        { name: "BEHAVIOR", data: buildBehaviorExports(["m"]) },
      ]);
      const withMap = buildZip([...pk3Entries, { name: "maps/ARENA.WAD", data: inner }]);
      const h = await offline({}, { readFileSync: () => withMap });
      for (const lump of ["BEHAVIOR", "arena"]) {
        expect(await h.text("list_map_exports", { file: "/mods/x.pk3", lump })).toBe(
          "maps/ARENA.WAD:ARENA: 1 export(s)\n  0: m",
        );
      }
    });

    it("names a raw compiled file after itself", async () => {
      const h = await offline({}, { readFileSync: () => buildBehaviorExports(["v"]) });
      expect(await h.text("list_map_exports", { file: "/build/lib.o" })).toBe("lib.o: 1 export(s)\n  0: v");
    });

    it("walks a launch directory, naming modules by relative path", async () => {
      const dir = path.join("/mods/res");
      const h = await offline({}, {
        isDirSync: (p) => p === dir || p === path.join(dir, "acs"),
        readdirSync: (p) => (p === dir ? ["acs"] : ["lib.o"]),
        readFileSync: () => buildBehaviorExports(["v"]),
      });
      expect(await h.text("list_map_exports", { file: dir })).toBe("acs/lib.o: 1 export(s)\n  0: v");
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
  it("lists savegames with metadata from the engine's save reader", async () => {
    // The save format is the engine's; its reader is tested in each repo's local save-reader test.
    const reads: string[] = [];
    const readSaveMeta: EngineAdapter["readSaveMeta"] = (file, buf) => {
      reads.push(`${file}:${buf.toString()}`);
      return { file, title: "My Save", map: "MAP07", engine: null, gameWad: null, created: null };
    };
    harness = await startHarness({
      engine: { ...engine, readSaveMeta },
      config: { saveDir: "/saves" },
      io: {
        existsSync: () => true,
        readdirSync: () => ["a.zds", "B.ZDS", "notes.txt"],
        readFileSync: (p) => Buffer.from(path.basename(p)),
      },
    });
    const result = await harness.call("list_saves");
    expect(result.content?.[0]?.text).toBe("2 save(s) in /saves");
    expect(reads).toEqual(["a.zds:a.zds", "B.ZDS:B.ZDS"]);
    expect(result.structuredContent?.saves).toMatchObject([{ file: "a.zds", title: "My Save", map: "MAP07" }, { file: "B.ZDS" }]);
  });

  describe("per-game save subfolders", () => {
    const tree: Record<string, string[]> = {
      "/root": ["doom.id.doom2.commercial", "top.zds"],
      [path.join("/root", "doom.id.doom2.commercial")]: ["save01.zds", "x.txt"],
    };
    const readSaveMeta: EngineAdapter["readSaveMeta"] = (file) =>
      ({ file, title: null, map: null, engine: null, gameWad: null, created: null });
    const withSubdirs = async (saveSubdirs: boolean, read: string[] = []) => {
      harness = await startHarness({
        engine: { ...engine, readSaveMeta, saveSubdirs },
        config: { saveDir: "/root" },
        io: {
          existsSync: () => true,
          readdirSync: (p) => tree[p]!,
          isDirSync: (p) => p in tree,
          readFileSync: (p) => (read.push(p), Buffer.alloc(0)),
        },
      });
      return harness;
    };

    it("scans one subfolder level when the engine keeps per-game folders", async () => {
      const read: string[] = [];
      const result = await (await withSubdirs(true, read)).call("list_saves");
      expect(result.content?.[0]?.text).toBe("2 save(s) in /root");
      expect(result.structuredContent?.saves).toMatchObject([
        { file: "top.zds" },
        { file: path.join("doom.id.doom2.commercial", "save01.zds") },
      ]);
      expect(read).toEqual([path.join("/root", "top.zds"), path.join("/root", "doom.id.doom2.commercial", "save01.zds")]);
    });

    it("lists only the save dir itself otherwise", async () => {
      const result = await (await withSubdirs(false)).call("list_saves");
      expect(result.structuredContent?.saves).toMatchObject([{ file: "top.zds" }]);
    });
  });

  it("reports no saves when the save dir doesn't exist yet", async () => {
    const h = await offline({ saveDir: "/saves" });
    expect(await h.text("list_saves")).toBe("0 save(s) in /saves");
  });

  it("refuses an explicit dir that doesn't exist, rather than reporting no saves", async () => {
    const h = await offline({ saveDir: "/saves" });
    const r = await h.call("list_saves", { dir: "/savse" });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toBe("no such directory: /savse");
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

    it("settles on the first probe when the overlay sends no pending= field", async () => {
      const h = await live(statusCaps);
      bridge!.clearReceived();
      expect(await h.text("load_map", { mapName: "MAP02" })).toBe("loaded MAP02");
      expect(probes()).toHaveLength(1);
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

    it("strips an engine's own console bar line (UZDoom's 40 hyphens) before the banner", async () => {
      const h = await live({ ...statusCaps, engine: { ...engine, consoleBar: /^-{40}$/ } });
      // UZDoom's g_level.cpp: "\n" TEXTCOLOR_NORMAL "%s\n\n" TEXTCOLOR_BOLD "%s - %s\n\n", console_bar first.
      bridge!.respondTo("map MAP01", [], ["\n\x1c-" + "-".repeat(40) + "\n\n\x1c+MAP01 - entryway\n\n"]);
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

    it("doesn't poll while focus-paused, since no tic runs the load until pauseext clears", async () => {
      const h = await live(statusCaps);
      bridge!.clearReceived();
      bridge!.setStatus({ pending: "1", pauseext: "1" });
      const result = await h.call("load_map", { mapName: "MAP02" });
      expect(result.content?.[0]?.text).toBe(
        "(focus-paused (pauseext): the load runs once ensure_live fix clears it)",
      );
      expect(probes()).toHaveLength(0);
    });

    it("adds no pauseext caveat when the command queued nothing, e.g. an unknown map", async () => {
      const h = await live(statusCaps);
      bridge!.setStatus({ pauseext: "1" });
      bridge!.respondTo("map MAP99", ["No map MAP99"]);
      expect(await h.text("load_map", { mapName: "MAP99" })).toBe("No map MAP99");
    });
  });
});

describe("live state tools", () => {
  it.each([
    ["Zandronum", "lightlevel: 144"],
    ["UZDoom", "sector lightlevel: 144, actor lightlevel: -1"],
  ])("reads %s player state", async (_e, light) => {
    const h = await live({
      responses: {
        currentpos: [
          `Current player position: (128.500,-64.000,0.000), angle: 270.000, floorheight: -8.000, sector:12, ${light}`,
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
    expect(result.structuredContent?.omitted).toEqual({ text: 0, images: 0, messages: 0 });
  });

  it("caps read_hud at 100 per kind by default and says what it left out", async () => {
    const strings = Array.from({ length: 103 }, (_, i) => `text ${i} 0 line ${i}`);
    const h = await live({ responses: { dumphud: ["MCP_HUD", ...strings, "image 0 0 STBAR"] } });
    const result = await h.call("read_hud");
    expect(result.content?.[0]?.text).toBe(
      "100 strings, 1 images, 0 hud messages (omitted: 3 strings, 0 images, 0 messages; narrow with pattern/region or raise maxItems)",
    );
    expect((result.structuredContent?.text as unknown[]).length).toBe(100);
    expect(result.structuredContent?.omitted).toEqual({ text: 3, images: 0, messages: 0 });
    expect(await h.text("read_hud", { maxItems: 200 })).toBe("103 strings, 1 images, 0 hud messages");
  });

  it("filters read_hud by pattern and region", async () => {
    const h = await live({
      responses: {
        dumphud: ["MCP_HUD", "text 100 50 New Game", "text 100 70 Options", "image 0 168 STBAR", "image 300 0 M_DOOM", "msg 0 0.5 0.9 70 Game saved"],
      },
    });
    const byPattern = await h.call("read_hud", { pattern: "game" });
    expect(byPattern.content?.[0]?.text).toBe("1 strings, 0 images, 1 hud messages");
    expect(byPattern.structuredContent).toMatchObject({ text: [{ x: 100, y: 50, text: "New Game" }], images: [] });
    const byRegion = await h.call("read_hud", { region: { x: 0, y: 160, w: 320, h: 40 } });
    expect(byRegion.structuredContent).toMatchObject({ text: [], images: [{ x: 0, y: 168, name: "STBAR" }] });
    expect((byRegion.structuredContent?.messages as unknown[]).length).toBe(1);
  });

  it("refuses an invalid read_hud pattern before sending dumphud", async () => {
    const h = await live({ responses: { dumphud: ["MCP_HUD", "text 0 0 x"] } });
    const res = await h.call("read_hud", { pattern: "(" });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toMatch(/not a valid regex/);
    expect(bridge!.received.some((m) => m.t === "cmd" && m.text?.startsWith("dumphud"))).toBe(false);
  });

  it("lists nearby actors, with and without an explicit radius", async () => {
    const h = await live({ responses: { actorsnear: ["MCP_ACTORS", "near DoomImp 60 100.0 200.0 TROO"] } });
    expect(await h.text("actors_near")).toBe("1 actor(s) nearby");
    await h.call("actors_near", { radius: 256 });
    const sent = bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
    expect(sent[1]).toMatch(/^actorsnear 256/);
  });

  it.each(["Target", "Class"])("inspects the aimed target from a %s= reply", async (key) => {
    const h = await live({ responses: { linetarget: [`${key}=DoomImp, Health=60, Spawnhealth=60`] } });
    const hit = await h.call("inspect_target");
    expect(hit.structuredContent).toMatchObject({ target: "DoomImp", health: 60 });
  });

  it("reports no target in view", async () => {
    const h = await live();
    expect(await h.text("inspect_target")).toBe("no target in view");
  });
});

describe("test-session tools", () => {
  const cmds = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
  const withStatus = (opts: LiveOptions = {}) =>
    live({ ...opts, caps: ["cmd", "event", "time", "status"] });

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
    it("refuses while focus-paused, since the toggle would be deferred", async () => {
      const h = await withStatus();
      bridge!.setStatus({ pauseext: "1" });
      bridge!.clearReceived();
      const res = await h.call("set_cheat", { name: "god", on: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/pauseext.*ensure_live with fix/);
      expect(cmds().some((c) => c.startsWith("god"))).toBe(false);
    });

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

    // The free-spot search is its own bridge cap: an older overlay would ignore find= silently.
    const findCaps = ["cmd", "event", "time", "spawnfind"];

    it("sends findSpot as find= and reports how far the actor moved", async () => {
      const h = await live({
        caps: findCaps,
        responses: { "DoomImp 5 ": [SPAWNED], mcp_spawnat: [SPAWNED.replace("x=100.0", "x=140.0") + " moved=40"] },
      });
      const res = await h.call("summon_at", { className: "DoomImp", x: 100, y: -32.5, kind: "foe", findSpot: 128, health: 5 });
      expect(cmds()[0]).toMatch(/^mcp_spawnat DoomImp 100 -32\.5 kind=foe find=128 health=5 ;/);
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ class: "DoomImp", x: 140, y: -32.5, moved: 40 });
      expect(res.content?.[0]?.text).toBe(
        "spawned DoomImp tid=7 at 140,-32.5,0 (moved 40 from the blocked spot); follow up with actor_state(tid 7) / find_actors(class, tid)",
      );
      // A free spot is taken as is: the engine prints no moved=, and the text says nothing of it.
      const free = await h.call("summon_at", { className: "DoomImp", x: 5, y: 0, findSpot: 0.5, force: false });
      expect(cmds()[1]).toMatch(/^mcp_spawnat DoomImp 5 0 find=0\.5 ;/);
      expect(free.structuredContent).not.toHaveProperty("moved");
      expect(free.content?.[0]?.text).toMatch(/^spawned DoomImp tid=7 at 100,-32\.5,0; follow up/);
    });

    it("rejects findSpot with force before sending anything", async () => {
      const h = await live();
      const res = await h.call("summon_at", { className: "DoomImp", x: 1, y: 2, findSpot: 64, force: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("findSpot needs force off");
      expect(cmds()).toHaveLength(0);
    });

    it("refuses findSpot on a bridge without the spawnfind cap, before sending anything", async () => {
      const h = await live({ responses: { mcp_spawnat: [SPAWNED] } });
      const res = await h.call("summon_at", { className: "DoomImp", x: 1, y: 2, findSpot: 64 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/^This engine build has no free-spot search for findSpot/);
      expect(cmds()).toHaveLength(0);
      // Without findSpot the same bridge spawns as before.
      expect((await h.call("summon_at", { className: "DoomImp", x: 1, y: 2 })).isError).toBeFalsy();
    });

    it("reports an exhausted search with the requested spot's own reason", async () => {
      const h = await live({
        caps: findCaps,
        responses: { mcp_spawnat: ["error no free spot within 8: blocked by player0"] },
      });
      const res = await h.call("summon_at", { className: "DoomImp", x: 1, y: 2, findSpot: 8 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("no free spot within 8: blocked by player0");
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

  describe("set_actor_prop", () => {
    const HEAD = "class=DoomImp tid=7 hp=60 spawnhp=60 x=1.0 y=2.0 z=0.0 angle=0.0 pitch=0.0 flags=mso";
    const reply = (fields: string, extra = "", name = "Imp") => [`setprop ${fields} ${HEAD}${extra} name=${name}`];

    it("writes one prop of each type and reports old -> new", async () => {
      const h = await live({
        responses: {
          "7 0 speed": reply("prop=speed old=8 new=20.5"),
          "7 0 mass": reply("prop=mass old=100 new=50"),
          "7 0 friendly": reply("prop=friendly old=0 new=1"),
          "7 0 renderstyle": reply("prop=renderstyle old=NORMAL new=TRANSLUCENT"),
          "7 0 flag:NOGRAVITY": reply("prop=flag:NOGRAVITY old=0 new=1"),
          "0 0 height": reply("prop=height old=56 new=40"),
        },
      });
      const res = await h.call("set_actor_prop", { tid: 7, prop: "speed", value: 20.5 });
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("DoomImp#7 speed: 8 -> 20.5");
      expect(res.structuredContent).toMatchObject({ prop: "speed", old: 8, new: 20.5, class: "DoomImp", flags: "monster,shootable,solid", name: "Imp" });
      expect(await h.text("set_actor_prop", { tid: 7, prop: "mass", value: 50 })).toBe("DoomImp#7 mass: 100 -> 50");
      expect(await h.text("set_actor_prop", { tid: 7, prop: "friendly", value: true })).toBe("DoomImp#7 friendly: 0 -> 1");
      await h.call("set_actor_prop", { tid: 7, prop: "renderstyle", value: "Translucent" });
      await h.call("set_actor_prop", { tid: 7, prop: "flag:NOGRAVITY", value: true });
      await h.call("set_actor_prop", { prop: "height", value: 40, force: true });
      await h.call("set_actor_prop", { tid: 0, prop: "height", value: 40, force: false });
      expect(cmds()[0]).toMatch(/^mcp_setprop 7 0 speed 20\.5 ;/);
      expect(cmds()[1]).toMatch(/^mcp_setprop 7 0 mass 50 ;/);
      expect(cmds()[2]).toMatch(/^mcp_setprop 7 0 friendly 1 ;/);
      expect(cmds()[3]).toMatch(/^mcp_setprop 7 0 renderstyle Translucent ;/);
      expect(cmds()[4]).toMatch(/^mcp_setprop 7 0 flag:NOGRAVITY 1 ;/);
      expect(cmds()[5]).toMatch(/^mcp_setprop 0 0 height 40 force=1 ;/);
      expect(cmds()[6]).toMatch(/^mcp_setprop 0 0 height 40 ;/);
    });

    it("reads a prop when value is omitted, and passes index through", async () => {
      const h = await live({ responses: { "7 2 speed": reply("prop=speed old=8") } });
      const res = await h.call("set_actor_prop", { tid: 7, index: 2, prop: "speed" });
      expect(res.content?.[0]?.text).toBe("speed = 8");
      expect(res.structuredContent?.new).toBeUndefined();
      expect(cmds()[0]).toMatch(/^mcp_setprop 7 2 speed ;/);
    });

    it("sends a spaced nametag as tokens and reads it back from name=", async () => {
      const h = await live({
        responses: {
          "nametag Imp Lord": reply("prop=nametag", "", "Imp Lord"),
          nametag: reply("prop=nametag", "", "Imp Lord"),
        },
      });
      const res = await h.call("set_actor_prop", { tid: 7, prop: "nametag", value: "Imp  Lord" });
      expect(res.content?.[0]?.text).toBe("DoomImp#7 nametag: Imp Lord");
      expect(res.structuredContent).toMatchObject({ name: "Imp Lord" });
      expect(res.structuredContent?.old).toBeUndefined();
      expect(await h.text("set_actor_prop", { tid: 7, prop: "nametag" })).toBe("nametag = Imp Lord");
      expect(cmds()[0]).toMatch(/^mcp_setprop 7 0 nametag Imp Lord ;/);
    });

    it("notes died, removed and noop", async () => {
      const h = await live({
        responses: {
          health: reply("prop=health old=60 new=0", " died=1 removed=1"),
          dormant: reply("prop=dormant old=0 new=0", " noop=1"),
        },
      });
      const res = await h.call("set_actor_prop", { tid: 7, prop: "health", value: 0 });
      expect(res.content?.[0]?.text).toBe("DoomImp#7 health: 60 -> 0 (died, removed)");
      expect(res.structuredContent).toMatchObject({ died: 1, removed: 1 });
      expect(await h.text("set_actor_prop", { tid: 7, prop: "dormant", value: true })).toBe("DoomImp#7 dormant: 0 -> 0 (noop)");
    });

    it("refuses bad targeting, force misuse and bad values before sending", async () => {
      const h = await live();
      expect(await h.text("set_actor_prop", { index: 1, prop: "speed" })).toBe("index needs a tid");
      expect(await h.text("set_actor_prop", { tid: 0, index: 1, prop: "speed" })).toBe("index needs a tid");
      const forceMsg = "force only applies to writing height or radius";
      expect(await h.text("set_actor_prop", { tid: 7, prop: "speed", value: 1, force: true })).toBe(forceMsg);
      expect(await h.text("set_actor_prop", { tid: 7, prop: "height", force: true })).toBe(forceMsg);
      const bad = await h.call("set_actor_prop", { tid: 7, prop: "mass", value: 1.5 });
      expect(bad.isError).toBe(true);
      expect(bad.content?.[0]?.text).toBe("bad value 1.5 for mass");
      const unknown = await h.call("set_actor_prop", { tid: 7, prop: "bogus", value: 1 });
      expect(unknown.isError).toBe(true);
      expect(cmds()).toHaveLength(0);
    });

    it("surfaces each engine error shape, or raw output without a setprop line", async () => {
      const errors = [
        "usage: mcp_setprop <tid> <index> <prop> [value...] [force=1]",
        "client: set on the server instance",
        "unsupported prop friction on this engine",
        "not replicated: mass",
        "unsupported prop height on a player pawn on this engine",
        "server: pass a tid",
        "spectator",
        "not replicated: flag:ROCKETTRAIL",
        "not in a level",
        "no actor with tid 9 index 0",
        "unknown prop speed",
        "bad value 1 for speed",
        "unknown flag BOGUS",
        "unknown renderstyle Weird",
        "already dead",
        "blocked floor=0.0 ceiling=128.0 z=0.0 height=200.0",
      ];
      const responses: Record<string, string[]> = { "mcp_setprop 98 ": ["Unknown command"] };
      errors.forEach((e, i) => (responses[`mcp_setprop ${i + 1} `] = [`error ${e}`]));
      const h = await live({ responses });
      for (const [i, e] of errors.entries()) {
        const res = await h.call("set_actor_prop", { tid: i + 1, prop: "speed", value: 1 });
        expect(res.isError).toBe(true);
        expect(res.content?.[0]?.text).toBe(e);
      }
      expect(await h.text("set_actor_prop", { tid: 98, prop: "speed" })).toBe("Unknown command");
      const res = await h.call("set_actor_prop", { tid: 99, prop: "speed" });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("(no output)");
    });
  });

  describe("acting on other actors", () => {
    const HEAD = "class=DoomImp tid=7 hp=60 spawnhp=60 x=1.0 y=2.0 z=0.0 angle=0.0 pitch=0.0";
    const BODY = "class=DoomPlayer tid=0 hp=100 spawnhp=100 x=0.0 y=0.0 z=0.0 angle=90.0 pitch=0.0";
    const refused = async (h: Harness, tool: string, args: Record<string, unknown>, text: string | RegExp) => {
      const res = await h.call(tool, args);
      expect(res.isError).toBe(true);
      if (typeof text === "string") expect(res.content?.[0]?.text).toBe(text);
      else expect(res.content?.[0]?.text).toMatch(text);
    };

    it("takes tid 0 as the player's body in actor_state, and refuses an index without a tid of 1 or more", async () => {
      const h = await live({ responses: { dumpactor: ["MCP_ACTOR", "class DoomPlayer"] } });
      expect((await h.call("actor_state", { tid: 0 })).structuredContent).toMatchObject({ class: "DoomPlayer" });
      expect(cmds()[0]).toMatch(/^dumpactor ;/);
      for (const tool of ["actor_state", "set_actor_prop", "place_actor", "damage_actor", "give", "take"]) {
        const args = { prop: "speed", angle: 1, amount: 1, item: "Clip" };
        await refused(h, tool, { ...args, index: 1 }, "index needs a tid");
        await refused(h, tool, { ...args, tid: 0, index: 1 }, "index needs a tid");
      }
      expect(cmds()).toHaveLength(1);
    });

    it("bounds summon_at coordinates before sending and accepts the endpoints", async () => {
      const h = await live({ responses: { mcp_spawnat: [`spawned ${HEAD}`] } });
      for (const field of ["x", "y", "z"]) {
        await refused(h, "summon_at", { className: "DoomImp", x: 0, y: 0, [field]: 40000 }, /32767/);
        await refused(h, "summon_at", { className: "DoomImp", x: 0, y: 0, [field]: -32768 }, /32767/);
      }
      expect(cmds()).toHaveLength(0);
      const res = await h.call("summon_at", { className: "DoomImp", x: 32767, y: -32767, z: 32767 });
      expect(res.isError).toBeFalsy();
      expect(cmds()[0]).toMatch(/^mcp_spawnat DoomImp 32767 -32767 z=32767 ;/);
    });

    describe("place_actor", () => {
      it("sends only the given fields and reports the actor where it ends up", async () => {
        const placed = `placed ${HEAD.replace("x=1.0", "x=128.5")} fromx=0.0 fromy=2.0 fromz=8.0 vx=1.00 vy=0.00 vz=20.00 flags=mso`;
        const h = await live({
          responses: { "mcp_place 7 2": [`${placed} fog=1 forced=1 name=Imp`], mcp_place: [`${placed} name=Imp`] },
        });
        const res = await h.call("place_actor", {
          tid: 7, index: 2, x: 128.5, y: -64, z: 0, angle: 90, pitch: -10.5, vx: 1, vy: 0, vz: 20,
          addVelocity: true, fog: true, force: true,
        });
        expect(res.isError).toBeFalsy();
        expect(cmds()[0]).toMatch(
          /^mcp_place 7 2 x=128\.5 y=-64 z=0 angle=90 pitch=-10\.5 vx=1 vy=0 vz=20 addvel=1 fog=1 force=1 ;/,
        );
        expect(res.structuredContent).toMatchObject({ class: "DoomImp", x: 128.5, fromz: 8, vz: 20, flags: "monster,shootable,solid", fog: 1, forced: 1, name: "Imp" });
        expect(res.content?.[0]?.text).toBe(
          "DoomImp#7 at 128.5,2,0 (from 0,2,8), angle 0, pitch 0, velocity 1,0,20 (fog, forced)",
        );
        expect(await h.text("place_actor", { angle: 45 })).toBe("DoomImp#7 at 128.5,2,0 (from 0,2,8), angle 0, pitch 0, velocity 1,0,20");
        await h.call("place_actor", { tid: 0, vy: -2.5, addVelocity: false, fog: false, force: false });
        expect(cmds()[1]).toMatch(/^mcp_place 0 0 angle=45 ;/);
        expect(cmds()[2]).toMatch(/^mcp_place 0 0 vy=-2\.5 ;/);
      });

      it("refuses an empty call, fog/force without a position and addVelocity without a velocity, before sending", async () => {
        const h = await live();
        await refused(h, "place_actor", { tid: 7 }, "give at least one of x, y, z, angle, pitch, vx, vy, vz");
        await refused(h, "place_actor", { tid: 7, fog: true, force: false }, "give at least one of x, y, z, angle, pitch, vx, vy, vz");
        await refused(h, "place_actor", { tid: 7, angle: 1, fog: true }, "fog and force need x, y or z");
        await refused(h, "place_actor", { tid: 7, vz: 1, force: true }, "fog and force need x, y or z");
        await refused(h, "place_actor", { tid: 7, x: 1, addVelocity: true }, "addVelocity needs vx, vy or vz");
        await refused(h, "place_actor", { tid: 7, x: 40000 }, /32767/);
        await refused(h, "place_actor", { tid: 7, pitch: 91 }, /90/);
        expect(cmds()).toHaveLength(0);
      });
    });

    describe("remove_actor", () => {
      it("removes one actor by index, or every one with the tid, listing each with hidden and skipped", async () => {
        const h = await live({
          responses: {
            "mcp_remove 7 1": [`removed ${HEAD}`, "removed_total count=1"],
            "mcp_remove 7 0 all=1": [`removed ${HEAD}`, `removed ${HEAD} hidden=1`, "removed_total count=2 skipped=player0,player1"],
            "mcp_remove 8 ": ["removed_total count=0 skipped=player0"],
            "mcp_remove 9 ": ["removed_total count=0 skipped=player0,MCPTagItem#9"],
          },
        });
        const one = await h.call("remove_actor", { tid: 7, index: 1, all: false });
        expect(cmds()[0]).toMatch(/^mcp_remove 7 1 ;/);
        expect(one.content?.[0]?.text).toBe("removed 1: DoomImp#7");
        expect(one.structuredContent).toEqual({ removed: [expect.objectContaining({ class: "DoomImp", tid: 7, hp: 60 })], count: 1 });
        const all = await h.call("remove_actor", { tid: 7, all: true });
        expect(cmds()[1]).toMatch(/^mcp_remove 7 0 all=1 ;/);
        expect(all.content?.[0]?.text).toBe("removed 2: DoomImp#7, DoomImp#7 (hidden); skipped player0, player1 (a live player's body)");
        expect(all.structuredContent).toMatchObject({ count: 2, skipped: ["player0", "player1"] });
        expect((all.structuredContent?.removed as KvRecord[])[1]).toMatchObject({ hidden: 1 });
        expect(await h.text("remove_actor", { tid: 8 })).toBe("removed 0; skipped player0 (a live player's body)");
        expect(await h.text("remove_actor", { tid: 9 })).toBe(
          "removed 0; skipped player0 (a live player's body); MCPTagItem#9 (owned inventory, which the engine keeps)",
        );
      });

      it("refuses all with index and a tid below 1, before sending", async () => {
        const h = await live();
        await refused(h, "remove_actor", { tid: 7, index: 0, all: true }, "all and index can't be combined");
        await refused(h, "remove_actor", { tid: 0 }, /tid/);
        await refused(h, "remove_actor", {}, /tid/);
        expect(cmds()).toHaveLength(0);
      });
    });

    describe("damage_actor", () => {
      it("sends the amount, type and source, and reports hp before and after", async () => {
        const h = await live({
          responses: {
            "mcp_damage 7 0 10": [`damaged ${HEAD.replace("hp=60", "hp=50")} oldhp=60 dealt=10 type=None flags=mso name=Imp`],
            "mcp_damage 7 1 61 ": [`damaged ${HEAD.replace("hp=60", "hp=-1")} oldhp=60 dealt=61 type=Extreme source=player0 died=1 removed=1 flags=c name=Imp`],
            "mcp_damage 0 0 5 ": [`damaged ${BODY} oldhp=100 dealt=0 type=Fire source=DoomImp#7 nodamage=1 flags=so name=Player`],
          },
        });
        const hit = await h.call("damage_actor", { tid: 7, amount: 10 });
        expect(cmds()[0]).toMatch(/^mcp_damage 7 0 10 ;/);
        expect(hit.content?.[0]?.text).toBe("DoomImp#7 took 10 None damage: hp 60 -> 50");
        expect(hit.structuredContent).toMatchObject({ hp: 50, oldhp: 60, dealt: 10, type: "None", flags: "monster,shootable,solid" });
        const kill = await h.call("damage_actor", { tid: 7, index: 1, amount: 61, damageType: "Extreme", sourceTid: 0 });
        expect(cmds()[1]).toMatch(/^mcp_damage 7 1 61 type=Extreme source=0 ;/);
        expect(kill.content?.[0]?.text).toBe("DoomImp#7 took 61 Extreme damage: hp 60 -> -1 (died, removed)");
        expect(kill.structuredContent).toMatchObject({ source: "player0", died: 1, removed: 1, flags: "corpse" });
        const god = await h.call("damage_actor", { amount: 5, damageType: "Fire", sourceTid: 7 });
        expect(cmds()[2]).toMatch(/^mcp_damage 0 0 5 type=Fire source=7 ;/);
        expect(god.content?.[0]?.text).toBe("DoomPlayer#0 took 0 Fire damage: hp 100 -> 100 (nodamage)");
      });

      it("refuses a damage type the console would rewrite or split, and an amount out of range, before sending", async () => {
        const h = await live();
        await refused(h, "damage_actor", { tid: 7, amount: 1, damageType: "$sv_cheats" }, 'bad damageType "$sv_cheats"');
        await refused(h, "damage_actor", { tid: 7, amount: 1, damageType: "Café" }, 'bad damageType "Café"');
        await refused(h, "damage_actor", { tid: 7, amount: 0 }, /amount/);
        await refused(h, "damage_actor", { tid: 7, amount: 1000001 }, /amount/);
        expect(cmds()).toHaveLength(0);
      });
    });

    describe("give and take", () => {
      it("keep the stock command without a tid", async () => {
        const h = await live();
        await h.call("give", { item: "Clip", amount: 50 });
        await h.call("give", { item: "$weird" });
        await h.call("take", { item: "Berserk" });
        expect(cmds()[0]).toMatch(/^give Clip 50 ;/);
        expect(cmds()[1]).toMatch(/^give \$weird ;/);
        expect(cmds()[2]).toMatch(/^take Berserk ;/);
      });

      it("run mcp_inv with a tid and report the held class before and after", async () => {
        const inv = (fields: string, head = BODY, name = "Player") => [`inv ${fields} ${head} flags=so name=${name}`];
        const h = await live({
          responses: {
            "mcp_inv 0 0 give Clip": inv("op=give item=Clip held=Clip before=50 after=51"),
            "mcp_inv 0 0 give Medikit": inv("op=give item=Medikit held=health before=100 after=100 ok=0"),
            "mcp_inv 7 1 take Shell 4": inv("op=take item=Shell held=Shell before=8 after=4", HEAD, "Imp"),
          },
        });
        const gave = await h.call("give", { tid: 0, item: "Clip" });
        expect(cmds()[0]).toMatch(/^mcp_inv 0 0 give Clip ;/);
        expect(gave.content?.[0]?.text).toBe("give Clip on DoomPlayer#0: Clip 50 -> 51");
        expect(gave.structuredContent).toMatchObject({ op: "give", item: "Clip", held: "Clip", before: 50, after: 51, flags: "shootable,solid" });
        const full = await h.call("give", { tid: 0, item: "Medikit", amount: 25 });
        expect(cmds()[1]).toMatch(/^mcp_inv 0 0 give Medikit 25 ;/);
        expect(full.content?.[0]?.text).toBe("give Medikit on DoomPlayer#0: health 100 -> 100 (pickup refused)");
        expect(full.structuredContent).toMatchObject({ held: "health", ok: 0 });
        expect(await h.text("take", { tid: 7, index: 1, item: "Shell", amount: 4 })).toBe("take Shell on DoomImp#7: Shell 8 -> 4");
        expect(cmds()[2]).toMatch(/^mcp_inv 7 1 take Shell 4 ;/);
      });

      it("describe held= per op: the kept-under class for give, the item class itself for take", async () => {
        const h = await live();
        const { tools } = await h.client.listTools();
        const description = (name: string) => tools.find((t) => t.name === name)?.description ?? "";
        expect(description("give")).toContain("held=, the class the amount is kept under (armor: the player's armor class; an ammo pickup: its parent ammo, e.g. ClipBox: Clip;");
        expect(description("take")).toContain("held=, the item class itself, the only class looked up");
        expect(description("take")).not.toMatch(/kept under|ClipBox: Clip/);
      });

      it("closes the actor-write descriptions on the adapter's notes, with no trailing space for an empty one", async () => {
        const notes = { ...engine.notes, placeActor: "", removeActor: "", inventory: "" };
        for (const variant of [engine, { ...engine, notes }]) {
          const h = await live({ engine: variant });
          const { tools } = await h.client.listTools();
          const { actorWrites, placeActor, removeActor, inventory } = variant.notes;
          for (const [name, note] of [["place_actor", placeActor], ["remove_actor", removeActor], ["give", inventory], ["take", inventory]]) {
            const description = tools.find((t) => t.name === name)?.description ?? "";
            expect(description.endsWith(note ? `${actorWrites} ${note}` : actorWrites)).toBe(true);
          }
        }
      });

      it("refuses an item the console would rewrite or split with a tid, or one with a space, before sending", async () => {
        const h = await live();
        await refused(h, "give", { tid: 0, item: "$sv_cheats" }, 'bad item "$sv_cheats"');
        await refused(h, "take", { tid: 7, item: "Café" }, 'bad item "Café"');
        await refused(h, "give", { item: "Clip Box" }, /no spaces/);
        expect(cmds()).toHaveLength(0);
      });
    });

    const ERRORS: [string, string, (tid: number) => Record<string, unknown>, string[]][] = [
      ["place_actor", "mcp_place", (tid) => ({ tid, angle: 1 }), [
        "usage: mcp_place <tid> <index> [x=] [y=] [z=] [angle=] [pitch=] [vx=] [vy=] [vz=] [addvel=1] [fog=1] [force=1]",
        "client: place on the server instance", "not in a level", "server: pass a tid", "no actor with tid 4 index 0",
        "spectator", "coordinates must be within -32767..32767", "velocity must be within -32767..32767",
        "pitch must be within -90..90", "blocked by player0", "blocked by line 12",
        "blocked floor=0.0 ceiling=128.0 z=0.0 height=56.0", "z must be within -32767..32711 for height 56",
      ]],
      ["remove_actor", "mcp_remove", (tid) => ({ tid }), [
        "usage: mcp_remove <tid> <index> [all=1]", "client: remove on the server instance", "not in a level",
        "no actor with tid 4 index 0", "no actor with tid 5", "spectator",
      ]],
      ["damage_actor", "mcp_damage", (tid) => ({ tid, amount: 1 }), [
        "usage: mcp_damage <tid> <index> <amount> [type=Name] [source=<tid>]", "client: damage on the server instance",
        "not in a level", "server: pass a tid", "server: pass a source tid", "no actor with tid 6 index 0", "spectator",
        "no source actor with tid 5", "already dead",
      ]],
      ["give", "mcp_inv", (tid) => ({ tid, item: "Clip" }), [
        "usage: mcp_inv <tid> <index> <give|take> <class> [amount]", "client: give on the server instance", "not in a level",
        "server: pass a tid", "not an inventory class Clip", "no actor with tid 6 index 0", "spectator",
        "not replicated: give on a non-player",
      ]],
      ["take", "mcp_inv", (tid) => ({ tid, item: "Clip" }), ["client: take on the server instance", "not replicated: take on a non-player"]],
    ];

    it.each(ERRORS)("%s surfaces each engine error shape, or raw output without its reply line", async (tool, verb, args, errors) => {
      const responses: Record<string, string[]> = { [`${verb} 98 `]: ["Unknown command"] };
      errors.forEach((e, i) => (responses[`${verb} ${i + 1} `] = [`error ${e}`]));
      const h = await live({ responses });
      for (const [i, e] of errors.entries()) await refused(h, tool, args(i + 1), e);
      await refused(h, tool, args(98), "Unknown command");
      await refused(h, tool, args(99), "(no output)");
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
      const h = await live({ responses: { findactors: ["MCP_FOUND", "found class=A tid=0", "truncated shown=1 total=4"] } });
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

    it("fetches every row for a flag filter (limit=0) and applies the limit after filtering", async () => {
      const h = await live({
        responses: {
          findactors: [
            "MCP_FOUND",
            "found class=Column tid=1 hp=1000 dist=5.0 flags=o",
            "found class=DoomImp tid=2 hp=60 dist=10.0 flags=mso",
            "found class=DoomImp tid=3 hp=0 dist=20.0 flags=mc",
            "found class=Demon tid=4 hp=150 dist=30.0 flags=mso",
            "found class=Zombieman tid=5 hp=20 dist=40.0 flags=mso",
          ],
        },
      });
      const res = await h.call("find_actors", { class: "Actor", limit: 2, flags: { monster: true, alive: true } });
      expect(cmds().at(-1)).toMatch(/^findactors class=Actor limit=0 ;/);
      expect(res.content?.[0]?.text).toBe("2 actor(s) found (showing 2 of 3)");
      expect(res.structuredContent?.truncated).toEqual({ shown: 2, total: 3 });
      expect((res.structuredContent?.actors as Array<{ tid: number }>).map((a) => a.tid)).toEqual([2, 4]);

      const corpses = await h.call("find_actors", { flags: { corpse: true } });
      expect(cmds().at(-1)).toMatch(/^findactors limit=0 ;/);
      expect(corpses.content?.[0]?.text).toBe("1 actor(s) found");
      expect(corpses.structuredContent?.truncated).toBeUndefined();
    });

    it("cuts a flag filter to the engine's default limit when none is given", async () => {
      const rows = Array.from({ length: 201 }, (_, i) => `found class=DoomImp tid=${i + 1} hp=60 flags=m`);
      const h = await live({ responses: { findactors: ["MCP_FOUND", ...rows] } });
      const res = await h.call("find_actors", { flags: { monster: true } });
      expect(res.content?.[0]?.text).toBe("200 actor(s) found (showing 200 of 201)");
    });

    it("leaves the limit to the engine for an empty flags object", async () => {
      const h = await live({ responses: { findactors: ["MCP_FOUND", "found class=A tid=0", "truncated shown=1 total=4"] } });
      const res = await h.call("find_actors", { limit: 1, flags: {} });
      expect(cmds().at(-1)).toMatch(/^findactors limit=1 ;/);
      expect(res.content?.[0]?.text).toBe("1 actor(s) found (showing 1 of 4)");
    });

    it("rejects an unknown flag key without running the command", async () => {
      const h = await live();
      const res = await h.call("find_actors", { flags: { boss: true } });
      expect(res.isError).toBe(true);
      expect(cmds().some((c) => c.startsWith("findactors"))).toBe(false);
    });
  });

  describe("point_info", () => {
    const POINT = [
      "MCP_POINT",
      "point sector=12 inmap=1 floorz=0.0 ceilingz=128.0 light=160 special=0 tag=3",
      "floortex name=FLOOR4_8",
      "ceiltex name=CEIL3_5",
    ];

    it("reports the sector, textures and no fit without a size", async () => {
      const h = await live({ responses: { mcp_pointinfo: POINT } });
      const res = await h.call("point_info", { x: -800, y: 700.5 });
      expect(cmds()[0]).toMatch(/^mcp_pointinfo -800 700.5 ;/);
      expect(res.content?.[0]?.text).toBe("sector 12 floor 0 ceiling 128 FLOOR4_8/CEIL3_5");
      expect(res.structuredContent).toMatchObject({ sector: 12, inmap: 1, tag: 3, floorTexture: "FLOOR4_8", ceilingTexture: "CEIL3_5" });
      expect(res.structuredContent?.fit).toBeUndefined();
    });

    it("passes z, size and a mover reference, and reports a fit", async () => {
      const h = await live({ responses: { mcp_pointinfo: [...POINT, "fit ok=1"] } });
      const res = await h.call("point_info", { x: 1, y: 2, z: 8, radius: 16, height: 56, mover: { tid: 7, index: 1 } });
      expect(cmds()[0]).toMatch(/^mcp_pointinfo 1 2 z=8 radius=16 height=56 mover=tid:7:1 ;/);
      expect(res.content?.[0]?.text).toMatch(/, fits$/);
      expect(res.structuredContent?.fit).toEqual({ ok: true });
    });

    it("reports a blocked fit and a point outside the map as results", async () => {
      const outside = [POINT[0], POINT[1].replace("inmap=1", "inmap=0"), ...POINT.slice(2)];
      const h = await live({ responses: { mcp_pointinfo: [...outside, "fit ok=0 reason=actor blocker=DoomImp#7"] } });
      const res = await h.call("point_info", { x: 1, y: 2, mover: { class: "DoomImp" } });
      expect(res.isError).toBeFalsy();
      expect(cmds()[0]).toMatch(/ mover=class:DoomImp ;/);
      expect(res.content?.[0]?.text).toBe("sector 12 (outside the map) floor 0 ceiling 128 FLOOR4_8/CEIL3_5, doesn't fit: actor DoomImp#7");
      expect(res.structuredContent?.fit).toEqual({ ok: false, reason: "actor", blocker: "DoomImp#7" });
    });

    it("surfaces an engine error or a missing header", async () => {
      const h = await live({
        responses: {
          "mcp_pointinfo 1 ": ["MCP_POINT", "error client: probe on the server instance"],
          "mcp_pointinfo 2 ": ['Unknown command "mcp_pointinfo"'],
          "mcp_pointinfo 3 ": ["MCP_POINT"],
        },
      });
      const res = await h.call("point_info", { x: 1, y: 2, radius: 16, height: 56 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("client: probe on the server instance");
      const unknown = await h.call("point_info", { x: 2, y: 2 });
      expect(unknown.content?.[0]?.text).toBe('Unknown command "mcp_pointinfo"');
      const bare = await h.call("point_info", { x: 3, y: 2 });
      expect(bare.isError).toBe(true);
      expect(bare.content?.[0]?.text).toBe("MCP_POINT");
    });

    it("refuses a point as the mover, or a reference with no form, before sending", async () => {
      const h = await live();
      expect((await h.call("point_info", { x: 1, y: 2, mover: { x: 1, y: 2 } })).isError).toBe(true);
      expect((await h.call("point_info", { x: 1, y: 2, mover: {} })).isError).toBe(true);
      expect(cmds().some((c) => c.startsWith("mcp_pointinfo"))).toBe(false);
    });
  });

  it("refuses a map coordinate a fixed_t can't hold before sending any probe", async () => {
    const h = await live();
    const far = 1e9;
    const calls: Array<[string, Record<string, unknown>]> = [
      ["point_info", { x: far, y: 0 }],
      ["point_info", { x: 0, y: -32768 }],
      ["point_info", { x: 0, y: 0, z: far }],
      ["check_sight", { from: { x: far, y: 0 }, to: { tid: 1 } }],
      ["check_sight", { from: { tid: 1 }, to: { x: 0, y: 0, z: far } }],
      ["trace_move", { to: { x: far, y: 0 } }],
      ["trace_move", { to: { x: 0, y: 0 }, from: { x: 0, y: far } }],
      // A huge probe size would walk the whole blockmap on every step.
      ["point_info", { x: 0, y: 0, radius: far, height: 56 }],
      ["trace_move", { to: { x: 0, y: 0 }, height: far }],
    ];
    for (const [tool, args] of calls) expect((await h.call(tool, args)).isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
    expect(cmds().some((c) => c.startsWith("mcp_"))).toBe(false);
    bridge!.respondTo("mcp_pointinfo", ["MCP_POINT", "point sector=1 floorz=0.0 ceilingz=8.0 light=1 special=0 tag=0", "floortex name=A", "ceiltex name=B"]);
    expect((await h.call("point_info", { x: 32767, y: -32767 })).isError).toBeFalsy();
  });

  describe("check_sight", () => {
    it("passes both references and reports visible", async () => {
      const h = await live({ responses: { mcp_checksight: ["MCP_SIGHT", "sight visible=1 from=player0 to=DoomImp#7"] } });
      const res = await h.call("check_sight", { from: { player: 0 }, to: { class: "DoomImp" } });
      expect(cmds()[0]).toMatch(/^mcp_checksight from=player:0 to=class:DoomImp ;/);
      expect(res.content?.[0]?.text).toBe("visible: player0 -> DoomImp#7");
      expect(res.structuredContent).toEqual({ visible: true, from: "player0", to: "DoomImp#7" });
    });

    it("reports not visible with the line hint as a result, and passes the flags", async () => {
      const h = await live({ responses: { mcp_checksight: ["MCP_SIGHT", "sight visible=0 from=pt:1,2,41 to=DoomImp#7 line=88"] } });
      const res = await h.call("check_sight", { from: { x: 1, y: 2, z: 41 }, to: { tid: 7 }, water: true, pastBlocking: true });
      expect(cmds()[0]).toMatch(/^mcp_checksight from=pt:1,2,41 to=tid:7 flags=14 ;/);
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("not visible: pt:1,2,41 -> DoomImp#7 (line 88)");
      await h.call("check_sight", { from: { tid: 1 }, to: { tid: 2 }, water: true });
      expect(cmds()[1]).toMatch(/flags=8 ;/);
      // As ACS CheckSight's bit 2: past block-everything lines, shootable ones included.
      await h.call("check_sight", { from: { tid: 1 }, to: { tid: 2 }, pastBlocking: true });
      expect(cmds()[2]).toMatch(/flags=6 ;/);
    });

    it("surfaces an engine error", async () => {
      const h = await live({ responses: { mcp_checksight: ["MCP_SIGHT", "error no actor with tid 9 index 0"] } });
      const res = await h.call("check_sight", { from: { player: 0 }, to: { tid: 9 } });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("no actor with tid 9 index 0");
    });

    it("needs exactly one reference form, x with y, and index only with tid", async () => {
      const h = await live();
      const bad = [{ tid: 1, player: 0 }, { x: 1 }, { index: 1, player: 0 }, { class: "Doom Imp" }, { tid: 1, extra: 1 }];
      for (const to of bad) expect((await h.call("check_sight", { from: { player: 0 }, to })).isError).toBe(true);
      expect(cmds().some((c) => c.startsWith("mcp_checksight"))).toBe(false);
    });
  });

  describe("trace_move", () => {
    it("passes the target alone and reports a clear path", async () => {
      const h = await live({ responses: { mcp_tracemove: ["MCP_TRACE", "trace ok=1 x=256.0 y=0.0 z=0.0 dist=256.0 total=256.0"] } });
      const res = await h.call("trace_move", { to: { x: 256, y: 0 } });
      expect(cmds()[0]).toMatch(/^mcp_tracemove 256 0 ;/);
      expect(res.content?.[0]?.text).toBe("clear: reaches (256, 0) after 256");
      expect(res.structuredContent).toMatchObject({ ok: true, dist: 256, total: 256 });
    });

    it("passes from, mover, size and actors=0, and reports a block as a result", async () => {
      const h = await live({
        responses: { mcp_tracemove: ["MCP_TRACE", "trace ok=0 reason=line x=10.0 y=0.0 z=0.0 dist=212.0 total=512.0 line=45"] },
      });
      const res = await h.call("trace_move", {
        to: { x: 512, y: 0 }, from: { x: -1.5, y: 2 }, mover: { tid: 3 }, radius: 20, height: 56, actors: false,
      });
      expect(cmds()[0]).toMatch(/^mcp_tracemove 512 0 from=-1.5,2 mover=tid:3 radius=20 height=56 actors=0 ;/);
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("blocked by line 45 after 212 of 512 at (10, 0)");
      expect(res.structuredContent).toMatchObject({ ok: false, reason: "line", line: 45 });
      await h.call("trace_move", { to: { x: 1, y: 1 }, actors: true });
      expect(cmds()[1]).toMatch(/^mcp_tracemove 1 1 ;/);
    });

    it("names the blocker, rise or drop in the text", async () => {
      const h = await live();
      let n = 0;
      // The fake answers with the first matching handler, so each reply gets its own target.
      const text = async (rest: string) => {
        n++;
        bridge!.respondTo(`mcp_tracemove 64 ${n}`, ["MCP_TRACE", `trace ok=0 x=1.0 y=2.0 z=0.0 dist=8.0 total=64.0 ${rest}`]);
        return h.text("trace_move", { to: { x: 64, y: n } });
      };
      expect(await text("reason=actor blocker=Zombieman#3")).toBe("blocked by actor Zombieman#3 after 8 of 64 at (1, 2)");
      expect(await text("reason=step rise=32.0")).toBe("blocked by step (rise 32) after 8 of 64 at (1, 2)");
      expect(await text("reason=dropoff drop=48.0")).toBe("blocked by dropoff (drop 48) after 8 of 64 at (1, 2)");
      expect(await text("reason=ceiling")).toBe("blocked by ceiling after 8 of 64 at (1, 2)");
    });

    it("surfaces an engine error", async () => {
      const h = await live({ responses: { mcp_tracemove: ["MCP_TRACE", "error no mover: pass radius/height or mover="] } });
      const res = await h.call("trace_move", { to: { x: 1, y: 1 } });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("no mover: pass radius/height or mover=");
    });
  });

  /** Advance the fake's maptime by one on every command, status probes included. */
  const ticking = () => {
    let t = 0;
    bridge!.onCommand("", () => bridge!.setStatus({ maptime: String(++t) }));
  };

  /** An io.sleep running the fake's map clock, where n tics move maptime `advance(n)`, by default
   *  Zandronum's max(1, n-1). */
  const mapClock = (advance = (n: number) => Math.max(1, n - 1)) => {
    let t = 0;
    const runs: number[] = [];
    const sleep = (ms: number) => {
      const n = Math.round((ms * 35) / 1000);
      runs.push(n);
      bridge!.setStatus({ maptime: String((t += advance(n))) });
      return Promise.resolve();
    };
    return { io: { sleep }, runs, maptime: () => t };
  };

  /** An engine log that gains `x` then `line` on every io.sleep (a sim run), so only what a step printed is new. */
  const printingLog = (line: string) => {
    let log = "imp died before the call\n";
    return {
      config: { exe: "/engine/zandronum" },
      io: { existsSync: () => true, readTextSync: () => log, sleep: () => ((log += `x\n${line}\n`), Promise.resolve()) },
    };
  };

  describe("ensure_live", () => {
    it("reports live, leaves the pause state as found, and fixes nothing without fix", async () => {
      const h = await withStatus();
      bridge!.setStatus({ paused: "1" });
      ticking();
      bridge!.clearReceived();
      const res = await h.call("ensure_live");
      expect(res.content?.[0]?.text).toBe("live (maptime 1 -> 2)");
      expect(res.structuredContent).toEqual({
        live: true,
        maptime: { before: 1, after: 2 },
        found: [],
        remaining: [],
        engineState: "Engine state: paused.",
      });
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
      expect(res.structuredContent).not.toHaveProperty("notes");
      expect(bridge!.pauses.slice(-1)).toEqual([0]);
      expect(cmds().filter((c) => /closemenu|mcp_unblock/.test(c))).toHaveLength(2);
    });

    it("with fix, also clears the focus-loss pause where the overlay reports one", async () => {
      const h = await withStatus();
      bridge!.setStatus({ menu: "on", pauseext: "1" });
      bridge!.onCommand("closemenu", () => bridge!.setStatus({ menu: "off" }));
      bridge!.onCommand("mcp_unblock", () => bridge!.setStatus({ pauseext: "0" }));
      ticking();
      const res = await h.call("ensure_live", { fix: true });
      expect(res.content?.[0]?.text).toBe("live (maptime 3 -> 4); fixed: paused by focus loss (pauseext), a menu is open");
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

    it("asks for a retry when the status reads during the load wait all come back empty", async () => {
      const h = await withStatus();
      bridge!.setStatus({ pending: "1" });
      let n = 0;
      bridge!.onCommand("", () => {
        if (++n > 1) bridge!.blankStatus();
      });
      const res = await h.call("ensure_live");
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "can't check liveness: status read timed out (engine busy, e.g. loading a map); retry",
      );
    });

    it("doesn't wait out a load the focus-loss pause stalls, without fix", async () => {
      const h = await withStatus();
      bridge!.setStatus({ pending: "1", pauseext: "1" });
      bridge!.clearReceived();
      const res = await h.call("ensure_live");
      expect(res.content?.[0]?.text).toBe(
        "NOT live (maptime 0 -> 0); blockers: paused by focus loss (pauseext), a map/save/demo load is pending",
      );
      expect(cmds().filter((c) => /^mcp_status /.test(c))).toHaveLength(2);
    });

    it("with fix, clears pauseext first and then waits out the load it released", async () => {
      const h = await withStatus();
      bridge!.setStatus({ pending: "1", pauseext: "1", maptime: "40" });
      bridge!.onCommand("mcp_unblock", () => {
        bridge!.setStatus({ pauseext: "0", pending: "0", maptime: "6" });
        bridge!.queueStatus({ pending: "1", maptime: "40" }, { maptime: "1" });
      });
      const res = await h.call("ensure_live", { fix: true });
      expect(res.content?.[0]?.text).toBe(
        "live (maptime 1 -> 6); waited for a pending map/save/demo load first; " +
          "fixed: paused by focus loss (pauseext), a map/save/demo load is pending",
      );
      expect(res.structuredContent).toMatchObject({
        found: ["paused by focus loss (pauseext)", "a map/save/demo load is pending"],
        remaining: [],
        notes: ["waited for a pending map/save/demo load first"],
      });
    });

    it("with fix, waits out an unstalled load before fixing, and reads found and pause state after it", async () => {
      const h = await withStatus();
      // One snapshot per status-bearing message: read, load probe, closemenu, mcp_unblock, final read.
      const steps = [
        { pending: "1", paused: "1", maptime: "40" },
        { pending: "0", paused: "0", maptime: "1" },
        {},
        {},
        { maptime: "6" },
      ];
      let n = 0;
      bridge!.onCommand("", () => bridge!.setStatus(steps[n++] ?? {}));
      const p0 = bridge!.pauses.length;
      const res = await h.call("ensure_live", { fix: true });
      expect(res.content?.[0]?.text).toBe("live (maptime 1 -> 6); waited for a pending map/save/demo load first");
      expect(res.structuredContent).toMatchObject({ found: [], fixed: [], remaining: [] });
      expect(bridge!.pauses.slice(p0)).toEqual([0]);
    });

    it("with fix, asks for a retry when the load wait after unblocking reads nothing", async () => {
      const h = await withStatus();
      bridge!.setStatus({ pending: "1", pauseext: "1" });
      // Messages: read, closemenu, mcp_unblock, then the load probes.
      let n = 0;
      bridge!.onCommand("", () => {
        n++;
        if (n === 3) bridge!.setStatus({ pauseext: "0" });
        if (n >= 4) bridge!.blankStatus();
      });
      const res = await h.call("ensure_live", { fix: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "can't check liveness: status read timed out (engine busy, e.g. loading a map); retry",
      );
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
      expect(res.structuredContent).toEqual({ met: true, tics: 2, value: 30, right: 30 });
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
      expect(res.content?.[0]?.text).toBe("not met within 12 tic(s): 1 != 1");
      expect(res.structuredContent).toMatchObject({ met: false, tics: 12 });
      // ticking() moves one tic per read, so each chunk counts 1: the first read plus 12.
      expect(cmds().filter((c) => c.startsWith("getmaparray"))).toHaveLength(13);
    });

    it("runs only the tics left in the last chunk", async () => {
      const clock = mapClock((n) => n);
      const h = await withStatus({ responses: { getmapvar: ["mapvar hp = 0"] }, io: clock.io });
      clock.runs.length = 0;
      await h.call("step_until", { condition: mapvar("==", 1), maxTics: 12, chunkTics: 5 });
      expect(clock.runs).toEqual([5, 5, 2]);
    });

    it("says when the iteration cap ended a stuttering run short of maxTics", async () => {
      let runs = 0;
      // One tic every third run: the idle runs between never add up to a stall.
      const clock = mapClock(() => (++runs % 3 === 0 ? 1 : 0));
      const h = await withStatus({ responses: { getmapvar: ["mapvar hp = 0"] }, io: clock.io });
      const res = await h.call("step_until", { condition: mapvar("==", 1), maxTics: 20, chunkTics: 1 });
      expect(res.content?.[0]?.text).toMatch(/^not met within \d+ tic\(s\): 0 == 1\nstopped after \d+ of 20 tic\(s\): the iteration cap/);
      expect(res.structuredContent?.notes).toEqual([expect.stringMatching(/iteration cap/)]);
    });

    it("counts measured map tics against maxTics, topping up Zandronum's short steps", async () => {
      const clock = mapClock();
      const h = await withStatus({ responses: { getmapvar: ["mapvar hp = 0"] }, io: clock.io });
      clock.runs.length = 0;
      const t0 = clock.maptime();
      const res = await h.call("step_until", { condition: mapvar("==", 1), maxTics: 35, chunkTics: 2 });
      expect(res.content?.[0]?.text).toBe("not met within 35 tic(s): 0 == 1");
      expect(res.structuredContent).toEqual({ met: false, tics: 35, value: 0, right: 1 });
      expect(clock.maptime() - t0).toBe(35);
      expect(clock.runs).toEqual([...Array(34).fill(2), 1]);
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
      expect(floor.structuredContent).toEqual({ met: true, tics: 0, value: 32, right: 0 });
      const hp = await h.call("step_until", {
        condition: { kind: "player", field: "health", op: "<", value: 50 },
        maxTics: 5,
      });
      // ticking() moves one tic per read, so maxTics 5 takes five chunks.
      expect(hp.content?.[0]?.text).toBe("not met within 5 tic(s): 100 < 50");
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

    it("fails naming both maptimes when the map changes mid-run", async () => {
      const h = await withStatus({ responses: { getmapvar: ["mapvar hp = 0"] } });
      const times = [100, 102, 3];
      let reads = 0;
      bridge!.onCommand("getmapvar", () => bridge!.setStatus({ maptime: String(times[reads++]) }));
      const res = await h.call("step_until", { condition: mapvar("==", 1), maxTics: 50 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "the map changed (maptime went from 102 to 3) after 2 tic(s); the condition was not met",
      );
    });

    it("fails an unreadable acsvar condition with the engine's own text", async () => {
      const h = await withStatus({ responses: { getacsvar: ["index out of range (0-63)"] } });
      const res = await h.call("step_until", { condition: { kind: "acsvar", scope: "world", index: 99, op: "==", value: 1 }, maxTics: 5 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("index out of range (0-63)");
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
      expect(await errText({ kind: "acsvar", scope: "world", index: 2, op: "==", value: 1 })).toBe("no value");
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

    it("counts the actors a find_actors filter matches, taking the engine's total past limit=1", async () => {
      const h = await withStatus();
      const replies = [
        ["MCP_FOUND", "found class=DoomImp tid=0", "truncated shown=1 total=3"],
        ["MCP_FOUND", "found class=DoomImp tid=0"],
        ["MCP_FOUND"],
      ];
      const out = [...replies[0]];
      let n = 0;
      bridge!.respondTo("findactors", out);
      bridge!.onCommand("findactors", () => out.splice(0, out.length, ...replies[Math.min(n++, 2)]));
      ticking();
      const res = await h.call("step_until", {
        condition: { kind: "actors", class: "DoomImp", tid: 4, radius: 512, op: "==", value: 0 },
        maxTics: 50,
      });
      expect(res.content?.[0]?.text).toBe("met after 2 tic(s): 0 == 0");
      expect(res.structuredContent).toEqual({ met: true, tics: 2, value: 0, right: 0 });
      const finds = cmds().filter((c) => c.startsWith("findactors"));
      expect(finds).toHaveLength(3);
      expect(finds[0]).toMatch(/^findactors class=DoomImp tid=4 radius=512 limit=1 ;/);
      n = 0;
      const three = await h.call("step_until", { condition: { kind: "actors", op: "==", value: 3 }, maxTics: 5 });
      expect(three.content?.[0]?.text).toBe("met after 0 tic(s): 3 == 3");
      expect(cmds().at(-1)).toMatch(/^findactors limit=1 ;/);
    });

    it("counts only what find_actors' flags keep, from every row, so a corpse can be ruled out", async () => {
      const h = await withStatus();
      const corpse = "found class=DoomImp tid=0 hp=0 flags=mc";
      const replies = [
        ["MCP_FOUND", "found class=DoomImp tid=0 hp=60 flags=mso", corpse],
        ["MCP_FOUND", corpse, corpse],
      ];
      const out = [...replies[0]];
      let n = 0;
      bridge!.respondTo("findactors", out);
      bridge!.onCommand("findactors", () => out.splice(0, out.length, ...replies[Math.min(n++, 1)]));
      ticking();
      const alive = await h.call("step_until", {
        condition: { kind: "actors", class: "DoomImp", flags: { alive: true }, op: "==", value: 0 },
        maxTics: 20,
      });
      expect(alive.content?.[0]?.text).toBe("met after 1 tic(s): 0 == 0");
      expect(cmds().find((c) => c.startsWith("findactors"))).toMatch(/^findactors class=DoomImp limit=0 ;/);
      const corpses = await h.call("step_until", { condition: { kind: "actors", flags: { corpse: true }, op: "==", value: 2 }, maxTics: 5 });
      expect(corpses.content?.[0]?.text).toBe("met after 0 tic(s): 2 == 2");
    });

    it("reports what findactors said when an actors condition can't be read", async () => {
      const h = await withStatus({ responses: { findactors: ["MCP_FOUND", "error unknown class Nope"] } });
      const res = await h.call("step_until", { condition: { kind: "actors", class: "Nope", op: ">", value: 0 }, maxTics: 5 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("unknown class Nope");
    });

    it("holds a log condition once a matching line is printed after the call starts", async () => {
      const h = await withStatus(printingLog("Imp died"));
      ticking();
      const res = await h.call("step_until", { condition: { kind: "log", pattern: "imp died" }, maxTics: 20 });
      expect(res.content?.[0]?.text).toBe("met after 1 tic(s): 1 line(s) matching /imp died/");
      expect(res.structuredContent).toEqual({ met: true, tics: 1, value: 1, right: 1 });
      const none = await h.call("step_until", { condition: { kind: "log", pattern: "^never" }, maxTics: 3, chunkTics: 1 });
      expect(none.content?.[0]?.text).toBe("not met within 3 tic(s): 0 line(s) matching /^never/");
    });

    it("needs an engine log for a log condition, and a valid pattern before anything runs", async () => {
      const h = await withStatus();
      const res = await h.call("step_until", { condition: { kind: "log", pattern: "x" }, maxTics: 5 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("no engine log to match /x/ in (launch_instance writes one)");
      bridge!.clearReceived();
      const bad = await h.call("step_until", { condition: { kind: "log", pattern: "(" }, maxTics: 5 });
      expect(bad.isError).toBe(true);
      expect(bad.content?.[0]?.text).toMatch(/not a valid regex/);
      expect(cmds()).toEqual([]);
    });

    it("asks for a retry when a log condition's status refresh comes back empty mid-run", async () => {
      const h = await withStatus(printingLog("tick"));
      ticking();
      let probes = 0;
      // A bare probe's command is empty, so "" is what matches it; after ticking's hook, so the blank wins.
      bridge!.onCommand("", () => ++probes >= 3 && bridge!.blankStatus());
      const res = await h.call("step_until", { condition: { kind: "log", pattern: "^never" }, maxTics: 10, chunkTics: 1 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("can't count tics: status read timed out (engine busy, e.g. loading a map); retry");
    });
  });

  describe("run_scenario", () => {
    const extraBridges: FakeBridge[] = [];
    afterEach(async () => {
      // Before the file-level afterEach: drop the harness's sockets first, or close() waits on them.
      await harness?.close();
      harness = undefined;
      for (const b of extraBridges.splice(0)) await b.close();
    });
    type Reply = Awaited<ReturnType<Harness["call"]>>;
    const stepsOf = (res: Reply) => (res.structuredContent?.steps ?? []) as Array<Record<string, unknown>>;
    const sentinel = (t: string) => t.replace(/__MCPDONE_\w+__/, "S");

    it("runs a mixed burst on the scenario's own instance in one call, each result in the structured half", async () => {
      const h = await withStatus();
      const second = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", caps: ["cmd", "event", "time", "status"] } });
      extraBridges.push(second);
      second.respondTo("god", ["degreelessness mode ON"]).respondTo("findactors", ["MCP_FOUND", "found class=DoomImp tid=7 flags=m"]);
      await h.call("attach_instance", { instance: 2, port: second.port });
      bridge!.clearReceived();
      const res = await h.call("run_scenario", {
        instance: 2,
        steps: [
          { call: "run_command", args: { text: "god" } },
          { call: "step", args: { tics: 5 } },
          { call: "find_actors", args: { class: "DoomImp" } },
          { expect: { kind: "actors", class: "DoomImp", op: "==", value: 1 } },
        ],
      });
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toEqual({
        ok: true,
        calls: 3,
        maptimeStart: 0,
        maptimeEnd: 0,
        steps: [
          { index: 0, call: "run_command", ok: true, text: "degreelessness mode ON" },
          { index: 1, call: "step", ok: true, text: "advanced ~5 tic(s)" },
          { index: 2, call: "find_actors", ok: true, text: "1 actor(s) found", structured: { actors: [{ class: "DoomImp", tid: 7, flags: "monster" }] } },
          { index: 3, expect: "actors", ok: true, text: "met: 1 == 1" },
        ],
      });
      expect(res.content).toEqual([
        {
          type: "text",
          text: [
            "scenario ok: 4 step(s) ran, 3 call(s), maptime 0 -> 0",
            "0 run_command: ok - degreelessness mode ON",
            "1 step: ok - advanced ~5 tic(s)",
            "2 find_actors: ok - 1 actor(s) found",
            "3 expect actors: ok - met: 1 == 1",
          ].join("\n"),
        },
      ]);
      const sent = second.received.filter((m) => m.t === "cmd").map((m) => sentinel(m.text ?? ""));
      expect(sent.filter((c) => !c.startsWith("mcp_status"))).toEqual([
        "god ; mcp_status S",
        "findactors class=DoomImp ; mcp_status S",
        "findactors class=DoomImp limit=1 ; mcp_status S",
      ]);
      expect(second.pauses).toEqual([0, 1]);
      expect(cmds()).toEqual([]);
    });

    it("refuses a bad call step anywhere before step 0 runs, so the engine sees nothing", async () => {
      const h = await live();
      bridge!.clearReceived();
      const res = await h.call("run_scenario", {
        steps: [
          { call: "run_command", args: { text: "god" } },
          { call: "step", args: { tics: 5 } },
          { call: "kill_instance" },
          { call: "screenshot" },
          { repeat: [{ call: "step", args: { tics: -1 } }], maxIterations: 2 },
          { call: "step", args: { instance: 1 } },
          { call: "map_info", args: { map: "MAP01" } },
          { call: "summon", args: { classname: "DoomImp" } },
        ],
      });
      expect(cmds()).toEqual([]);
      expect(bridge!.pauses).toEqual([]);
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        [
          "refused, nothing ran:",
          "step 2 (kill_instance): not callable in a scenario (process lifecycle)",
          "step 3 (screenshot): not callable in a scenario (replies with an inline image; use screenshot_file)",
          "step 4.0 (step): tics: Number must be greater than 0",
          "step 5 (step): instance is the scenario's; drop it from args",
          "step 6 (map_info): takes no instance; call it on its own",
          "step 7 (summon): className: Required; args: Unrecognized key(s) in object: 'classname'",
        ].join("\n"),
      );
      expect(h.ctx.attachedClient(1)).toBeDefined();
    });

    it("can name every listed tool: each is callable, or refused for a stated reason, never unknown", async () => {
      const h = await live();
      const names = (await h.client.listTools()).tools.map((t) => t.name);
      const lines: string[] = [];
      for (let i = 0; i < names.length; i += 60) {
        // A bad last step keeps each batch from running.
        const steps = [...names.slice(i, i + 60).map((call) => ({ call })), { call: "step", args: { tics: 0 } }];
        const res = await h.call("run_scenario", { steps });
        lines.push(...(res.content?.[0]?.text ?? "").split("\n").slice(1));
      }
      expect(lines.filter((l) => l.endsWith("no such tool"))).toEqual([]);
      const refusedAs = (why: string) => lines.filter((l) => l.endsWith(why)).map((l) => /\(([a-z_]+)\)/.exec(l)![1]);
      expect(refusedAs("(process lifecycle)").sort()).toEqual(["attach_instance", "kill_instance", "launch_instance", "relaunch_instance", "reset"]);
      expect(refusedAs("use screenshot_file)").sort()).toEqual(["screenshot", "verify_menu"]);
      expect(refusedAs("(scenarios don't nest)")).toEqual(["run_scenario"]);
      expect(refusedAs("takes no instance; call it on its own")).toContain("map_info");
      expect(cmds()).toEqual([]);
    });

    it("repeats until no imp is alive, expects a log line, and reads the log on from each read", async () => {
      const h = await withStatus(printingLog("Imp died"));
      const replies = [["MCP_FOUND", "found class=DoomImp tid=0 hp=60 flags=mso"], ["MCP_FOUND", "found class=DoomImp tid=0 hp=0 flags=mc"]];
      const out = [...replies[0]];
      let n = 0;
      bridge!.respondTo("findactors", out);
      bridge!.onCommand("findactors", () => out.splice(0, out.length, ...replies[Math.min(n++, 1)]));
      const res = await h.call("run_scenario", {
        steps: [
          {
            repeat: [{ call: "step", args: { tics: 5 } }],
            until: { kind: "actors", class: "DoomImp", flags: { alive: true }, op: "==", value: 0 },
            maxIterations: 10,
          },
          { expect: { kind: "log", pattern: "imp died" } },
          { call: "read_log", args: { pattern: "imp" } },
          { call: "step", args: { tics: 1 } },
          { call: "read_log", args: { pattern: "imp" } },
          { call: "read_log" },
        ],
      });
      expect(res.isError).toBeUndefined();
      const steps = stepsOf(res);
      expect(steps[0]).toMatchObject({ index: 0, iterations: 2, ok: true, text: "until met: 0 == 0, after 2 iteration(s)" });
      expect(steps[0].repeat).toMatchObject([{ index: 0, call: "step", ok: true, structured: { log: ["x", "Imp died"] } }]);
      expect(steps[1]).toEqual({ index: 1, expect: "log", ok: true, text: "met: 2 line(s) matching /imp died/" });
      const linesOf = (i: number) => (steps[i].structured as { lines: unknown[] }).lines;
      expect(linesOf(2)).toEqual([{ line: 3, text: "Imp died" }, { line: 5, text: "Imp died" }]);
      expect(linesOf(4)).toEqual([{ line: 7, text: "Imp died" }]);
      expect(linesOf(5)).toEqual([]);
    });

    it("makes a wait_for_log step wait from where the scenario began, so a line printed before it doesn't match", async () => {
      const h = await live(printingLog("boom"));
      const res = await h.call("run_scenario", {
        steps: [
          { call: "wait_for_log", args: { pattern: "before the call", timeoutSec: 0.3 } },
          { call: "wait_for_log", args: { pattern: "boom", timeoutSec: 1 } },
          { call: "wait_for_log", args: { pattern: "before the call", sinceLine: 0, timeoutSec: 0.3 } },
        ],
      });
      expect(stepsOf(res).map((st) => (st.structured as { reason: string }).reason)).toEqual(["timeout", "matched", "matched"]);
    });

    it("applies each tool's own defaults", async () => {
      const clock = mapClock((t) => t);
      const h = await withStatus({ io: clock.io });
      clock.runs.length = 0;
      await h.call("run_scenario", { steps: [{ call: "step" }] });
      expect(clock.runs).toEqual([35]);
    });

    it("stops at a failed step under onFail stop, an error reply; continue runs the rest", async () => {
      const h = await live({ responses: { findactors: ["MCP_FOUND", "error unknown class Nope"], god: ["god on"] } });
      const steps = [{ call: "find_actors", args: { class: "Nope" } }, { call: "run_command", args: { text: "god" } }];
      const stopped = await h.call("run_scenario", { steps });
      expect(stopped.isError).toBe(true);
      expect(stopped.structuredContent).toMatchObject({ ok: false, failedAt: 0, calls: 1 });
      expect(stopped.structuredContent).not.toHaveProperty("maptimeStart");
      expect(stepsOf(stopped)).toEqual([{ index: 0, call: "find_actors", ok: false, text: "unknown class Nope" }]);
      expect(stopped.structuredContent?.error).toMatch(/^scenario failed at step 0: 1 step\(s\) ran, 1 call\(s\)\n0 find_actors: FAILED - unknown class Nope$/);
      expect(cmds().some((c) => c.startsWith("god"))).toBe(false);
      const went = await h.call("run_scenario", { steps, onFail: "continue" });
      expect(went.isError).toBeUndefined();
      expect(went.structuredContent).toMatchObject({ ok: false, failedAt: 0, calls: 2 });
      expect(stepsOf(went)[1]).toEqual({ index: 1, call: "run_command", ok: true, text: "god on" });
    });

    it("fails a repeat whose until never holds and an expect that doesn't, stopping at the first unless told to continue", async () => {
      const h = await live({ responses: { findactors: ["MCP_FOUND", "found class=DoomImp tid=7 flags=m"] } });
      const none = { kind: "actors", class: "DoomImp", op: "==", value: 0 };
      const steps = [{ repeat: [{ call: "step", args: { tics: 1 } }], until: none, maxIterations: 3 }, { expect: none }];
      const until = { index: 0, iterations: 3, ok: false, text: "until not met: 1 == 0, within 3 iteration(s)" };
      const stopped = await h.call("run_scenario", { steps });
      expect(stopped.isError).toBe(true);
      expect(stopped.structuredContent).toMatchObject({ ok: false, failedAt: 0, calls: 3 });
      expect(stepsOf(stopped)).toMatchObject([until]);
      const went = await h.call("run_scenario", { steps, onFail: "continue" });
      expect(went.isError).toBeUndefined();
      expect(went.structuredContent).toMatchObject({ ok: false, failedAt: 0, calls: 3 });
      expect(stepsOf(went)).toMatchObject([until, { index: 1, expect: "actors", ok: false, text: "not met: 1 == 0" }]);
      expect((went.content?.[0]?.text ?? "").split("\n").slice(1)).toEqual([
        "0 repeat x3: FAILED - until not met: 1 == 0, within 3 iteration(s)",
        "1 expect actors: FAILED - not met: 1 == 0",
      ]);
    });

    it("stops before the next step once the client cancels, sending the engine nothing more", async () => {
      // Driven directly: through a real client the cancelled call rejects at once, with no sign of when the run ended.
      const h = await withStatus();
      const cancel = new AbortController();
      bridge!.onCommand("first", () => cancel.abort());
      bridge!.clearReceived();
      const steps = [{ call: "run_command", args: { text: "first" } }, { call: "run_command", args: { text: "second" } }];
      const res = await collectTools(h.ctx).get("run_scenario")!({ instance: 1, steps, onFail: "continue", maxSeconds: 60 }, { signal: cancel.signal });
      // The start maptime read, then step 0: no step 1 and no end maptime read.
      expect(cmds().map(sentinel)).toEqual(["mcp_status S", "first ; mcp_status S"]);
      expect(res.isError).toBe(true);
      expect(stepsOf(res)[1]).toEqual({ index: 1, call: "run_command", ok: false, text: "stopped: the client cancelled the run" });
    });

    it("cuts a large step result to fit, with how to get all of it", async () => {
      const rows = Array.from({ length: 30 }, (_, i) => `found class=DoomImp tid=${i + 1}`);
      const h = await live({ responses: { findactors: ["MCP_FOUND", ...rows] } });
      const res = await h.call("run_scenario", { steps: [{ call: "find_actors" }] });
      const step = stepsOf(res)[0];
      expect((step.structured as { actors: unknown[] }).actors).toHaveLength(20);
      expect(step).toMatchObject({ omitted: { rows: 10 }, hint: "cut to fit; call find_actors on its own for all of it" });
    });

    it("reports progress once for the whole run, never an inner tool's own", async () => {
      const h = await live();
      const { result, progress } = await h.callWithProgress("run_scenario", { steps: [{ call: "step", args: { tics: 5 } }], maxSeconds: 30 });
      expect(result.structuredContent?.ok).toBe(true);
      expect(progress).toEqual([{ progress: 1000, total: 30000, message: "running scenario" }]);
    });

    it("gives the run one engine-state note, and settles and refreshes after an inner input-only step", async () => {
      const sleeps: number[] = [];
      const h = await withStatus({ io: { sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()) } });
      bridge!.setStatus({ paused: "1" });
      bridge!.clearReceived();
      const res = await h.call("run_scenario", {
        steps: [{ call: "menu_key", args: { key: "down" } }, { call: "run_command", args: { text: "x" } }],
      });
      expect(res.structuredContent?.engineState).toBe("Engine state: paused.");
      expect(stepsOf(res).every((st) => !JSON.stringify(st).includes("Engine state"))).toBe(true);
      expect(cmds().map(sentinel)).toEqual(["mcp_status S", "mcp_status S", "x ; mcp_status S", "mcp_status S"]);
      expect(sleeps).toEqual([60]);
    });
  });

  describe("watch_actors", () => {
    const instant = { sleep: () => Promise.resolve() };
    const IMP = "found class=DoomImp tid=7 hp=60 spawnhp=60 x=10.0 y=20.0 z=0.0 angle=0.0 pitch=0.0 sprite=TROO frame=A flags=mso";
    /** findactors replies from `replies` in turn (the last repeats), each run adding `dt` to maptime. */
    async function watcher(replies: string[][], dt = 2) {
      const out = [...replies[0]];
      const h = await withStatus({ responses: { findactors: out }, io: instant });
      let n = 0;
      let t = 100;
      bridge!.onCommand("findactors", () => {
        out.splice(0, out.length, ...replies[Math.min(n++, replies.length - 1)]);
        bridge!.setStatus({ maptime: String((t += dt)) });
      });
      bridge!.clearReceived();
      return h;
    }
    const finds = () => cmds().filter((c) => c.startsWith("findactors")).map((c) => c.split(" ;")[0]);

    it("samples a tid for tics map tics into one table, then leaves the game paused", async () => {
      const h = await watcher([["MCP_FOUND", IMP]]);
      const res = await h.call("watch_actors", { tid: 7, tics: 6 });
      expect(res.isError).toBeUndefined();
      expect(res.content?.[0]?.text).toBe(
        "watched tid 7 for 6 tic(s): 4 samples, 4 rows, done\nDoomImp: seen 102..108 (6 tics), max 1 at once, 4 samples",
      );
      expect(res.structuredContent).toMatchObject({
        reason: "done",
        tics: 6,
        samples: 4,
        table: { columns: ["maptime", "class", "tid", "hp", "x", "y", "z", "sprite", "frame"] },
        classes: [{ class: "DoomImp", firstSeen: 102, lastSeen: 108, maxCount: 1, samples: 4 }],
      });
      const table = res.structuredContent?.table as { rows: unknown[][] };
      expect(table.rows[0]).toEqual([102, "DoomImp", 7, 60, 10, 20, 0, "TROO", "A"]);
      expect(table.rows.map((r) => r[0])).toEqual([102, 104, 106, 108]);
      expect(finds()).toEqual(Array(4).fill("findactors tid=7 limit=50"));
      expect(bridge!.pauses).toEqual([0, 1, 0, 1, 0, 1]);
    });

    it("spaces snapshots by measured tics, topping up Zandronum's short steps", async () => {
      const clock = mapClock();
      const h = await withStatus({ responses: { findactors: ["MCP_FOUND", IMP] }, io: clock.io });
      clock.runs.length = 0;
      const t0 = clock.maptime();
      const res = await h.call("watch_actors", { tid: 7, tics: 10 });
      expect(res.structuredContent).toMatchObject({ reason: "done", tics: 10, samples: 6 });
      const table = res.structuredContent?.table as { rows: unknown[][] };
      expect(table.rows.map((r) => r[0])).toEqual([0, 2, 4, 6, 8, 10].map((d) => t0 + d));
      expect(clock.runs).toEqual(Array.from({ length: 5 }, () => [2, 1]).flat());
    });

    it("adds detail=1 only for a detail field, passing class, radius and limit", async () => {
      const h = await watcher([["MCP_FOUND", `${IMP} vel=1.00,0.00,0.00 radius=20.0 height=56.0 floorz=0.0`]]);
      const res = await h.call("watch_actors", { class: "DoomImp", radius: 300, limit: 5, tics: 2, fields: ["vel", "floorz", "vel"] });
      expect(finds()[0]).toBe("findactors class=DoomImp radius=300 limit=5 detail=1");
      expect(res.structuredContent?.table).toEqual({ columns: ["maptime", "vel", "floorz"], rows: [[102, [1, 0, 0], 0], [104, [1, 0, 0], 0]] });
      await h.call("watch_actors", { class: "DoomImp", tics: 2, fields: ["dist", "target"] });
      expect(finds().at(-1)).toBe("findactors class=DoomImp limit=50");
      const res2 = await h.call("watch_actors", { class: "DoomImp", tid: 7, tics: 2 });
      expect(finds().at(-1)).toBe("findactors class=DoomImp tid=7 limit=50");
      expect(res2.content?.[0]?.text).toMatch(/^watched DoomImp tid 7 for 2 tic\(s\)/);
    });

    it("stops gone with untilGone once the matches vanish", async () => {
      const h = await watcher([["MCP_FOUND"], ["MCP_FOUND", IMP], ["MCP_FOUND"]]);
      const res = await h.call("watch_actors", { class: "DoomImp", tics: 70, untilGone: true });
      expect(res.structuredContent).toMatchObject({ reason: "gone", tics: 4, samples: 3 });
    });

    it("reports truncated samples and dropped rows", async () => {
      const h = await watcher([["MCP_FOUND", IMP, IMP, "truncated shown=2 total=9"]]);
      const res = await h.call("watch_actors", { class: "DoomImp", tics: 2, limit: 2, maxRows: 3 });
      expect(res.structuredContent).toMatchObject({ truncatedSamples: 2, rowsDropped: 1 });
      expect(res.content?.[0]?.text).toMatch(/; 1 row\(s\) dropped past maxRows; 2 sample\(s\) cut by limit\n/);
    });

    it("fails on the first snapshot before stepping, and on a later one", async () => {
      const h = await watcher([["MCP_FOUND", "error unknown class Nope"]]);
      const res = await h.call("watch_actors", { class: "Nope" });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("unknown class Nope");
      expect(bridge!.pauses).toEqual([]);
      await harness!.close();
      await bridge!.close();
      const old = await watcher([['Unknown command "findactors"']]);
      expect((await old.call("watch_actors", { tid: 1 })).content?.[0]?.text).toBe('Unknown command "findactors"');
      await harness!.close();
      await bridge!.close();
      const later = await watcher([["MCP_FOUND", IMP], ["MCP_FOUND", "error no level"]]);
      const mid = await later.call("watch_actors", { tid: 7 });
      expect(mid.isError).toBe(true);
      expect(mid.content?.[0]?.text).toBe("no level");
      expect(bridge!.pauses).toEqual([0, 1]);
    });

    it("fails as stalled when maptime holds, keeping the partial table", async () => {
      const h = await watcher([["MCP_FOUND", IMP]], 0);
      bridge!.setStatus({ menu: "on" });
      const res = await h.call("watch_actors", { tid: 7, tics: 70 });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "the sim stopped advancing (maptime stuck at 100); a menu is open. Try ensure_live with fix.",
      );
      expect(res.structuredContent).toMatchObject({ reason: "stalled", samples: 1, error: res.content?.[0]?.text });
      // everyTics 2: three idle chunks reach the 5-tic stall window.
      expect(finds()).toHaveLength(4);
    });

    it("validates its arguments without running a command", async () => {
      const h = await watcher([["MCP_FOUND"]]);
      expect((await h.call("watch_actors", {})).content?.[0]?.text).toBe("give class, tid or both");
      for (const args of [{ tid: 1, tics: 3501 }, { tid: 1, fields: ["bogus"] }, { tid: 1, fields: [] }, { tid: 0 }]) {
        expect((await h.call("watch_actors", args)).isError).toBe(true);
      }
      expect(cmds().filter((c) => !c.startsWith("mcp_status"))).toEqual([]);
    });

    it("needs the time cap and a maptime= field", async () => {
      const h = await watcher([["MCP_FOUND"]]);
      bridge!.onCommand("findactors", () => bridge!.setStatus({ maptime: undefined }));
      expect((await h.call("watch_actors", { tid: 1 })).content?.[0]?.text).toMatch(/can't count tics: .*no maptime= field/);
      await harness!.close();
      await bridge!.close();
      const noTime = await live({ caps: ["cmd", "status"] });
      expect((await noTime.call("watch_actors", { tid: 1 })).content?.[0]?.text).toMatch(/no time-control/);
    });
  });

  describe("add_bot", () => {
    const bot = (slot: number, fields = "tid=0") => `player slot=${slot} bot=1 spec=0 ${fields} name=Bot${slot}`;
    /** dumpplayers lists the console player, then `rows(n)` from the nth read after the first addbot. */
    const players = (rows: (read: number) => string[]) => {
      const out = ["MCP_PLAYERS", "player slot=0 bot=0 spec=0 tid=0 name=Player"];
      let added = false;
      let reads = 0;
      bridge!.respondTo("dumpplayers", out);
      bridge!.onCommand("addbot", () => (added = true));
      bridge!.onCommand("dumpplayers", () => {
        out.splice(2, out.length, ...(added ? rows(reads++) : []));
      });
    };
    const text = (res: { content?: Array<{ text?: string }> }) => res.content?.[0]?.text;

    it("returns a bot that joined inside the command at once, without stepping (status-less too)", async () => {
      const h = await live();
      players(() => [bot(1, "tid=5")]);
      const res = await h.call("add_bot");
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 5");
      expect(res.structuredContent).toEqual({ bots: [{ slot: 1, name: "Bot1", tid: 5, spectator: false }], tics: 0 });
      expect(cmds().filter((c) => /^addbot ;/.test(c))).toHaveLength(1);
      expect(bridge!.pauses).toEqual([]);
    });

    it("steps in chunks until a queued bot gets its body, counting map tics", async () => {
      const h = await withStatus();
      players((n) => (n === 0 ? [] : n === 1 ? [bot(1, "state=enter")] : [bot(1, "tid=4")]));
      ticking();
      const res = await h.call("add_bot", { chunkTics: 3 });
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 4");
      expect(res.structuredContent).toEqual({ bots: [{ slot: 1, name: "Bot1", tid: 4, spectator: false }], tics: 2 });
      expect(bridge!.pauses).toEqual([0, 0]);
    });

    it("waits for a script to assign the TID after the join", async () => {
      const h = await withStatus();
      players((n) => [bot(1, n < 3 ? "tid=0" : "tid=1051")]);
      ticking();
      const res = await h.call("add_bot");
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 1051");
      expect(res.structuredContent).toMatchObject({ tics: 3 });
    });

    it("returns tid 0 with a note when no TID arrives within tidTics", async () => {
      const sleeps: number[] = [];
      const h = await withStatus({ io: { sleep: (ms) => (sleeps.push(ms), Promise.resolve()) } });
      players(() => [bot(1)]);
      ticking();
      sleeps.length = 0;
      const res = await h.call("add_bot", { tidTics: 5 });
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 0: none assigned within 5 tic(s)");
      expect(res.structuredContent).toMatchObject({ tics: 5, notes: ["Bot1 joined at slot 1, tid 0: none assigned within 5 tic(s)"] });
      // ticking() moves one tic per read, so each chunk counts 1 until 5 have run.
      expect(sleeps.map((ms) => Math.round((ms * 35) / 1000))).toEqual([2, 2, 2, 2, 1]);
    });

    it("waits the whole tidTics in measured tics, topping up Zandronum's short steps", async () => {
      const clock = mapClock();
      const h = await withStatus({ io: clock.io });
      players(() => [bot(1)]);
      clock.runs.length = 0;
      const t0 = clock.maptime();
      const res = await h.call("add_bot");
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 0: none assigned within 35 tic(s)");
      expect(res.structuredContent).toMatchObject({ tics: 35 });
      expect(clock.maptime() - t0).toBe(35);
      expect(clock.runs).toEqual([...Array(34).fill(2), 1]);
    });

    it("skips the TID wait with tidTics 0", async () => {
      const h = await withStatus();
      players(() => [bot(1)]);
      const res = await h.call("add_bot", { tidTics: 0 });
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 0");
      expect(res.structuredContent).toMatchObject({ tics: 0 });
      expect(res.structuredContent).not.toHaveProperty("notes");
      expect(bridge!.pauses).toEqual([]);
    });

    it("adds count bots, passing the name quoted", async () => {
      const h = await withStatus();
      players(() => [bot(1, "tid=0"), bot(2, "tid=0")]);
      const res = await h.call("add_bot", { count: 2, name: "Doom Guy", tidTics: 0 });
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 0\nBot2 joined at slot 2, tid 0");
      expect(cmds().filter((c) => c.startsWith('addbot "Doom Guy" ;'))).toHaveLength(2);
    });

    it("reports a partial join with what addbot said, without failing", async () => {
      const h = await withStatus();
      const said: string[] = [];
      let adds = 0;
      bridge!.respondTo("addbot", said);
      bridge!.onCommand("addbot", () => ++adds === 2 && said.push("The maximum number of players/bots has been reached."));
      players(() => [bot(1, "tid=2")]);
      ticking();
      const res = await h.call("add_bot", { count: 2, maxTics: 4 });
      expect(res.isError).toBeUndefined();
      expect(text(res)).toBe(
        "Bot1 joined at slot 1, tid 2\nonly 1 of 2 joined; addbot said: The maximum number of players/bots has been reached.",
      );
      // ticking() moves one tic per read, so the join phase runs four chunks to reach maxTics 4.
      expect(res.structuredContent).toMatchObject({
        tics: 4,
        notes: ["only 1 of 2 joined; addbot said: The maximum number of players/bots has been reached."],
      });
    });

    it("fails when no bot joins, with addbot's output and the error a join-phase read carried", async () => {
      const h = await withStatus();
      players((n) => (n === 1 ? ["couldn't find nosuchbot in bots.cfg"] : []));
      ticking();
      const res = await h.call("add_bot", { name: "nosuchbot", maxTics: 4 });
      expect(res.isError).toBe(true);
      // ticking() moves one tic per read: maxTics 4 is four chunks, where requested tics stopped at 2.
      expect(text(res)).toBe("no bot joined within 4 tic(s); addbot said: couldn't find nosuchbot in bots.cfg");
      const quiet = await h.call("add_bot", { maxTics: 1 });
      expect(text(quiet)).toMatch(/no bot joined within \d+ tic\(s\); addbot said: \(no output\)$/);
    });

    it("reports a spectator join without waiting for a TID", async () => {
      const h = await withStatus();
      players(() => ["player slot=1 bot=1 spec=1 name=Queued"]);
      const res = await h.call("add_bot");
      expect(text(res)).toBe("Queued joined at slot 1 as a spectator (join queue)");
      expect(res.structuredContent).toEqual({ bots: [{ slot: 1, name: "Queued", tid: 0, spectator: true }], tics: 0 });
      expect(bridge!.pauses).toEqual([]);
    });

    it("fails fast when the sim stops advancing", async () => {
      const h = await withStatus();
      players(() => []);
      bridge!.setStatus({ menu: "on" });
      const res = await h.call("add_bot");
      expect(res.isError).toBe(true);
      expect(text(res)).toBe("the sim stopped advancing (maptime stuck at 0); a menu is open. Try ensure_live with fix.");
    });

    /** maptime per dumpplayers call: the pre-addbot read, the first join read, then one per chunk. */
    const maptimes = (times: number[]) => {
      let call = 0;
      bridge!.onCommand("dumpplayers", () => bridge!.setStatus({ maptime: String(times[Math.min(call++, times.length - 1)]) }));
    };

    it("rides out a chunk that didn't advance maptime, as watch does", async () => {
      const h = await withStatus();
      maptimes([10, 10, 10, 12]);
      players((n) => (n < 2 ? [] : [bot(1, "tid=4")]));
      const res = await h.call("add_bot", { tidTics: 0 });
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 4");
      expect(res.structuredContent).toMatchObject({ tics: 2 });
    });

    it("says when the iteration cap ended a stuttering wait short of maxTics", async () => {
      const h = await withStatus({ responses: { addbot: ["no free slot"] } });
      // One tic every third read: the idle chunks between never add up to a stall.
      maptimes(Array.from({ length: 60 }, (_, i) => 100 + Math.floor(i / 3)));
      players(() => []);
      const res = await h.call("add_bot", { maxTics: 10, tidTics: 0 });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/^no bot joined within \d+ tic\(s\); addbot said: no free slot\njoining: stopped after \d+ of 10 tic\(s\): the iteration cap/);
    });

    it("takes a maptime that went back (a map change) as progress, not a stall", async () => {
      const h = await withStatus();
      maptimes([100, 100, 3]);
      players((n) => (n < 1 ? [] : [bot(1, "tid=4")]));
      const res = await h.call("add_bot", { tidTics: 0 });
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toMatchObject({ tics: 3 });
    });

    it("fails naming a bot that joined and then a map change removed, not as never joined", async () => {
      const h = await withStatus({ responses: { addbot: ["Bot2 entered the game"] } });
      maptimes([100, 100, 102, 104, 3]);
      players((n) => (n < 3 ? [bot(2)] : []));
      const res = await h.call("add_bot");
      expect(res.isError).toBe(true);
      expect(text(res)).toBe(
        "Bot2 joined at slot 2, then a level change removed it (level_change)\n" +
          "none left in the game after 7 tic(s); addbot said: Bot2 entered the game",
      );
    });

    it("reports the bots a map change removed beside the ones still in the game", async () => {
      const h = await withStatus();
      maptimes([100, 100, 102, 3]);
      players((n) => (n < 2 ? [bot(1, "tid=4"), bot(2)] : [bot(1, "tid=4")]));
      const res = await h.call("add_bot", { count: 2 });
      expect(res.isError).toBeUndefined();
      expect(text(res)).toBe("Bot1 joined at slot 1, tid 4\nBot2 joined at slot 2, then a level change removed it (level_change)");
      expect(res.structuredContent).toEqual({
        bots: [{ slot: 1, name: "Bot1", tid: 4, spectator: false }],
        lost: [{ slot: 2, name: "Bot2", reason: "level_change" }],
        tics: 5,
      });
    });

    it("needs the time cap and a maptime= field only once it has to step", async () => {
      const noTime = await live({ caps: ["cmd", "status"] });
      players(() => [bot(1)]);
      expect(text(await noTime.call("add_bot"))).toMatch(/no time-control/);
      await harness!.close();
      await bridge!.close();
      const noStatus = await live();
      players(() => []);
      expect(text(await noStatus.call("add_bot"))).toBe(
        "can't count tics: this engine bridge has no status support (rebuild with the latest bridge)",
      );
      await harness!.close();
      await bridge!.close();
      const old = await withStatus();
      bridge!.setStatus({ maptime: undefined });
      players(() => [bot(1)]);
      expect(text(await old.call("add_bot"))).toMatch(/can't count tics: .*no maptime= field/);
    });

    it("fails without adding a bot when dumpplayers never ran", async () => {
      const h = await live({ responses: { dumpplayers: ['Unknown command "dumpplayers"'] } });
      const res = await h.call("add_bot");
      expect(res.isError).toBe(true);
      expect(text(res)).toBe('Unknown command "dumpplayers"');
      expect(cmds().some((c) => c.startsWith("addbot"))).toBe(false);
    });

    it("pauses again after stepping a paused game", async () => {
      const h = await withStatus();
      bridge!.setStatus({ paused: "1" });
      players((n) => (n === 0 ? [] : [bot(1, "tid=3")]));
      ticking();
      await h.call("add_bot");
      expect(bridge!.pauses).toEqual([0, 1]);
    });
  });

  describe("move_to", () => {
    const pos = (x: number, y = 0) =>
      `Current player position: (${x.toFixed(1)},${y.toFixed(1)},0.0), angle: 0.0, floorheight: 0.0, sector:0, lightlevel: 160`;
    const VIEW = ["view angle=0.0 pitch=0.0"];
    const instant = { sleep: () => Promise.resolve() };
    /** A player whose reads come from `xs` in turn, the last one repeating. */
    async function walker(xs: number[], responses: Record<string, string[]> = {}) {
      const out = [pos(xs[0])];
      const h = await withStatus({ responses: { currentpos: out, mcp_setview: VIEW, ...responses }, io: instant });
      let reads = 0;
      bridge!.onCommand("currentpos", () => (out[0] = pos(xs[Math.min(reads++, xs.length - 1)])));
      bridge!.clearReceived();
      return h;
    }
    const tail = () => cmds().map((c) => c.split(" ;")[0]);

    it("walks to a point, presses, aims and releases in order, and re-pauses a paused game", async () => {
      const h = await walker([0, 500]);
      bridge!.setStatus({ paused: "1" });
      ticking();
      const res = await h.call("move_to", { to: [{ x: 500, y: 0 }], trail: true });
      expect(res.isError).toBeUndefined();
      expect(res.content?.[0]?.text).toBe("arrived at waypoint 1/1 after 5 tic(s) at (500.0, 0.0), 0.0 from target");
      expect(res.structuredContent).toMatchObject({ reason: "arrived", reached: 1, waypoints: 1, tics: 5, distance: 0 });
      expect(res.structuredContent?.trail).toEqual([[1, 0, 0], [4, 500, 0], [6, 500, 0]]);
      expect(tail()).toEqual(["currentpos", "mcp_setview 0.00", "+forward", "currentpos", "-forward", "currentpos", "-forward"]);
      await settle(() => bridge!.pauses.length === 2);
      expect(bridge!.pauses).toEqual([0, 1]);
    });

    it("resolves tid and class targets with findactors, adding the actor's radius", async () => {
      const h = await walker([540], { findactors: ["MCP_FOUND", "found class=DoomImp tid=5 x=500.0 y=0.0 radius=20.0"] });
      const byTid = await h.call("move_to", { to: [{ tid: 5 }] });
      expect(byTid.content?.[0]?.text).toBe("arrived at waypoint 1/1 after 0 tic(s) at (540.0, 0.0), 40.0 from target");
      expect(byTid.structuredContent?.target).toEqual({ tid: 5, x: 500, y: 0 });
      const byClass = await h.call("move_to", { to: [{ class: "DoomImp" }] });
      expect(byClass.structuredContent?.target).toEqual({ class: "DoomImp", x: 500, y: 0 });
      expect(tail().filter((c) => c.startsWith("findactors"))).toEqual([
        "findactors tid=5 limit=2 detail=1",
        "findactors class=DoomImp limit=2 detail=1",
      ]);
      expect(bridge!.pauses).toEqual([0, 0]);
    });

    it("skips the console player's own match, treats a missing radius as zero and no match as target_gone", async () => {
      const h = await walker([510], {
        findactors: [
          "MCP_FOUND",
          "found class=DoomPlayer tid=5 x=510.0 y=0.0 dist=0.0 player=0",
          "found class=DoomPlayer tid=5 x=500.0 y=0.0 dist=10.0 player=1",
        ],
      });
      const other = await h.call("move_to", { to: [{ tid: 5 }] });
      expect(other.structuredContent).toMatchObject({ reason: "arrived", target: { x: 500 }, distance: 10 });
      await harness!.close();
      await bridge!.close();
      const gone = await walker([0], { findactors: ["MCP_FOUND"] });
      const res = await gone.call("move_to", { to: [{ tid: 9 }] });
      expect(res.isError).toBeUndefined();
      expect(res.content?.[0]?.text).toBe("target_gone at waypoint 1/1 after 0 tic(s) at (0.0, 0.0)");
    });

    it("releases +forward and restores the pause when a command fails", async () => {
      const h = await walker([0], { findactors: ["error unknown class Foo"] });
      bridge!.setStatus({ paused: "-1" });
      const res = await h.call("move_to", { to: [{ class: "Foo" }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/unknown class Foo/);
      expect(tail().at(-1)).toBe("-forward");
      await settle(() => bridge!.pauses.length === 2);
      expect(bridge!.pauses).toEqual([0, 1]);
      await harness!.close();
      await bridge!.close();
      const noView = await walker([0], { mcp_setview: ["error no player"] });
      const res2 = await noView.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(res2.content?.[0]?.text).toMatch(/no player/);
      expect(tail().slice(-2)).toEqual(["mcp_setview 0.00", "-forward"]);
    });

    it("fails as stalled when maptime doesn't advance, naming the blockers", async () => {
      const h = await walker([0]);
      const res = await h.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "the sim stopped advancing (maptime stuck at 0); no blocker reported. Try ensure_live with fix.",
      );
      expect(res.structuredContent).toMatchObject({ reason: "stalled", x: 0, error: res.content?.[0]?.text });
      expect(bridge!.pauses).toEqual([0]);
      bridge!.setStatus({ menu: "on" });
      const blocked = await h.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(blocked.content?.[0]?.text).toMatch(/stuck at 0\); a menu is open\./);
    });

    it("reports a level exit that freezes maptime as player_gone, not an error", async () => {
      const h = await walker([0]);
      bridge!.onCommand("+forward", () => bridge!.setStatus({ gamestate: "intermission" }));
      const res = await h.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toMatchObject({ reason: "player_gone" });
    });

    it("stops died for a dead or spectating player, and player_gone when currentpos finds none", async () => {
      const h = await walker([0, 0, 0, NaN]);
      bridge!.setStatus({ player: "dead" });
      const dead = await h.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(dead.content?.[0]?.text).toBe("died at waypoint 1/1 after 0 tic(s) at (0.0, 0.0)");
      expect(dead.structuredContent).toMatchObject({ reason: "died" });
      bridge!.setStatus({ player: "alive", spectating: "1" });
      const spec = await h.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(spec.structuredContent).toMatchObject({ reason: "died" });
      bridge!.setStatus({ spectating: "0" });
      ticking();
      const res = await h.call("move_to", { to: [{ x: 900, y: 0 }] });
      expect(res.content?.[0]?.text).toBe("player_gone at waypoint 1/1 after 0 tic(s) at (0.0, 0.0), 900.0 from target");
    });

    it("validates waypoints and needs a player, the time cap and a maptime= field", async () => {
      const h = await withStatus({ io: instant });
      bridge!.clearReceived();
      for (const to of [[{ x: 1 }], [{ tid: 1, class: "A" }], [{ x: 1, y: 2, tid: 3 }], [{ x: 1, y: 2 }, {}]]) {
        const res = await h.call("move_to", { to });
        expect(res.content?.[0]?.text).toMatch(/^waypoint \d: give exactly one of x and y, tid or class$/);
      }
      expect(cmds().filter((c) => !c.startsWith("mcp_status"))).toEqual([]);
      expect((await h.call("move_to", { to: [{ x: 1, y: 2 }] })).content?.[0]?.text).toBe("no player (not in a level?)");
      bridge!.respondTo("currentpos", [pos(0)]);
      bridge!.setStatus({ maptime: undefined });
      expect((await h.call("move_to", { to: [{ x: 1, y: 2 }] })).content?.[0]?.text).toMatch(
        /can't count tics: .*no maptime= field/,
      );
      await harness!.close();
      await bridge!.close();
      const noTime = await live({ caps: ["cmd", "status"] });
      expect((await noTime.call("move_to", { to: [{ x: 1, y: 2 }] })).content?.[0]?.text).toMatch(/no time-control/);
    });
  });

  describe("input_timeline", () => {
    const tic = (tag: string, maptime: number, seg: number, x: number) =>
      `${tag} maptime=${maptime} seg=${seg} x=${x.toFixed(3)} y=0.000 z=0.000 angle=0.000 pitch=0.000 momx=0.0000 momy=0.0000 momz=0.0000 health=100 buttons=-`;
    const status = (active: number, consumed: number, total: number, reason = "-") =>
      `MCP_INPUT active=${active} consumed=${consumed} total=${total} seg=1 maptime=${100 + consumed} reason=${reason}`;
    const ARMED = ["MCP_INPUT cleared", "MCP_INPUT seg 1 total=5", "MCP_INPUT armed segs=2 tics=5 maptime=100"];
    const TRAIL = ["MCP_INPUT_TRAIL", tic("start", 100, 0, 0), tic("tic", 101, 1, 20), tic("tic", 104, 2, 50)];
    const sent = () => cmds().map((c) => c.split(" ;")[0]).filter((c) => !c.startsWith("mcp_status"));

    /** An engine whose status polls answer from `statuses` in turn, the last one repeating. */
    async function timeline(statuses: string[], responses: Record<string, string[]> = {}, opts: LiveOptions = {}) {
      const reply = [statuses[0]];
      const h = await live({
        ...opts,
        caps: ["cmd", "event", "time", "status", "input"],
        responses: {
          "mcp_input go": ARMED,
          "mcp_input status": reply,
          "mcp_input trail": TRAIL,
          "mcp_input stop": ["MCP_INPUT idle"],
          ...responses,
        },
      });
      let polls = 0;
      bridge!.onCommand("mcp_input status", () => (reply[0] = statuses[Math.min(polls++, statuses.length - 1)]));
      bridge!.clearReceived();
      return h;
    }

    it("sends the schedule as one command, polls to done, and splits the log per segment", async () => {
      let reads = 0;
      const logs = [
        "old\n",
        [
          "old", "MCP_INPUT cleared", "stray", "MCP_INPUT_SEG 1 maptime=100", "bang", status(1, 2, 5),
          "MCP_INPUT_SEG 2 maptime=102", "\x1cGclick", "MCP_INPUT_END reason=done consumed=5 maptime=105", "late", "",
        ].join("\n"),
      ];
      const h = await timeline([status(1, 2, 5), status(0, 5, 5, "done")], {}, {
        config: { exe: "/engine/zandronum" },
        io: { existsSync: () => true, readTextSync: () => logs[Math.min(reads++, 1)] },
      });
      bridge!.setStatus({ paused: "1" });
      const { result, progress } = await h.callWithProgress("input_timeline", {
        segments: [
          { tics: 2, buttons: ["attack"], forward: 1 },
          { tics: 3, angle: 450, pitch: -10 },
        ],
      });
      expect(result.isError).toBeUndefined();
      expect(result.content?.[0]?.text).toBe(
        [
          "seg 1/2 maptime 100-101 (2 tic(s)): (0.0, 0.0, 0.0) -> (20.0, 0.0, 0.0) angle 0.0, health 100",
          "  bang",
          "seg 2/2 maptime 102-104 (3 tic(s)): (20.0, 0.0, 0.0) -> (50.0, 0.0, 0.0) angle 0.0, health 100",
          "  click",
        ].join("\n"),
      );
      expect(result.structuredContent).toMatchObject({
        reason: "done",
        tics: 5,
        segments: [
          { seg: 1, start: 100, end: 101, tics: 2, to: { x: 20 }, log: ["bang"] },
          { seg: 2, start: 102, end: 104, tics: 3, from: { x: 20 }, to: { x: 50 }, log: ["click"] },
        ],
      });
      expect(result.structuredContent?.trail).toBeUndefined();
      expect(sent()).toEqual([
        "mcp_input stop",
        "mcp_input stop; mcp_input clear; mcp_input seg 2 attack 12800 0 0 - 0 -; mcp_input seg 3 - 0 0 0 90 0 -10; mcp_input go 1",
        "mcp_input status",
        "mcp_input status",
        "mcp_input trail ends",
      ]);
      expect(progress[0]).toMatchObject({ message: "running 5 tic(s) of input" });
      // The engine restores the pause itself: the host never sends setpause.
      expect(bridge!.pauses).toEqual([]);
    });

    it("returns per-tic rows with trail, arms an unpaused game unpaused, and says when there is no log", async () => {
      const h = await timeline([status(0, 5, 5, "done")]);
      const res = await h.call("input_timeline", { segments: [{ tics: 5 }], trail: true });
      expect(res.content?.[0]?.text).toMatch(/^seg 1\/1 maptime 100-101 .*\nseg 2\/1 .*\n\(no engine log to read\)$/);
      expect(res.structuredContent?.notes).toEqual(["(no engine log to read)"]);
      expect(res.structuredContent?.trail).toEqual([
        expect.objectContaining({ maptime: 101, seg: 1, x: 20, buttons: [] }),
        expect.objectContaining({ maptime: 104, seg: 2, x: 50 }),
      ]);
      expect(sent().slice(1)).toEqual([
        "mcp_input stop; mcp_input clear; mcp_input seg 5 - 0 0 0 - 0 -; mcp_input go 0",
        "mcp_input status",
        "mcp_input trail 0",
      ]);
    });

    it("notes log lines beyond the window it reads", async () => {
      let reads = 0;
      const after = ["MCP_INPUT_SEG 1 maptime=100", ...Array.from({ length: 300 }, (_, i) => `line ${i}`), ""].join("\n");
      const h = await timeline([status(0, 1, 1, "done")], {}, {
        config: { exe: "/engine/zandronum" },
        io: { existsSync: () => true, readTextSync: () => (reads++ === 0 ? "" : after) },
      });
      const res = await h.call("input_timeline", { segments: [{ tics: 1 }] });
      expect(res.content?.[0]?.text).toMatch(/\n {2}line 206\n.*\n\(93 more log line\(s\) not read\)$/s);
      expect(res.structuredContent?.notes).toEqual(["(93 more log line(s) not read)"]);
      expect((res.structuredContent?.segments as Array<{ log: string[] }>)[0].log).toHaveLength(207);
    });

    it("refuses an invalid timeline before sending anything", async () => {
      const h = await timeline([status(0, 0, 0)]);
      const both = await h.call("input_timeline", { segments: [{ tics: 1, angle: 0, turn: 1 }] });
      expect(both.isError).toBe(true);
      expect(both.content?.[0]?.text).toBe("segment 1: give angle or turn, not both");
      const long = await h.call("input_timeline", { segments: [{ tics: 2000 }, { tics: 2000 }] });
      expect(long.content?.[0]?.text).toBe("4000 tics in all; the limit is 2100 (60 s)");
      for (const segments of [[], [{ tics: 1, button: ["attack"] }], [{ tics: 0 }]]) {
        expect((await h.call("input_timeline", { segments })).isError).toBe(true);
      }
      expect(sent()).toEqual([]);
    });

    it("needs the input cap, a status snapshot and no blockers", async () => {
      const h = await timeline([status(0, 0, 0)]);
      bridge!.setStatus({ menu: "on", player: "dead" });
      const blocked = await h.call("input_timeline", { segments: [{ tics: 1 }] });
      expect(blocked.isError).toBe(true);
      expect(blocked.content?.[0]?.text).toBe(
        "can't run a timeline: a menu is open, player is dead. Try ensure_live with fix.",
      );
      bridge!.setStatus({ menu: "off", player: "alive", paused: undefined });
      const unread = await h.call("input_timeline", { segments: [{ tics: 1 }] });
      expect(unread.content?.[0]?.text).toMatch(/^can't run a timeline: .*no paused= field/);
      // Each refusal still stopped an abandoned run first, and armed nothing.
      expect(sent()).toEqual(["mcp_input stop", "mcp_input stop"]);
      await harness!.close();
      await bridge!.close();
      const noCap = await withStatus();
      bridge!.clearReceived();
      const res = await noCap.call("input_timeline", { segments: [{ tics: 1 }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/no scripted-input support/);
      expect(sent()).toEqual([]);
    });

    it("surfaces the engine's error when go doesn't arm, without polling", async () => {
      const refusal = [
        "MCP_INPUT cleared",
        "error unknown button 'atack' (known: attack,use)",
        "error bad timeline: a seg failed, mcp_input clear first",
      ];
      const h = await timeline([status(0, 0, 0)], { "mcp_input go": refusal });
      const res = await h.call("input_timeline", { segments: [{ tics: 1, buttons: ["atack"] }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("unknown button 'atack' (known: attack,use)");
      expect(sent()).toHaveLength(2);
    });

    it("stops a stalled run and reports it as an error with the blockers", async () => {
      const h = await timeline([status(1, 3, 35)]);
      bridge!.onCommand("mcp_input status", () => bridge!.setStatus({ console: "down", maptime: "103" }));
      const res = await h.call("input_timeline", { segments: [{ tics: 35 }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe(
        "the sim stopped advancing (maptime stuck at 103); console is down. Try ensure_live with fix.",
      );
      expect(res.structuredContent).toEqual({
        reason: "stalled",
        tics: 3,
        error: "the sim stopped advancing (maptime stuck at 103); console is down. Try ensure_live with fix.",
        engineState: "Engine state: console is down.",
      });
      // One read that made progress, ten that didn't, then the stop.
      expect(sent().filter((c) => c === "mcp_input status")).toHaveLength(11);
      expect(sent().at(-1)).toBe("mcp_input stop");
    });

    it("keeps going through many polls while tics keep running", async () => {
      const progressing = Array.from({ length: 14 }, (_, i) => status(1, i + 1, 70));
      const h = await timeline([...progressing, status(0, 70, 70, "done")]);
      const res = await h.call("input_timeline", { segments: [{ tics: 70 }] });
      expect(res.isError).toBeUndefined();
      expect(res.structuredContent).toMatchObject({ reason: "done", tics: 70 });
      expect(sent().filter((c) => c === "mcp_input status")).toHaveLength(15);
      expect(sent()).not.toContain("mcp_input stop; mcp_input stop");
      expect(sent().filter((c) => c === "mcp_input stop")).toHaveLength(1);
    });

    it("keeps the original error when the bridge dies mid-run and the stop fails too", async () => {
      const h = await timeline([status(1, 1, 5)]);
      bridge!.onCommand("mcp_input status", () => bridge!.resetClients());
      const res = await h.call("input_timeline", { segments: [{ tics: 5 }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).not.toMatch(/mcp_input stop/);
    });

    it("reports a level change with the segments that ran", async () => {
      const h = await timeline([status(0, 1, 40, "level_change")], {
        "mcp_input trail": ["MCP_INPUT_TRAIL", tic("start", 100, 0, 0), tic("tic", 100, 1, 9)],
      });
      const res = await h.call("input_timeline", { segments: [{ tics: 10 }, { tics: 30 }] });
      expect(res.isError).toBeUndefined();
      expect(res.content?.[0]?.text).toBe(
        "seg 1/2 maptime 100-100 (1 tic(s)): (0.0, 0.0, 0.0) -> (9.0, 0.0, 0.0) angle 0.0, health 100\n" +
          "level_change after 1 of 40 tic(s)\n(no engine log to read)",
      );
      expect(res.structuredContent).toMatchObject({ reason: "level_change", tics: 1 });
    });

    it("stops the timeline when a status read comes back unparseable", async () => {
      const h = await timeline(["Unknown command"]);
      const res = await h.call("input_timeline", { segments: [{ tics: 5 }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/Unknown command/);
      expect(sent().slice(-2)).toEqual(["mcp_input status", "mcp_input stop"]);
    });

    it("fails when the trail can't be read", async () => {
      for (const trail of [[], ["MCP_INPUT_TRAIL"]]) {
        const h = await timeline([status(0, 5, 5, "done")], { "mcp_input trail": trail });
        const res = await h.call("input_timeline", { segments: [{ tics: 5 }] });
        expect(res.isError).toBe(true);
        await harness!.close();
        await bridge!.close();
      }
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

  const sentCmds = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => (m.text ?? "").split(" ;")[0]);
  // Twelve scripts by total descending, so the engine's own top 10 would drop the last two.
  const twelve = [
    "All scripts:",
    ...Array.from({ length: 12 }, (_, i) => `MOD          ${i + 1}  ${1200 - i * 100} 1 ${1200 - i * 100} 1 1`),
    "All functions:",
    "MOD          fn  7 7 1 1 1",
  ];

  it("fetches every row with acsprofile total 0 and ranks and limits them host-side", async () => {
    const h = await live({ responses: { acsprofile: twelve } });
    const res = await h.call("profile_scripts");
    expect(res.content?.[0]?.text).toBe("11 of 13 profiled (top 10 per section by total)");
    // Claude Code shows only the structured half, so it must say the rows are a slice too.
    expect(res.structuredContent).toMatchObject({ profiled: { scripts: 12, functions: 1 }, limit: 10, sort: "total" });
    expect(await h.text("profile_scripts", { sort: "runs", limit: 12 })).toBe("13 of 13 profiled (top 12 per section by runs)");
    const avg = await h.call("profile_scripts", { sort: "avg", limit: 1 });
    expect((avg.structuredContent as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual(["1", "fn"]);
    // Nothing printed truncated, so no dump round trip.
    expect(sentCmds()).toEqual(["acsprofile total 0", "acsprofile total 0", "acsprofile total 0"]);
  });

  it("resolves truncated names from the dumps, fetching only the listing a cut row needs", async () => {
    const h = await live({
      responses: {
        acsprofile: [
          "All scripts:",
          'BEHAVIOR     "AVeryLongProfiledSc        50       1      50      50      50',
          "All functions:",
          "BEHAVIOR     spinfn                      20       5       4       4       4",
        ],
        dumpmodules: ["MCP_MODULES", "module 0 BEHAVIOR"],
        dumpscripts: ["MCP_SCRIPTS", "script 0 -1 AVeryLongProfiledScript 0 0"],
      },
    });
    const res = await h.call("profile_scripts");
    expect((res.structuredContent as { entries: { name: string }[] }).entries.map((e) => e.name)).toEqual([
      '"AVeryLongProfiledScript"',
      "spinfn",
    ]);
    expect(sentCmds()).toEqual(["acsprofile total 0", "dumpmodules", "dumpscripts"]);
  });

  it("fetches dumpfunctions alone for a cut function name, and flags one that doesn't resolve", async () => {
    const h = await live({
      responses: {
        acsprofile: ["All functions:", "BEHAVIOR     averylongfunctionnam        20       5       4       4       4"],
        dumpmodules: ["MCP_MODULES", "module 0 BEHAVIOR"],
        dumpfunctions: ["MCP_FUNCTIONS"],
      },
    });
    const res = await h.call("profile_scripts");
    expect(res.structuredContent).toMatchObject({ entries: [{ name: "averylongfunctionnam", truncated: true }] });
    expect(sentCmds()).toEqual(["acsprofile total 0", "dumpmodules", "dumpfunctions"]);
  });

  it("profiles a time window, clearing first", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    expect(await h.text("profile_window", { seconds: 2 })).toBe("1 of 1 profiled over 2s (top 10 per section by total)");
    await h.call("profile_window", { sort: "runs", limit: 3 });
    const sent = sentCmds();
    expect(sent[0]).toBe("acsprofile clear");
    expect(sent[3]).toBe("acsprofile total 0");
  });

  it("closes both profile descriptions on the adapter's note, with no trailing space for an empty one", async () => {
    for (const variant of [engine, { ...engine, notes: { ...engine.notes, profileScripts: "" } }]) {
      const h = await live({ engine: variant });
      const { tools } = await h.client.listTools();
      for (const name of ["profile_scripts", "profile_window"]) {
        const description = tools.find((t) => t.name === name)?.description ?? "";
        expect(description).toContain("top 10 per section");
        expect(description.endsWith(variant.notes.profileScripts || "with truncated: true.")).toBe(true);
      }
      await harness!.close();
      await bridge!.close();
    }
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

  // The captured dumprenderer reply; renderer_info keeps its own slice of the keys.
  it("returns every captured renderer key and no viewport/HUD keys", async () => {
    const h = await live({ responses: { dumprenderer: engineFixture("zandronum", "dumprenderer.txt") } });
    const info = (await h.call("renderer_info")).structuredContent as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(
      ["renderer", "gl_vendor", "gl_shadermodel", "gl_maxtexsize", "screen_width", "screen_height",
        "vid_renderer", "fullscreen", "vid_vsync", "vid_defwidth", "vid_defheight"].sort(),
    );
    expect(info.renderer).toBe("opengl");
  });

  it("keeps the other render keys it knows when an overlay sends them", async () => {
    const dump = ["MCP_RENDERER", "renderer=vulkan", "screen_width=819", "client_width=819", "client_height=614",
      "device=GPU", "view_x=0", "fps=144", "vid_preferbackend=1", "vid_fullscreen=false", "st_scale=-1"];
    const h = await live({ responses: { dumprenderer: dump } });
    const info = (await h.call("renderer_info")).structuredContent as Record<string, unknown>;
    expect(Object.keys(info).sort()).toEqual(
      ["renderer", "screen_width", "client_width", "client_height", "device", "fps", "vid_preferbackend", "vid_fullscreen"].sort(),
    );
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

  it("finds UDMF sectors by an extra tag in moreids", async () => {
    const textmap = 'namespace = "zdoom"; sector { id = 1; moreids = "5"; } sector { id = 5; } sector { }';
    const udmf = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "TEXTMAP", data: Buffer.from(textmap, "ascii") },
      { name: "ENDMAP" },
    ]);
    const h = await offline({ iwad: "/game/doom2.wad" }, { readFileSync: () => udmf });
    const result = await h.call("find_sectors_by_tag", { map: "MAP01", tag: 5 });
    const { sectors } = result.structuredContent as { sectors: { index: number }[] };
    expect(sectors.map((s) => s.index)).toEqual([0, 1]);
  });
});

describe("process management tools", () => {
  it("refuses to launch without an engine configured", async () => {
    const h = await offline();
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain(`Set ${envName(engine, "EXE")} to the engine path (${engine.exeHint})`);
  });

  it("refuses to launch an engine path that doesn't exist", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/not found at/);
  });

  it("refuses to launch a build without the MCP bridge", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: () => true, hasBridge: (_exe, marker) => marker !== envName(engine, "BRIDGE_PORT") },
    );
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toMatch(/has no MCP bridge/);
  });

  it("launches, attaches, and remembers the port it picked", async () => {
    bridge = await FakeBridge.start();
    const registry = new InstanceRegistry(engine);
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
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
      registry,
    });
    const result = await harness.call("launch_instance");
    expect(result.content?.[0]?.text).toBe(`launched instance 1 on bridge port ${bridge.port}`);
    expect(harness.ctx.logPathFor(1)).toBe(path.join("/engine", `mcp-bridge-${bridge.port}.log`));
  });

  it("reports a pre-spawn setup failure as itself, not with an earlier run's log", async () => {
    harness = await startHarness({
      config: { exe: "/engine/zandronum" },
      io: {
        existsSync: () => true,
        readTextSync: () => "an earlier run's bridge log",
        hasBridge: () => true,
        findFreePort: (start) => Promise.resolve(start),
        launchIo: {
          spawn: () => {
            throw new Error("must not spawn");
          },
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
          ensureDir: () => {
            throw new Error("EROFS");
          },
          seedConfig: () => {},
        },
      },
    });
    const result = await harness.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(`can't create the config folder (${envName(engine, "CONFIG")} moves it): EROFS`);
  });

  it("falls back to the configured IWAD when none is passed", async () => {
    bridge = await FakeBridge.start();
    const registry = new InstanceRegistry(engine);
    let spawnArgs: string[] = [];
    harness = await startHarness({
      config: {
        exe: "/engine/zandronum",
        basePort: bridge.port,
        iwad: "/wads/DOOM2.WAD",
      },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        findFreePort: (start) => Promise.resolve(start),
        launchIo: {
          spawn: (_exe, args) => {
            spawnArgs = args;
            return { pid: undefined, kill: () => {} };
          },
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
      registry,
    });
    await harness.call("launch_instance");
    expect(spawnArgs).toContain("-iwad");
    expect(spawnArgs[spawnArgs.indexOf("-iwad") + 1]).toBe("/wads/DOOM2.WAD");
  });

  it("prefers an explicit iwad argument over the configured one", async () => {
    bridge = await FakeBridge.start();
    const registry = new InstanceRegistry(engine);
    let spawnArgs: string[] = [];
    harness = await startHarness({
      config: {
        exe: "/engine/zandronum",
        basePort: bridge.port,
        iwad: "/wads/DOOM2.WAD",
      },
      io: {
        existsSync: () => true,
        hasBridge: () => true,
        findFreePort: (start) => Promise.resolve(start),
        launchIo: {
          spawn: (_exe, args) => {
            spawnArgs = args;
            return { pid: undefined, kill: () => {} };
          },
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
      registry,
    });
    await harness.call("launch_instance", { iwad: "/other/PLUTONIA.WAD" });
    expect(spawnArgs[spawnArgs.indexOf("-iwad") + 1]).toBe("/other/PLUTONIA.WAD");
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
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Engine log shows:[\s\S]*Unknown actor/);
  });

  it("fails fast with the engine's stderr when it exits during startup", async () => {
    const files: Record<string, string> = {
      ".log": "Init game engine.\nScript error, \"DECORATE\" line 7:\n",
      ".stderr": "Script error, \"DECORATE\" line 7:\nUnknown actor 'Foo'\nExecution could not continue.\n",
    };
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: () => true,
        hasBridge: () => true,
        readTextSync: (p: string) => files[path.extname(p)],
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {}, exited: Promise.resolve({ code: 255, signal: null }) }),
          // The port never opens: only the exit can end this launch.
          waitForPort: () => new Promise<void>(() => {}),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(
      [
        "Instance 1 failed to come up: engine exited during startup (exit code 255).",
        "Engine stderr:\nScript error, \"DECORATE\" line 7:\nUnknown actor 'Foo'\nExecution could not continue.",
        "Engine log shows:\nScript error, \"DECORATE\" line 7:",
      ].join("\n\n"),
    );
  });

  it("says so when a failed launch left no explanation in the log", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: (p: string) => !/\.log(\.stderr)?$/.test(p),
        hasBridge: () => true,
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          // A non-Error rejection must still be reported, not swallowed.
          waitForPort: () => Promise.reject("boom"),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
    );
    const result = await h.call("launch_instance");
    expect(result.content?.[0]?.text).toBe(
      "Instance 1 failed to come up: boom.\n\nNo compile errors found in the engine log. It may have crashed, or the bridge build is stale.",
    );
  });

  it("reports a log that exists but holds no recognisable errors", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: (p: string) => !p.endsWith(".stderr"),
        hasBridge: () => true,
        readTextSync: () => "all quiet\n",
        launchIo: {
          spawn: () => ({ pid: 1234, kill: () => {} }),
          waitForPort: () => Promise.reject(new Error("timeout")),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
    );
    expect((await h.call("launch_instance")).content?.[0]?.text).toBe(
      "Instance 1 failed to come up: timeout.\n\nEngine log tail:\nall quiet\n\nNo compile errors found in the engine log. It may have crashed, or the bridge build is stale.",
    );
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
          ensureDir: () => {},
          seedConfig: () => {},
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
    bridge = await FakeBridge.start();
    harness = await startHarness({ config: { basePort: bridge.port } });
    // Attached, not launched: no child pid to watch exit, so quit() forces it.
    await harness.call("attach_instance");
    expect(await harness.text("kill_instance")).toBe(
      "instance 1 did not quit on request — force-killed",
    );
  });

  it("reports an instance id with nothing attached instead of a force-kill", async () => {
    const registry = new InstanceRegistry(engine);
    harness = await startHarness({ registry });
    expect(await harness.text("kill_instance")).toBe("no instance 1 attached, nothing to kill");
  });

  it("resets without an orphan sweep when no engine is configured", async () => {
    const h = await offline();
    expect(await h.text("reset")).toContain(`${envName(engine, "EXE")} unset, so no orphan sweep`);
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

  describe("wait: false", () => {
    // A PID that is not (and cannot be) running, so a graceful quit sees the engine gone at once.
    const DEAD_PID = 0x7ffffff0;

    /** A launch on `bridge` whose spawns, port waits and kills are counted. */
    async function noWaitRig(opts: { pid?: number; portOpen?: boolean; spawn?: () => never } = {}) {
      bridge = await FakeBridge.start();
      const seen = { spawns: 0, waits: 0, killed: 0 };
      harness = await startHarness({
        config: { exe: "/engine/zandronum", basePort: bridge.port },
        io: {
          existsSync: (p) => p === "/engine/zandronum",
          hasBridge: () => true,
          portOpen: () => Promise.resolve(opts.portOpen === true),
          launchIo: {
            spawn: () => {
              seen.spawns++;
              if (opts.spawn) opts.spawn();
              return { pid: "pid" in opts ? opts.pid : DEAD_PID, kill: () => void seen.killed++ };
            },
            waitForPort: () => {
              seen.waits++;
              return Promise.resolve();
            },
            clearQuarantine: () => {},
            ensureDir: () => {},
            seedConfig: () => {},
          },
        },
      });
      return { h: harness, seen };
    }

    it("returns once spawned, with no port wait or progress, and attaches on the first tool call", async () => {
      const { h, seen } = await noWaitRig();
      const { result, progress } = await h.callWithProgress("launch_instance", { wait: false });
      expect(result.content).toEqual([
        {
          type: "text",
          text: `spawned instance 1 on bridge port ${bridge!.port}\nNot attached yet (engine PID ${DEAD_PID}): its first tool call waits for the bridge and attaches.`,
        },
      ]);
      expect(progress).toEqual([]);
      expect(seen.waits).toBe(0);
      expect(h.ctx.registry.pending(1)).toBe(true);
      expect(h.ctx.enginePidFor(1)).toBe(DEAD_PID);
      bridge!.respondTo("version", ["Zandronum 3.2.1"]);
      expect(await h.text("run_command", { text: "version" })).toBe("Zandronum 3.2.1");
      expect(seen.waits).toBe(1);
      expect(h.ctx.registry.pending(1)).toBe(false);
    });

    it("leaves the PID out of the reply when the child has none", async () => {
      const { h } = await noWaitRig({ pid: undefined });
      expect(await h.text("launch_instance", { wait: false })).toBe(
        `spawned instance 1 on bridge port ${bridge!.port}\nNot attached yet: its first tool call waits for the bridge and attaches.`,
      );
    });

    it("reports a spawn that throws through the launch failure path", async () => {
      const { h } = await noWaitRig({
        spawn: () => {
          // A non-Error throw must still be reported, not swallowed.
          throw "spawn EACCES";
        },
      });
      const result = await h.call("launch_instance", { wait: false });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/^Instance 1 failed to come up: spawn EACCES\./);
    });

    it("launch_instance refuses a pending instance instead of spawning beside it", async () => {
      const { h, seen } = await noWaitRig();
      await h.call("launch_instance", { wait: false });
      const result = await h.call("launch_instance", { wait: false });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(/still waiting from a wait: false launch; kill_instance or relaunch_instance/);
      expect(seen.spawns).toBe(1);
    });

    it("launch_instance replaces a pending instance whose engine died", async () => {
      const { h, seen } = await noWaitRig();
      await h.call("launch_instance", { wait: false });
      h.ctx.io.alive = () => false;
      expect((await h.call("launch_instance", { wait: false })).isError).toBeFalsy();
      expect(seen.spawns).toBe(2);
    });

    it("attach_instance refuses a pending instance, keeping its launch options", async () => {
      const { h } = await noWaitRig();
      await h.call("launch_instance", { wait: false, extraArgs: ["-host", "2"] });
      const result = await h.call("attach_instance");
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe("Instance 1 was launched with wait: false; call any tool on it to attach.");
      expect(h.ctx.launchArgsFor(1)?.args.extraArgs).toEqual(["-host", "2"]);
      expect(h.ctx.registry.pending(1)).toBe(true);
    });

    it("attach_instance replaces a pending instance whose engine died", async () => {
      const { h } = await noWaitRig();
      await h.call("launch_instance", { wait: false });
      h.ctx.io.alive = () => false;
      expect((await h.call("attach_instance", { port: bridge!.port })).isError).toBeFalsy();
      expect(h.ctx.registry.pending(1)).toBe(false);
      expect(h.ctx.registry.childPid(1)).toBeUndefined();
    });

    it("attach_instance still refuses a pending instance with no child PID to probe", async () => {
      const { h } = await noWaitRig({ pid: undefined });
      await h.call("launch_instance", { wait: false });
      h.ctx.io.alive = () => false;
      expect((await h.call("attach_instance")).isError).toBe(true);
      expect(h.ctx.registry.pending(1)).toBe(true);
    });

    it("kill_instance attaches a pending instance whose bridge is up, so it quits cleanly", async () => {
      const { h, seen } = await noWaitRig({ portOpen: true });
      await h.call("launch_instance", { wait: false });
      expect(await h.text("kill_instance")).toBe("instance 1 quit cleanly");
      expect(seen.waits).toBe(1);
      // The quit is fire-and-forget, so let the socket deliver it.
      await vi.waitFor(() => expect(bridge!.received.some((m) => m.t === "cmd" && m.text === "quit")).toBe(true));
      expect(seen.killed).toBe(0);
    });

    it("kill_instance force-kills a pending instance whose bridge isn't up, without attaching", async () => {
      const { h, seen } = await noWaitRig({ pid: undefined });
      await h.call("launch_instance", { wait: false });
      expect(await h.text("kill_instance")).toBe("instance 1 killed before its bridge came up");
      expect(seen.waits).toBe(0);
      expect(seen.killed).toBe(1);
      expect(h.ctx.isBound(1)).toBe(false);
    });

    it("run_scenario refuses a bad step without attaching a pending instance", async () => {
      const { h, seen } = await noWaitRig({ pid: undefined });
      await h.call("launch_instance", { wait: false });
      const res = await h.call("run_scenario", { steps: [{ call: "kill_instance" }] });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/^refused, nothing ran:\nstep 0 \(kill_instance\)/);
      expect(seen.waits).toBe(0);
      expect(h.ctx.registry.pending(1)).toBe(true);
    });

    it("relaunch_instance stops the pending child and spawns again without waiting", async () => {
      const { h, seen } = await noWaitRig({ pid: undefined });
      await h.call("launch_instance", { wait: false, extraArgs: ["-host", "2"] });
      expect(await h.text("relaunch_instance")).toBe(
        `relaunched instance 1 on bridge port ${bridge!.port} (killed before its bridge came up)\nNot attached yet: its first tool call waits for the bridge and attaches.`,
      );
      expect(seen.killed).toBe(1);
      expect(seen.spawns).toBe(2);
      expect(seen.waits).toBe(0);
      expect(h.ctx.registry.pending(1)).toBe(true);
      expect(h.ctx.launchArgsFor(1)?.args.wait).toBe(false);
    });

    it("relaunch_instance with wait: true overrides the stored no-wait", async () => {
      const { h, seen } = await noWaitRig({ pid: undefined });
      await h.call("launch_instance", { wait: false });
      expect(await h.text("relaunch_instance", { wait: true })).toBe(
        `relaunched instance 1 on bridge port ${bridge!.port} (killed before its bridge came up)`,
      );
      expect(seen.waits).toBe(1);
      expect(h.ctx.registry.has(1)).toBe(true);
    });
  });
});

describe("relaunch_instance", () => {
  // A PID that is not (and cannot be) running, so a graceful quit sees the engine gone at once.
  const DEAD_PID = 0x7ffffff0;
  const others: FakeBridge[] = [];
  afterEach(async () => {
    // Runs before the file-level afterEach: drop the harness's sockets first, or close() waits on them.
    await harness?.close();
    harness = undefined;
    for (const b of others.splice(0)) await b.close();
  });

  interface RigOptions {
    hello?: Record<string, unknown>;
    spawnPid?: number;
    /** Reject the first launch's port wait, like an engine that aborted on a compile error. */
    failFirst?: boolean;
    io?: Partial<ContextIo>;
  }

  /** basePort 1 tells the launch's own port pick (`findFreePort(portFor(1))`) apart from
   *  relaunch's wait on the previous port, which stays busy for `busy` polls. */
  async function rig(opts: RigOptions = {}) {
    bridge = await FakeBridge.start(opts.hello ? { hello: opts.hello } : {});
    const port = bridge.port;
    const spawns: string[][] = [];
    const sleeps: number[] = [];
    const state = { busy: 0, waits: 0 };
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: 1 },
      io: {
        existsSync: (p) => p === "/engine/zandronum",
        hasBridge: () => true,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
        findFreePort: (start) => {
          return Promise.resolve(start === 1 ? port : state.busy-- > 0 ? start + 1 : start);
        },
        launchIo: {
          spawn: (_exe, args) => {
            spawns.push(args);
            return { pid: "spawnPid" in opts ? opts.spawnPid : DEAD_PID, kill: () => {} };
          },
          waitForPort: () =>
            opts.failFirst && state.waits++ === 0 ? Promise.reject(new Error("bridge port never opened")) : Promise.resolve(),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
        ...opts.io,
      },
    });
    return { h: harness, spawns, sleeps, state };
  }

  const logOf = (port: number) => path.join("/engine", `mcp-bridge-${port}.log`);

  it("refuses an instance this session never launched", async () => {
    const h = await offline({ exe: "/engine/zandronum" });
    const result = await h.call("relaunch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(
      "Instance 1 has no launch options to reuse: it was attached with attach_instance, or not launched in this MCP session. Use launch_instance.",
    );
  });

  it("refuses once attach_instance has rebound the instance", async () => {
    const { h, spawns } = await rig();
    await h.call("launch_instance");
    h.ctx.io.alive = () => false; // the launched engine died, so the attach may replace it
    const close = vi.spyOn(h.ctx.registry.get(1), "close");
    const other = await FakeBridge.start();
    others.push(other);
    expect(await h.text("attach_instance", { port: other.port })).toBe(`attached instance 1 to port ${other.port}`);
    expect(close).toHaveBeenCalled();
    expect(h.ctx.registry.childPid(1)).toBeUndefined();
    expect((await h.call("relaunch_instance")).isError).toBe(true);
    expect(spawns).toHaveLength(1);
  });

  it("refuses when the engine can't be launched, without touching the running one", async () => {
    const { h } = await rig();
    await h.call("launch_instance");
    h.ctx.io.hasBridge = () => false;
    const result = await h.call("relaunch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/has no MCP bridge/);
    expect(bridge!.received.some((m) => m.text === "quit")).toBe(false);
  });

  it("quits a live instance and starts it with identical args", async () => {
    const { h, spawns } = await rig();
    await h.call("launch_instance", { map: "MAP01", files: ["/m.pk3"], skill: 4, width: 640, height: 480 });
    expect(await h.text("relaunch_instance")).toBe(
      `relaunched instance 1 on bridge port ${bridge!.port} (old engine stopped)`,
    );
    expect(bridge!.received.some((m) => m.t === "cmd" && m.text === "quit")).toBe(true);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).toEqual(spawns[0]);
    expect(h.ctx.isBound(1)).toBe(true);
  });

  it("reports a force-kill when the old engine's exit can't be confirmed (no child PID)", async () => {
    const { h } = await rig({ spawnPid: undefined });
    await h.call("launch_instance");
    expect(await h.text("relaunch_instance")).toMatch(/\(force-killed\)$/);
  });

  it("relaunches after kill_instance, waiting on the old port and noting the old engine's crash", async () => {
    // The relaunch lands on another bridge and PID, so the note can only come from the old entry.
    const other = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: DEAD_PID + 1 } });
    others.push(other);
    const { h, spawns, sleeps, state } = await rig({
      hello: { v: 1, t: "hello", engine: "fake", pid: DEAD_PID },
      io: {
        existsSync: (p) => p === "/engine/zandronum" || p === `${logOf(bridge!.port)}.crash`,
        readTextSync: () => `signal: 11\npid: ${DEAD_PID}\n`,
      },
    });
    const ports = [bridge!.port, other.port];
    const pids = [DEAD_PID, DEAD_PID + 1];
    h.ctx.io.findFreePort = (start) =>
      Promise.resolve(start === 1 ? ports.shift()! : state.busy-- > 0 ? start + 1 : start);
    h.ctx.io.launchIo.spawn = (_exe, args) => {
      spawns.push(args);
      return { pid: pids.shift(), kill: () => {} };
    };
    await h.call("launch_instance");
    await h.call("kill_instance");
    state.busy = 2;
    expect((await h.text("relaunch_instance")).split("\n")).toEqual([
      `relaunched instance 1 on bridge port ${other.port} (was not running)`,
      `The bridge port changed from ${bridge!.port}, so the engine log is now ${logOf(other.port)}.`,
      `previous engine (PID ${DEAD_PID}) crashed; its backtrace is at ${logOf(bridge!.port)}.crash`,
    ]);
    expect(sleeps.filter((ms) => ms === 200)).toHaveLength(2);
    expect(spawns).toHaveLength(2);
    expect(h.ctx.enginePidFor(1)).toBe(DEAD_PID + 1);
  });

  it("adds no crash note when the old engine's PID was never reported", async () => {
    const { h } = await rig({
      io: {
        existsSync: (p) => p === "/engine/zandronum" || p.endsWith(".crash"),
        readTextSync: () => "signal: 11\n",
      },
    });
    await h.call("launch_instance");
    expect(await h.text("relaunch_instance")).toBe(
      `relaunched instance 1 on bridge port ${bridge!.port} (old engine stopped)`,
    );
  });

  it("keeps the launch options when an attach_instance fails", async () => {
    const { h, spawns } = await rig();
    await h.call("launch_instance", { map: "MAP05" });
    await h.call("kill_instance");
    expect((await h.call("attach_instance", { port: 1 })).isError).toBe(true);
    expect(await h.text("relaunch_instance")).toMatch(/\(was not running\)$/);
    expect(spawns[1]).toEqual(spawns[0]);
  });

  it("launch_instance falls back to the bridge's PID when the spawn reported none", async () => {
    const { h } = await rig({ spawnPid: undefined, hello: { v: 1, t: "hello", engine: "fake", pid: 4242 } });
    await h.call("launch_instance");
    expect(h.ctx.enginePidFor(1)).toBe(4242);
  });

  it("attach_instance refuses an instance whose launched engine still runs, changing nothing", async () => {
    const { h } = await rig();
    await h.call("launch_instance", { map: "MAP05" });
    const client = h.ctx.registry.get(1);
    const result = await h.call("attach_instance", { port: 1 });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe(
      `Instance 1 runs an engine this session launched (PID ${DEAD_PID}); kill_instance it first, or attach another instance number.`,
    );
    expect(h.ctx.registry.get(1)).toBe(client);
    expect(h.ctx.logPathFor(1)).toBe(logOf(bridge!.port));
    expect(h.ctx.launchArgsFor(1)?.args.map).toBe("MAP05");
  });

  describe("after a launch whose bridge never opened", () => {
    const report = `signal: 11\npid: ${DEAD_PID}\n`;
    const failedLaunch = async (hello?: Record<string, unknown>) => {
      const { h } = await rig({
        failFirst: true,
        hello,
        io: {
          existsSync: (p) => p === "/engine/zandronum" || p === `${logOf(bridge!.port)}.crash`,
          readTextSync: () => report,
          mtimeOf: () => new Date("2026-09-22T06:10:00Z"),
          alive: () => false,
        },
      });
      expect((await h.call("launch_instance")).isError).toBe(true);
      return h;
    };

    it("get_crash, process_stats and relaunch_instance know the spawned child's PID", async () => {
      const h = await failedLaunch();
      expect(await h.text("get_crash")).toBe(report);
      expect((await h.call("process_stats")).content?.[0]?.text).toBe(
        `Instance 1's engine (PID ${DEAD_PID}) is not running.`,
      );
      expect((await h.text("relaunch_instance")).split("\n")).toContain(
        `previous engine (PID ${DEAD_PID}) crashed; its backtrace is at ${logOf(bridge!.port)}.crash`,
      );
    });

    it("a live tool call checks the bridge's identity against the child", async () => {
      const h = await failedLaunch({ v: 1, t: "hello", engine: "fake", pid: DEAD_PID + 1 });
      const result = await h.call("run_command", { text: "version" });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toMatch(
        new RegExp(`is PID ${DEAD_PID + 1}, not the engine launched for instance 1 \\(PID ${DEAD_PID}\\)`),
      );
    });
  });

  it.each([
    ["another engine's report", true, "pid: 123\n"],
    ["a report with no pid line", true, "signal: 11\n"],
    ["no report at all", false, ""],
  ])("adds no crash note for %s", async (_what, exists, report) => {
    const { h } = await rig({
      hello: { v: 1, t: "hello", engine: "fake", pid: DEAD_PID },
      io: {
        existsSync: (p) => p === "/engine/zandronum" || (exists && p.endsWith(".crash")),
        readTextSync: () => report,
      },
    });
    await h.call("launch_instance");
    expect(await h.text("relaunch_instance")).toBe(
      `relaunched instance 1 on bridge port ${bridge!.port} (old engine stopped)`,
    );
  });

  it("relaunches after reset", async () => {
    const { h, spawns } = await rig();
    await h.call("launch_instance", { map: "MAP03" });
    await h.call("reset");
    expect(await h.text("relaunch_instance")).toMatch(/\(was not running\)$/);
    expect(spawns[1]).toEqual(spawns[0]);
  });

  it("relaunches a launch that never came up, waiting for its port first", async () => {
    const { h, spawns, sleeps, state } = await rig({ failFirst: true });
    expect((await h.call("launch_instance", { files: ["/broken.pk3"] })).isError).toBe(true);
    state.busy = 2;
    expect(await h.text("relaunch_instance")).toBe(
      `relaunched instance 1 on bridge port ${bridge!.port} (was not running)`,
    );
    expect(sleeps.filter((ms) => ms === 200)).toHaveLength(2);
    expect(spawns[1]).toEqual(spawns[0]);
  });

  it("reports a relaunch that failed to come up", async () => {
    const { h } = await rig();
    await h.call("launch_instance");
    h.ctx.io.launchIo.waitForPort = () => Promise.reject(new Error("timeout"));
    const result = await h.call("relaunch_instance");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Instance 1 failed to come up: timeout\./);
  });

  it("gives up waiting on a port that stays busy and says the port changed", async () => {
    const other = await FakeBridge.start();
    others.push(other);
    const { h, sleeps, state } = await rig();
    // First launch on `bridge`, the relaunch on `other`.
    const ports = [bridge!.port, other.port];
    h.ctx.io.findFreePort = (start) =>
      Promise.resolve(start === 1 ? ports.shift()! : state.busy-- > 0 ? start + 1 : start);
    await h.call("launch_instance");
    state.busy = 100;
    expect((await h.text("relaunch_instance")).split("\n")).toEqual([
      `relaunched instance 1 on bridge port ${other.port} (old engine stopped)`,
      `The bridge port changed from ${bridge!.port}, so the engine log is now ${logOf(other.port)}.`,
    ]);
    expect(sleeps.filter((ms) => ms === 200)).toHaveLength(10);
    expect(h.ctx.logPathFor(1)).toBe(logOf(other.port));
  });

  it("appends the engine-state note from the new engine, not the old one", async () => {
    const caps = { v: 1, t: "hello", engine: "fake", caps: ["cmd", "event", "time", "status"] };
    const other = await FakeBridge.start({ hello: caps });
    others.push(other);
    other.setStatus({ paused: "1" });
    const { h } = await rig({ hello: caps });
    const ports = [bridge!.port, other.port];
    h.ctx.io.findFreePort = (start) => Promise.resolve(start === 1 ? ports.shift()! : start);
    const first = await h.call("launch_instance");
    expect(first.content).toHaveLength(1);
    const result = await h.call("relaunch_instance");
    const content = result.content ?? [];
    expect(content[content.length - 1]).toEqual({ type: "text", text: "Engine state: paused." });
    expect(h.ctx.attachedClient(1)?.lastStatus?.paused).toBe("1");
  });

  it("prints the note for the new engine's client even when the old one printed the same text", async () => {
    const caps = { v: 1, t: "hello", engine: "fake", caps: ["cmd", "event", "time", "status"] };
    const other = await FakeBridge.start({ hello: caps });
    others.push(other);
    other.setStatus({ paused: "1" });
    const { h } = await rig({ hello: caps });
    bridge!.setStatus({ paused: "1" });
    const ports = [bridge!.port, other.port];
    h.ctx.io.findFreePort = (start) => Promise.resolve(start === 1 ? ports.shift()! : start);
    expect(await h.tail("launch_instance")).toBe("Engine state: paused.");
    expect(await h.tail("relaunch_instance")).toBe("Engine state: paused.");
  });

  it("applies overrides per field and keeps the merged args for the next relaunch", async () => {
    const { h, spawns } = await rig();
    await h.call("launch_instance", { map: "MAP01", files: ["/a.pk3"], extraArgs: ["-nomonsters"], skill: 2 });
    await h.call("relaunch_instance", { map: "MAP02", files: ["/b.pk3", "/c.pk3"] });
    const second = spawns[1].join(" ");
    expect(second).toMatch(/\+map MAP02/);
    expect(second).toMatch(/-file \/b\.pk3 \/c\.pk3/);
    expect(second).not.toMatch(/a\.pk3/);
    expect(second).toMatch(/-nomonsters/);
    expect(second).toMatch(/-skill 2/);

    await h.call("relaunch_instance", { files: [], extraArgs: [] });
    const third = spawns[2].join(" ");
    expect(third).not.toMatch(/-file|-nomonsters/);
    expect(third).toMatch(/\+map MAP02/);

    await h.call("relaunch_instance");
    expect(spawns[3]).toEqual(spawns[2]);
  });

  describe("config: isolated", () => {
    // The rig's engine is /engine/zandronum.
    const SHARED_INI = configPathFor(engine, "/engine/zandronum");

    async function isolatedRig() {
      const r = await rig();
      const seeds: string[][] = [];
      r.h.ctx.io.launchIo.seedConfig = (from, to) => void seeds.push([from, to]);
      return { ...r, seeds };
    }

    it("launches on a fresh per-port copy of the shared ini and names it", async () => {
      const { h, spawns, seeds } = await isolatedRig();
      const own = isolatedConfigPathFor(engine, SHARED_INI, bridge!.port);
      expect(await h.text("launch_instance", { config: "isolated" })).toBe(
        `launched instance 1 on bridge port ${bridge!.port}, config ${own}`,
      );
      expect(seeds).toEqual([[SHARED_INI, own]]);
      expect(spawns[0].slice(0, 2)).toEqual(["-config", own]);
    });

    it("refuses an extraArgs -config alongside it, before spawning anything", async () => {
      const { h, spawns, seeds } = await isolatedRig();
      const result = await h.call("launch_instance", { config: "isolated", extraArgs: ["-Config", "/t/mine.ini"] });
      expect(result.isError).toBe(true);
      expect(result.content?.[0]?.text).toBe(
        `config: "isolated" and a -config in extraArgs both pick the config file; drop one of them.`,
      );
      expect(spawns).toHaveLength(0);
      expect(seeds).toHaveLength(0);
      expect(h.ctx.launchArgsFor(1)).toBeUndefined();
    });

    it("refuses a relaunch override that creates the conflict, leaving the old engine running", async () => {
      const { h, spawns } = await isolatedRig();
      await h.call("launch_instance", { extraArgs: ["-config", "/t/mine.ini"] });
      expect((await h.call("relaunch_instance", { config: "isolated" })).isError).toBe(true);
      expect(bridge!.received.some((m) => m.text === "quit")).toBe(false);
      expect(spawns).toHaveLength(1);
    });

    it("re-seeds on relaunch, and config: shared overrides the stored mode", async () => {
      const { h, spawns, seeds } = await isolatedRig();
      const own = isolatedConfigPathFor(engine, SHARED_INI, bridge!.port);
      await h.call("launch_instance", { config: "isolated" });
      expect(await h.text("relaunch_instance")).toBe(
        `relaunched instance 1 on bridge port ${bridge!.port}, config ${own} (old engine stopped)`,
      );
      expect(spawns[1]).toEqual(spawns[0]);
      expect(seeds).toHaveLength(2);

      expect(await h.text("relaunch_instance", { config: "shared" })).toBe(
        `relaunched instance 1 on bridge port ${bridge!.port} (old engine stopped)`,
      );
      expect(spawns[2].slice(0, 2)).toEqual(["-config", SHARED_INI]);
      expect(seeds).toHaveLength(2);
    });
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
    const result = await h.call("get_startup_errors");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(
      sepRe(/^No engine log for instance 1 \(looked for \/engine\/mcp-bridge-\d+\.log\)\. Launch it via launch_instance, which enables logging, then re-run this if it failed to start\.$/),
    );
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
      { existsSync: (p: string) => !p.endsWith(".stderr"), readTextSync: () => "all quiet\n" },
    );
    expect(await h.text("get_startup_errors")).toMatch(/^No compile\/fatal errors detected\. Last lines of the engine log[\s\S]*all quiet/);
  });

  describe("get_startup_errors with captured stderr", () => {
    const files: Record<string, string> = {
      ".log": "ok\nScript error, bad syntax\n",
      ".stderr": "Cannot find uzdoom.pk3\n",
    };
    const startupErrors = async (present: string[], log = files[".log"]) =>
      (
        await offline(
          { exe: "/engine/zandronum" },
          {
            existsSync: (p: string) => present.includes(path.extname(p)),
            readTextSync: (p: string) => ({ ...files, ".log": log })[path.extname(p)],
          },
        )
      ).text("get_startup_errors");

    it("doesn't call the run error-free when stderr holds the fatal and the log has no error lines", async () => {
      const text = await startupErrors([".log", ".stderr"], "all quiet\n");
      expect(text).toMatch(/^Engine stderr:\nCannot find uzdoom\.pk3\n\nThe engine log has no compile\/fatal error lines\./);
      expect(text).not.toMatch(/No compile\/fatal errors detected/);
    });

    it("reports stderr alone when the engine died before opening its log", async () => {
      expect(await startupErrors([".stderr"])).toMatch(
        sepRe(/^Engine stderr:\nCannot find uzdoom\.pk3\n\nNo engine log at \/engine\/mcp-bridge-\d+\.log \(the engine died before opening one, or hasn't opened it yet\)\.$/),
      );
    });

    it("reports the log alone when there is no stderr file", async () => {
      expect(await startupErrors([".log"])).toBe("Detected 1 error line(s) in the engine log:\n\nScript error, bad syntax");
    });

    it("puts stderr before the log's errors when both exist", async () => {
      expect(await startupErrors([".log", ".stderr"])).toBe(
        "Engine stderr:\nCannot find uzdoom.pk3\n\nDetected 1 error line(s) in the engine log:\n\nScript error, bad syntax",
      );
    });
  });

  it("read_log reports when there is no engine log", async () => {
    const result = await (await offline()).call("read_log");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No engine log for instance 1/);
  });

  it("read_log names the log it looked for when it isn't there", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    const result = await h.call("read_log");
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(sepRe(/^No engine log for instance 1 \(looked for \/engine\/mcp-bridge-\d+\.log\)\. Launch/));
  });

  /** An offline harness whose instance-1 log reads `log`, plus that log's path. */
  async function withLog(log: string) {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => true, readTextSync: () => log });
    return { h, logPath: (await h.call("read_log", { count: true })).structuredContent?.path as string };
  }

  it("read_log returns numbered lines without sentinels, with a resume point and the log path", async () => {
    const { h, logPath } = await withLog("a\n__MCPDONE_1__\nGod ON\nb\n");
    expect(logPath).toMatch(sepRe(/^\/engine\/mcp-bridge-\d+\.log$/));
    const all = await h.call("read_log", { maxLines: 2 });
    expect(all.content?.[0]?.text).toBe(
      `2 line(s), nextLine=4, 1 more matching line(s) not shown, log=${logPath}\n3: God ON\n4: b`,
    );
    expect(all.structuredContent).toMatchObject({ path: logPath, nextLine: 4, omitted: 1 });
    expect(await h.text("read_log", { pattern: "god", sinceLine: 1 })).toBe(`1 line(s), nextLine=4, log=${logPath}\n3: God ON`);
  });

  it("read_log drops what exclude matches", async () => {
    const { h, logPath } = await withLog("a\nnoise 1\nGod ON\nNOISE 2\nb\n");
    expect(await h.text("read_log", { exclude: "noise" })).toBe(`3 line(s), nextLine=5, log=${logPath}\n1: a\n3: God ON\n5: b`);
  });

  it("read_log counts every match past maxLines, and only the new ones with sinceLine", async () => {
    const { h, logPath } = await withLog("x1\n__MCPDONE_1__\nx2\ny\nx3\nx4\n");
    const all = await h.call("read_log", { pattern: "x", count: true, maxLines: 1 });
    expect(all.content).toEqual([{ type: "text", text: `4 matching line(s), nextLine=6, log=${logPath}` }]);
    expect(all.structuredContent).toEqual({ path: logPath, count: 4, nextLine: 6 });
    const since = await h.call("read_log", { pattern: "x", exclude: "4", sinceLine: 2, count: true, maxLines: 1 });
    expect(since.structuredContent).toEqual({ path: logPath, count: 2, nextLine: 6 });
  });

  describe("read_marks", () => {
    const LOG = [
      "God ON",
      "MCP_MARK n=1 tic=10 maptime=8 map=MAP01 x=1.0 y=2.0 z=0.0 angle=90.0 shot=mcp_mark_7777_x_1 note=door stuck",
      "__MCPDONE_1__",
      "MCP_MARK n=2 tic=20 maptime=18 map=MAP01 shot=none note=",
      "",
    ].join("\n");
    const files: Record<string, string> = { "/engine/mcp-bridge-7777.log": LOG };
    const io = (extra: Record<string, string> = {}): Partial<ContextIo> => {
      const all = new PathMap(Object.entries({ ...files, ...extra }));
      return {
        existsSync: (p) => all.has(p),
        readTextSync: (p) => all.get(p)!,
        readFileSync: (p) => Buffer.from(all.get(p)!),
      };
    };
    const LOG_PATH = norm("/engine/mcp-bridge-7777.log");
    const config = { exe: "/engine/zandronum", basePort: 7777, screenshotDir: "/engine", gamelog: "/engine/gamelogs/zagamelog" };

    it("lists the marks in the instance's console log", async () => {
      const h = await offline(config, io());
      const r = await h.call("read_marks");
      expect(r.content?.[0]?.text).toBe(
        `2 mark(s) in ${LOG_PATH}\n` +
          "#1 MAP01 tic=10 maptime=8 at 1,2,0 angle=90 shot=mcp_mark_7777_x_1 (log line 2): door stuck\n" +
          "#2 MAP01 tic=20 maptime=18 no shot (log line 4): ",
      );
      expect((r.structuredContent as { marks: unknown[] }).marks).toHaveLength(2);
      expect(r.structuredContent?.file).toBe(LOG_PATH);
    });

    it("says so when the log has no marks", async () => {
      const h = await offline(config, io({ "/engine/mcp-bridge-7777.log": "God ON\n" }));
      expect(await h.text("read_marks")).toBe(`No marks in ${LOG_PATH}.`);
    });

    it("returns one mark with its screenshot", async () => {
      const h = await offline(config, io({ "/engine/mcp_mark_7777_x_1.png": "PNG" }));
      const r = await h.call("read_marks", { mark: 1 });
      expect(r.content?.[0]?.text).toMatch(/^#1 MAP01 .*: door stuck$/);
      expect(r.content?.[1]).toMatchObject({ type: "image", mimeType: "image/png", data: "UE5H" });
      expect(r.structuredContent).toMatchObject({ mark: { n: 1 }, shotPath: norm("/engine/mcp_mark_7777_x_1.png") });
    });

    it("notes a missing screenshot file or shot=none instead of failing", async () => {
      const h = await offline(config, io());
      const missing = await h.call("read_marks", { mark: 1 });
      expect(missing.isError).toBeFalsy();
      expect(missing.content?.[0]?.text).toMatch(sepRe(/\(screenshot \/engine\/mcp_mark_7777_x_1\.png not found\)$/));
      expect(missing.structuredContent).toMatchObject({ mark: { n: 1 }, notes: [`(screenshot ${norm("/engine/mcp_mark_7777_x_1.png")} not found)`] });
      expect(await h.text("read_marks", { mark: 2 })).toMatch(/\(no screenshot was taken\)$/);
    });

    it("refuses an unknown mark, listing the valid ones", async () => {
      const h = await offline(config, io());
      const r = await h.call("read_marks", { mark: 5 });
      expect(r.isError).toBe(true);
      expect(r.content?.[0]?.text).toBe(`No mark 5 in ${LOG_PATH}; marks: 1, 2.`);
      const none = await (await offline(config, io({ "/engine/mcp-bridge-7777.log": "" }))).call("read_marks", { mark: 1 });
      expect(none.content?.[0]?.text).toMatch(/marks: none\.$/);
    });

    it("takes the latest of a repeated n", async () => {
      const twice = "MCP_MARK n=1 tic=1 maptime=1 map=MAP01 shot=none note=old\nMCP_MARK n=1 tic=2 maptime=2 map=MAP02 shot=none note=new\n";
      const h = await offline(config, io({ "/engine/mcp-bridge-7777.log": twice }));
      expect(await h.text("read_marks", { mark: 1 })).toMatch(/^#1 MAP02 .*: new\n/);
    });

    it("reports a missing console log", async () => {
      const r = await (await offline()).call("read_marks");
      expect(r.isError).toBe(true);
      expect(r.content?.[0]?.text).toMatch(/No engine log for instance 1/);
      const missing = await (await offline(config, { existsSync: () => false })).call("read_marks");
      expect(missing.isError).toBe(true);
      expect(missing.content?.[0]?.text).toMatch(sepRe(/^No engine log for instance 1 \(looked for \/engine\/mcp-bridge-\d+\.log\)\. Launch/));
    });

    it("reads a gamelog by absolute path or by name in the gamelog dir", async () => {
      const old = "[12:00:00] MCP_MARK n=1 tic=1 maptime=1 map=MAP07 shot=none note=old session\n";
      const h = await offline(config, io({ "/logs/zagamelog__1.log": old, "/engine/gamelogs/zagamelog__2.log": old }));
      expect(await h.text("read_marks", { gamelog: "/logs/zagamelog__1.log" })).toMatch(/#1 MAP07 .*time=12:00:00 .*: old session$/);
      expect(await h.text("read_marks", { gamelog: "zagamelog__2.log" })).toMatch(sepRe(/^1 mark\(s\) in \/engine\/gamelogs\/zagamelog__2\.log/));
      const missing = await h.call("read_marks", { gamelog: "nope.log" });
      expect(missing.isError).toBe(true);
      expect(missing.content?.[0]?.text).toBe(`No gamelog at ${norm("/engine/gamelogs/nope.log")}.`);
    });

    it("resolves a bare gamelog name in the BRIDGE_GAMELOG override's dir, not the engine default", async () => {
      const old = "MCP_MARK n=1 tic=1 maptime=1 map=MAP07 shot=none note=x\n";
      const h = await offline({ ...config, gamelog: "/custom/logs/run" }, io({ "/custom/logs/run__3.log": old }));
      expect(await h.text("read_marks", { gamelog: "run__3.log" })).toMatch(sepRe(/^1 mark\(s\) in \/custom\/logs\/run__3\.log/));
    });

    it("names the unset EXE variable when a bare gamelog name has no dir", async () => {
      const bare = await offline({}, io());
      expect(await bare.text("read_marks", { gamelog: "zagamelog.log" })).toBe(
        `gamelog wants an absolute path (no gamelog dir: ${envName(engine, "EXE")} is unset): zagamelog.log`,
      );
    });
  });

  it("read_log surfaces an invalid pattern or exclude as a tool error", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => true, readTextSync: () => "a\n" });
    for (const args of [{ pattern: "(" }, { exclude: "[" }]) {
      const res = await h.call("read_log", args);
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toMatch(/not a valid regex/);
    }
  });

  it("reports no crash when there is no crash file", async () => {
    const h = await offline({ exe: "/engine/zandronum" }, { existsSync: () => false });
    expect(await h.text("get_crash")).toMatch(/No crash recorded for instance 1/);
  });

  it("appends the engine's stderr tail when there is no crash report (an in-game fatal)", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      { existsSync: (p: string) => p.endsWith(".stderr"), readTextSync: () => "noise\nExecution could not continue.\n" },
    );
    expect(await h.text("get_crash")).toMatch(
      /^No crash recorded for instance 1\. .*\n\nEngine stderr:\nnoise\nExecution could not continue\.$/,
    );
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
      {
        existsSync: (p: string) => !p.endsWith(".stderr"),
        readTextSync: () => crashReport(pid),
        mtimeOf: mtimeOnly(crashFile),
      },
    );

  it("marks a report unverified when this instance's engine PID is unknown", async () => {
    const h = await crashed(4242);
    expect(await h.text("get_crash")).toMatch(/^Unverified: this instance's engine PID is unknown, .*\n\n=== MCP/);
  });

  it("returns the report verbatim when its pid matches this instance's engine", async () => {
    const h = await crashed(4242);
    h.ctx.rememberEngine(1, 4242);
    expect(await h.text("get_crash")).toBe(crashReport(4242));
  });

  it("names another engine's report instead of returning it, with the stderr tail", async () => {
    const h = await offline(
      { exe: "/engine/zandronum" },
      {
        existsSync: () => true,
        readTextSync: (p: string) => (p.endsWith(".stderr") ? "fatal\n" : crashReport(99)),
        mtimeOf: mtimeOnly(crashFile),
      },
    );
    h.ctx.rememberEngine(1, 4242);
    expect(await h.text("get_crash")).toBe(
      `No crash recorded for instance 1 (PID 4242). ${crashFile} holds ` +
        "another engine's crash (PID 99, written 2026-09-22T06:10:00.000Z), not this one's.\n\nEngine stderr:\nfatal",
    );
  });

  it("stops matching the previous engine's PID once a relaunch fails", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 4242 } });
    let bridgeOpens = true;
    // The relaunch's spawn reports no PID (a failed spawn), so only the launch's PID drop clears 4242.
    const pids = [4242, undefined];
    harness = await startHarness({
      config: { exe: "/engine/zandronum", basePort: bridge.port },
      io: {
        existsSync: (p: string) => !p.endsWith(".stderr"),
        hasBridge: () => true,
        findFreePort: (start) => Promise.resolve(start),
        readTextSync: () => crashReport(4242),
        mtimeOf: mtimeOnly(path.join("/engine", `mcp-bridge-${bridge.port}.log.crash`)),
        launchIo: {
          spawn: () => ({ pid: pids.shift(), kill: () => {} }),
          waitForPort: () => (bridgeOpens ? Promise.resolve() : Promise.reject(new Error("timeout"))),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
    });
    await harness.call("launch_instance");
    expect(await harness.text("get_crash")).toBe(crashReport(4242));

    bridgeOpens = false;
    expect((await harness.call("launch_instance")).isError).toBe(true);
    expect(await harness.text("get_crash")).toMatch(/^Unverified: this instance's engine PID is unknown/);
  });

  describe("process_stats", () => {
    const status = (name: string | null, fields = ["VmSize:\t 1234567 kB", "VmHWM:\t  900000 kB", "VmRSS:\t  812345 kB"]) =>
      [...(name === null ? [] : [`Name:\t${name}`]), "State:\tS (sleeping)", "Pid:\t4242", ...fields, "Threads:\t9"].join("\n") + "\n";
    const stats = async (text: string, config: Partial<ServerConfig> = { exe: "/engine/zandronum" }) => {
      const read: string[] = [];
      const h = await offline(config, { readTextSync: (p: string) => (read.push(p), text) });
      h.ctx.rememberEngine(1, 4242);
      return { res: await h.call("process_stats"), read };
    };

    it("reports the engine's memory in KiB from its /proc status file", async () => {
      const { res, read } = await stats(status("zandronum"));
      expect(read).toEqual(["/proc/4242/status"]);
      expect(res.isError).toBeUndefined();
      expect(res.content?.[0]?.text).toBe("PID 4242 (zandronum): VmRSS 812345 KiB, VmHWM 900000 KiB, VmSize 1234567 KiB");
      expect(res.structuredContent).toEqual({ pid: 4242, name: "zandronum", vmRssKib: 812345, vmHwmKib: 900000, vmSizeKib: 1234567 });
    });

    it("fails when the process name isn't the engine executable's, so another process's memory never passes as the engine's", async () => {
      const other = await stats(status("node"));
      expect(other.res.isError).toBe(true);
      expect(other.res.content?.[0]?.text).toBe(
        "PID 4242 is node, not zandronum: not this instance's engine (a server outside the engine's PID namespace?).",
      );
      expect((await stats(status(null))).res.content?.[0]?.text).toMatch(/^PID 4242 is unnamed, not zandronum:/);
      // With no exe configured there is nothing to compare against.
      const bare = await stats(status(null), {});
      expect(bare.res.isError).toBeUndefined();
      expect(bare.res.content?.[0]?.text).toMatch(/^PID 4242 \(\?\): VmRSS 812345 KiB/);
    });

    it("fails, rather than reporting zeros, when a memory field is missing", async () => {
      const { res } = await stats(status("zandronum", ["VmSize:\t 1 kB"]));
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("/proc/4242/status has no VmRSS/VmHWM line (a zombie or kernel thread has none).");
    });

    it("fails when the status file can't be read", async () => {
      for (const [thrown, why] of [[new Error("ENOENT: no such file"), "ENOENT: no such file"], ["EACCES", "EACCES"]] as const) {
        const h = await offline({}, { readTextSync: () => { throw thrown; } });
        h.ctx.rememberEngine(1, 4242);
        const res = await h.call("process_stats");
        expect(res.isError).toBe(true);
        expect(res.content?.[0]?.text).toBe(`Can't read /proc/4242/status: ${why}`);
      }
    });

    it("fails on an instance with no known engine PID, or a dead engine, without reading /proc", async () => {
      const unknown = await offline();
      expect(await unknown.text("process_stats")).toBe(
        "No engine PID known for instance 1: launch it with launch_instance or attach with attach_instance.",
      );
      const dead = await offline({}, { alive: (pid: number) => pid !== 4242 });
      dead.ctx.rememberEngine(1, 4242);
      const res = await dead.call("process_stats");
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("Instance 1's engine (PID 4242) is not running.");
    });
  });
});

describe("progress reporting on slow tools", () => {
  it("reports progress while sampling a profiling window", async () => {
    const h = await live({ responses: { acsprofile: ["MOD name 1 2 3 4 5"] } });
    const { result, progress } = await h.callWithProgress("profile_window", { seconds: 30 });
    expect(result.content?.[0]?.text).toBe("1 of 1 profiled over 30s (top 10 per section by total)");
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
          ensureDir: () => {},
          seedConfig: () => {},
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
    expect(result.content?.[0]?.text).toBe("1 of 1 profiled over 1s (top 10 per section by total)");
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

  it("a re-attach drops the earlier engine's client and PID", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 999 } });
    const second = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 1000 } });
    try {
      harness = await startHarness({
        config: { exe: "/engine/zandronum", basePort: bridge.port },
        io: {
          existsSync: (p: string) => p.endsWith(".crash"),
          readTextSync: () => "signal: 11\npid: 999\n",
          mtimeOf: () => new Date("2026-09-22T06:10:00Z"),
        },
      });
      await harness.call("attach_instance");
      const close = vi.spyOn(harness.ctx.registry.get(1), "close");
      expect(await harness.text("get_crash")).toBe("signal: 11\npid: 999\n");
      expect(await harness.text("attach_instance", { port: second.port })).toBe(
        `attached instance 1 to port ${second.port} (engine PID 1000)`,
      );
      expect(close).toHaveBeenCalled();
      expect(harness.ctx.enginePidFor(1)).toBe(1000);
      expect(await harness.text("get_crash")).toMatch(/^No crash recorded for instance 1 \(PID 1000\)\..*another engine's crash \(PID 999,/);
    } finally {
      // The harness still holds a socket to `second`, which its close would wait on.
      await harness?.close();
      harness = undefined;
      await second.close();
    }
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

  it("appends the note after content and mirrors it into structuredContent as engineState", async () => {
    const h = await liveStatus({ responses: { getacsvar: ["acsvar world 5 = 42"] } });
    const result = await h.call("get_acs_var", { scope: "world", index: 5 });
    expect(result.structuredContent).toEqual({ scope: "world", index: 5, value: 42, engineState: "Engine state: paused." });
    expect(result.content?.at(-1)).toEqual({ type: "text", text: "Engine state: paused." });
  });

  it("adds no engineState key to a reply that prints no note", async () => {
    const h = await liveStatus({ responses: { getacsvar: ["acsvar world 5 = 42"] } });
    const read = () => h.call("get_acs_var", { scope: "world", index: 5 });
    await read();
    expect((await read()).structuredContent).toEqual({ scope: "world", index: 5, value: 42 });
    bridge!.setStatus({ paused: "0" });
    expect((await read()).structuredContent?.engineState).toBe("Engine state: back to normal.");
    expect((await read()).structuredContent).toEqual({ scope: "world", index: 5, value: 42 });
  });

  it("allows engineState in a tool's outputSchema, so a validating client accepts the reply", async () => {
    const h = await liveStatus({
      responses: { dumpactors: ["DoomImp\t3001\t5\tDoom\tzandronum.pk3:actors/imp.txt"] },
    });
    // Listing the tools is what makes the SDK client check structuredContent against the schema.
    const { tools } = await h.client.listTools();
    const schema = tools.find((t) => t.name === "list_actor_classes")?.outputSchema;
    expect(Object.keys(schema?.properties ?? {})).toEqual(["actors", "engineState", "error"]);
    expect(schema?.required).toEqual(["actors"]);
    const result = await h.call("list_actor_classes");
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      actors: [{ name: "DoomImp", edNum: 3001, spawnId: 5, filter: "Doom", source: "zandronum.pk3:actors/imp.txt" }],
      engineState: "Engine state: paused.",
    });
    expect((await h.call("list_actor_classes")).structuredContent).not.toHaveProperty("engineState");
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

  /** A command tool's reply: one block of its own, plus the note when one is printed. */
  const version = (h: Harness) => h.call("run_command", { text: "version" });
  const acstemp = (n: number) =>
    `Engine state: paused, ${n} run_acs snippet module(s) loaded (saves refused until the map changes).`;

  it("says nothing on a second call whose note is unchanged", async () => {
    const h = await liveStatus();
    expect((await version(h)).content).toHaveLength(2);
    expect((await version(h)).content).toHaveLength(1);
  });

  it("prints the whole note again whenever it changes", async () => {
    const h = await liveStatus();
    await version(h);
    bridge!.setStatus({ acstemp: "1" });
    expect((await version(h)).content?.at(-1)?.text).toBe(acstemp(1));
    bridge!.setStatus({ acstemp: "2" });
    expect((await version(h)).content?.at(-1)?.text).toBe(acstemp(2));
  });

  it("says back to normal once when the note clears, then nothing", async () => {
    const h = await liveStatus();
    await version(h);
    bridge!.setStatus({ paused: "0" });
    expect((await version(h)).content?.at(-1)?.text).toBe("Engine state: back to normal.");
    expect((await version(h)).content).toHaveLength(1);
  });

  it("keeps an unchanged note on an isError result", async () => {
    const h = await liveStatus();
    await version(h);
    const result = await h.call("get_acs_var", { scope: "world", index: 0 });
    expect(result.isError).toBe(true);
    expect(result.content?.at(-1)?.text).toBe("Engine state: paused.");
    expect((await version(h)).content).toHaveLength(1);
  });

  it("reads an unanswered probe as unknown, not as back to normal", async () => {
    const h = await liveStatus();
    await version(h);
    bridge!.swallowProbes(1);
    expect((await h.call("screenshot")).content).toEqual([{ type: "image", data: "UE5H", mimeType: "image/png" }]);
    expect((await version(h)).content).toHaveLength(1);
  });
});

describe("run_acs", () => {
  const cmds = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
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
    expect(c.requests).toEqual([{ compiler: "bcc", exe: undefined, source: "script 1 (void) {}", includeDirs: undefined, engine }]);
    expect(c.removed).toEqual(["/tmp/mcp-runacs-1"]);
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o 1 5 -2 ;/);
    const text = res.content?.[0]?.text ?? "";
    expect(text).toMatch(/^loaded snippet as module 2 \(3 script\(s\)\), started 1\nrunacs ok\nsave_game refuses/);
    expect(text).not.toMatch(/DEATH/);
    expect(res.structuredContent).toEqual({
      module: 2,
      scripts: 3,
      started: "1",
      deferred: false,
      output: ["runacs ok"],
      notes: [text.split("\n").at(-1)],
    });
    expect(text.split("\n").at(-1)).toMatch(/^save_game refuses/);
  });

  it("uses the configured acc, include dirs, a named script and open, and warns about deferred scripts", async () => {
    const c = compiler();
    const h = await live({
      caps: ["cmd", "event", "time", "runacsname"],
      responses: { mcp_runacs: ["MCP_RUNACS module=0 scripts=2 started=named deferred=1"] },
      io: c.io,
      config: { acc: "/opt/acc", bcc: "/opt/bcc" },
    });
    const res = await h.call("run_acs", { source: "x", script: "named", compiler: "acc", includeDirs: ["/mod/scripts"], open: true });
    expect(c.requests[0]).toMatchObject({ compiler: "acc", exe: "/opt/acc", includeDirs: [abs("/mod/scripts")] });
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o named name=1 open=1 ;/);
    expect(res.content?.[0]?.text).toMatch(/DEATH\/ENTER\/RESPAWN/);
    const notes = res.structuredContent?.notes as string[];
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^The snippet has DEATH\/ENTER\/RESPAWN/);
    expect(res.content?.[0]?.text).toContain(notes.join("\n"));
    await h.call("run_acs", { source: "x", open: false });
    expect(cmds()[1]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o ;/);
    await h.call("run_acs", { source: "x" });
    expect(c.requests[2]).toMatchObject({ exe: "/opt/bcc" });
  });

  it("marks a script name made of digits name=1, after its args, so it is not run as a number", async () => {
    const c = compiler();
    const h = await live({ caps: ["cmd", "event", "time", "runacsname"], responses: { mcp_runacs: [REPLY] }, io: c.io });
    await h.call("run_acs", { source: "x", script: "123", args: [4] });
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o 123 4 name=1 ;/);
    await h.call("run_acs", { source: "x", script: 123, args: [4] });
    expect(cmds()[1]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o 123 4 ;/);
  });

  it("takes name as an alias for a named script, refuses both, and runs nothing with neither", async () => {
    const c = compiler();
    const h = await live({ caps: ["cmd", "event", "time", "runacsname"], responses: { mcp_runacs: [REPLY] }, io: c.io });
    await h.call("run_acs", { source: "x", name: "4242", args: [4] });
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o 4242 4 name=1 ;/);
    expect(await h.text("run_acs", { source: "x", script: 1, name: "Probe" })).toBe("pass script or name, not both");
    expect(c.requests).toHaveLength(1);
    await h.call("run_acs", { source: "x" });
    expect(cmds()[1]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o ;/);
    expect((await h.call("run_acs", { source: "x", name: "has space" })).isError).toBe(true);
  });

  it("on a bridge without the runacsname cap, sends a name bare and refuses one made of digits", async () => {
    const c = compiler();
    const h = await live({ responses: { mcp_runacs: [REPLY] }, io: c.io });
    await h.call("run_acs", { source: "x", script: "Probe", args: [4] });
    expect(cmds()[0]).toMatch(/^mcp_runacs \/tmp\/mcp-runacs-1\/snippet\.o Probe 4 ;/);
    const res = await h.call("run_acs", { source: "x", script: "123" });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toMatch(/^This engine build would run a script name made of digits as a script number/);
    expect(cmds()).toHaveLength(1);
    expect(c.requests).toHaveLength(1);
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

  describe("profiles", () => {
    const PROFILE = path.resolve("/orc/scripts/mcp-run-acs.json");
    const DEFS = path.resolve("/orc/scripts/osdefs.acs");
    const texts: Record<string, string> = {
      [PROFILE]: JSON.stringify({ imports: ["osacs.acs"], includeDirs: [".", "/shared"], rawDefines: true, defineFiles: ["osdefs.acs"] }),
      [DEFS]: "#define HAZARD_MAX 64\n",
    };
    const IMPORTS = '#import "osacs.acs"\nscript 1 (void) {}';
    function profiled(result?: Parameters<typeof compiler>[0]) {
      const c = compiler(result);
      return { ...c, io: { ...c.io, readTextSync: (p: string) => texts[p] } };
    }

    it("applies a profile the snippet imports: per-call dirs first, then the profile's, the prelude, and a profile: line", async () => {
      const c = profiled();
      const h = await live({ responses: { mcp_runacs: ["logged", REPLY] }, io: c.io, config: { runAcsProfiles: [PROFILE] } });
      const res = await h.call("run_acs", { source: IMPORTS, script: 1, includeDirs: ["/mine", "/shared/"] });
      expect(c.requests[0]).toMatchObject({
        includeDirs: [abs("/mine"), abs("/shared"), path.dirname(PROFILE)],
        prelude: { text: "#pragma raw define on\n#define HAZARD_MAX 64\n", origin: [`${PROFILE} (rawDefines)`, `${DEFS}:1`] },
      });
      expect(res.content?.[0]?.text).toMatch(new RegExp(`^loaded snippet as module 2 \\(3 script\\(s\\)\\), started 1\\nprofile: ${PROFILE.replaceAll("\\", "\\\\")}\\nlogged\\n`));
      expect(res.structuredContent).toMatchObject({ profiles: [PROFILE], output: ["logged"] });
    });

    it("applies nothing to a snippet that doesn't import a profile's library", async () => {
      const c = profiled();
      const h = await live({ responses: { mcp_runacs: [REPLY] }, io: c.io, config: { runAcsProfiles: [PROFILE] } });
      const res = await h.call("run_acs", { source: '#import "zcommon.acs"', script: 1 });
      expect(c.requests[0]).toMatchObject({ includeDirs: undefined, prelude: undefined });
      expect(res.content?.[0]?.text).not.toMatch(/profile:/);
      expect(res.structuredContent).not.toHaveProperty("profiles");
    });

    it("names the applied profile under compile errors too", async () => {
      const c = profiled({ ok: false, diagnostics: `${DEFS}:1:9: error: x` });
      const h = await live({ io: c.io, config: { runAcsProfiles: [PROFILE] } });
      expect(await h.text("run_acs", { source: IMPORTS })).toBe(
        `compile failed (bcc), nothing sent to the engine:\n${DEFS}:1:9: error: x\nprofile: ${PROFILE}`,
      );
    });

    it("fails before compiling when a profile or its defineFile can't be read", async () => {
      const c = compiler();
      const missing = path.resolve("/gone.json");
      const h = await live({ io: { ...c.io, readTextSync: () => { throw new Error("ENOENT"); } }, config: { runAcsProfiles: [missing] } });
      expect(await h.text("run_acs", { source: IMPORTS })).toBe(
        `can't read run_acs profile ${missing} (listed in ${envName(engine, "RUNACS_PROFILES")}): ENOENT; nothing sent to the engine`,
      );
      const gone = compiler();
      const onlyProfile = (p: string) => {
        if (p === PROFILE) return texts[p];
        throw new Error("gone");
      };
      const h2 = await live({ io: { ...gone.io, readTextSync: onlyProfile }, config: { runAcsProfiles: [PROFILE] } });
      expect(await h2.text("run_acs", { source: IMPORTS })).toMatch(/^run_acs profile .*: can't read defineFile .*osdefs\.acs \(gone\); nothing sent to the engine$/);
      expect(c.requests).toHaveLength(0);
      expect(gone.requests).toHaveLength(0);
    });
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
        "snippet.o 3": ["\x1cGCould not find ACS library MYLIB.\n", "\x1cGCould not find ACS function f for use in BEHAVIOR.\n", "error bad module (unresolved import or import mismatch)\n"],
      },
      io: c.io,
    });
    const res = await h.call("run_acs", { source: "x", script: 1 });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toBe(
      "Could not find ACS function Foo for use in BEHAVIOR.\nerror bad module (unresolved import or import mismatch)",
    );
    expect(await h.text("run_acs", { source: "x", script: 2 })).toBe("(no output)");
    expect(await h.text("run_acs", { source: "x", script: 3 })).toBe(
      "Could not find ACS library MYLIB.\nCould not find ACS function f for use in BEHAVIOR.\nerror bad module (unresolved import or import mismatch)",
    );
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
    const h = await live({ caps: ["cmd", "event", "time", "status"] });
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
    const h = await live({ caps: ["cmd", "event", "time", "status"] });
    // Every field blank: the status line is a bare sentinel, which parses to no snapshot.
    const keys = ["paused", "menu", "console", "gamestate", "player", "spectating", "demo", "automap"];
    keys.push("health", "armor", "cheats", "maptime");
    bridge!.setStatus(Object.fromEntries(keys.map((k) => [k, undefined])));
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

describe("netgame tools", () => {
  const lanBridges: FakeBridge[] = [];
  afterEach(async () => {
    // Before the file-level afterEach: drop the harness's sockets first, or close() waits on them.
    await harness?.close();
    harness = undefined;
    for (const b of lanBridges.splice(0)) await b.close();
  });

  interface Spec {
    extraArgs?: string[];
    caps?: string[];
  }

  /** One fake bridge per spec, attached as instance 1, 2, ..., each with its launch args stored. */
  async function lan(specs: Spec[], opts: { engine?: EngineAdapter; io?: Partial<ContextIo>; config?: Partial<ServerConfig> } = {}) {
    const bridges: FakeBridge[] = [];
    for (const s of specs) {
      const b = await FakeBridge.start({
        hello: { v: 1, t: "hello", engine: "fake", caps: s.caps ?? ["cmd", "event", "time", "status"] },
      });
      bridges.push(b);
      lanBridges.push(b);
    }
    harness = await startHarness({ config: { basePort: 1, ...opts.config }, io: opts.io, engine: opts.engine ?? LAN_ENGINE });
    for (const [i, b] of bridges.entries()) {
      await harness.call("attach_instance", { instance: i + 1, port: b.port });
      // attach_instance forgets launch args, so store them after it, as a launch would.
      const extraArgs = specs[i].extraArgs;
      if (extraArgs) harness.ctx.rememberLaunchArgs(i + 1, { extraArgs }, b.port, `/engine/mcp-bridge-${b.port}.log`);
      b.clearReceived();
    }
    return { h: harness, bridges };
  }
  const HOST = ["-host", "+sv_maxclients", "8"];
  const client = (name?: string) => ["-connect", "127.0.0.1", ...(name ? ["+name", name] : [])];
  const cmdsOf = (b: FakeBridge) => b.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
  const joinsOf = (b: FakeBridge) => cmdsOf(b).filter((t) => /^join ;/.test(t)).length;

  describe("pause notes", () => {
    it("set_pause adds the role's caveat when pausing a server or a client, and nothing on resume or offline", async () => {
      const { h } = await lan([{ extraArgs: HOST }, { extraArgs: client("a") }, { extraArgs: ["+map", "MAP01"] }]);
      expect(await h.text("set_pause", { instance: 1, paused: true })).toBe(`paused\nnetgame server: ${SERVER_NOTE}`);
      expect(await h.text("set_pause", { instance: 2, paused: true })).toBe(`paused\nnetgame client: ${CLIENT_NOTE}`);
      expect(await h.text("set_pause", { instance: 2, paused: false })).toBe("resumed");
      expect(await h.text("set_pause", { instance: 3, paused: true })).toBe("paused");
    });

    it("step leaves a client running and says why; a server is paused again with its caveat", async () => {
      // An empty engine log: a quiet step, whose structured half still carries the notes.
      const io = { existsSync: () => true, readTextSync: () => "" };
      const { h, bridges } = await lan([{ extraArgs: HOST }, { extraArgs: client("a") }], { io, config: { exe: "/engine/zandronum" } });
      const res = await h.call("step", { instance: 2, tics: 3 });
      expect(res.content?.[0]?.text).toBe(`advanced ~3 tic(s)\nleft running: ${CLIENT_NOTE}`);
      expect(res.structuredContent?.notes).toEqual(["advanced ~3 tic(s)", `left running: ${CLIENT_NOTE}`]);
      expect(bridges[1].pauses).toEqual([0]);
      expect(await h.text("step", { instance: 1, tics: 3 })).toBe(`advanced ~3 tic(s)\nnetgame server: ${SERVER_NOTE}`);
      expect(bridges[0].pauses).toEqual([0, 1]);
    });

    it("step pauses a client again where step acts on the whole net (no stepLeavesClientRunning)", async () => {
      const engine = { ...LAN_ENGINE, netgame: { ...LAN_CAPS, stepLeavesClientRunning: undefined } };
      const { h, bridges } = await lan([{ extraArgs: client("a") }], { engine });
      expect(await h.text("step", { tics: 3 })).toBe(`advanced ~3 tic(s)\nnetgame client: ${CLIENT_NOTE}`);
      expect(bridges[0].pauses).toEqual([0, 1]);
    });

    it("step_until never re-pauses a client between chunks", async () => {
      const { h, bridges } = await lan([{ extraArgs: client("a") }]);
      const b = bridges[0];
      let t = 0;
      b.onCommand("", () => b.setStatus({ maptime: String(++t) }));
      let n = 0;
      const out = ["mapvar hp = 0"];
      b.respondTo("getmapvar", out);
      b.onCommand("getmapvar", () => (out[0] = `mapvar hp = ${++n * 10}`));
      const res = await h.call("step_until", { condition: { kind: "mapvar", name: "hp", op: ">=", value: 30 }, maxTics: 100 });
      expect(res.content?.[0]?.text).toBe(`met after 2 tic(s): 30 >= 30\nleft running: ${CLIENT_NOTE}`);
      expect(res.structuredContent).toEqual({ met: true, tics: 2, value: 30, right: 30, notes: [`left running: ${CLIENT_NOTE}`] });
      expect(b.pauses).toEqual([0, 0]);
    });

    it("an action's stepTics leaves a client running with its note; a server is paused again", async () => {
      const { h, bridges } = await lan([{ extraArgs: HOST }, { extraArgs: client("a") }]);
      const cmd = await h.call("run_command", { instance: 2, text: "echo hi", stepTics: 3 });
      expect(cmd.content?.[0]?.text).toBe(`(no output)\nleft running: ${CLIENT_NOTE}\nran 3 tic(s); no engine log to read`);
      expect(cmd.structuredContent).toEqual({
        output: [],
        notes: [`left running: ${CLIENT_NOTE}`, "ran 3 tic(s); no engine log to read"],
      });
      expect(bridges[1].pauses).toEqual([0]);
      expect(await h.text("run_script", { instance: 2, script: 5, stepTics: 3 })).toBe(
        `ran 5\nleft running: ${CLIENT_NOTE}\nran 3 tic(s); no engine log to read`,
      );
      expect(bridges[1].pauses).toEqual([0, 0]);
      expect(await h.text("run_command", { instance: 1, text: "echo hi", stepTics: 3 })).toBe(
        `(no output)\nnetgame server: ${SERVER_NOTE}\nran 3 tic(s); no engine log to read`,
      );
      expect(bridges[0].pauses).toEqual([0, 1]);
    });

    it("watch_actors never re-pauses a client and adds its note", async () => {
      const { h, bridges } = await lan([{ extraArgs: client("a") }]);
      const b = bridges[0];
      let t = 0;
      b.respondTo("findactors", ["MCP_FOUND"]);
      b.onCommand("findactors", () => b.setStatus({ maptime: String((t += 2)) }));
      const res = await h.call("watch_actors", { class: "DoomImp", tics: 4 });
      expect(res.content?.[0]?.text).toBe(`watched DoomImp for 4 tic(s): 3 samples, 0 rows, done\nno matches seen\nleft running: ${CLIENT_NOTE}`);
      expect(res.structuredContent?.notes).toEqual([`left running: ${CLIENT_NOTE}`]);
      expect(b.pauses).toEqual([0, 0]);
    });

    it("set_pause all applies to every bound instance, one line each, past an unreachable one", async () => {
      const { h, bridges } = await lan([{ extraArgs: HOST }, { extraArgs: client("a") }, { caps: ["cmd"] }]);
      // Bound, but nothing listens: its attach fails without stopping the rest.
      h.ctx.bind(4, 1);
      const res = await h.call("set_pause", { paused: true, all: true, instance: 9 });
      expect(res.isError).toBeFalsy();
      const lines = (res.content?.[0]?.text ?? "").split("\n");
      expect(lines.slice(0, 3)).toEqual([
        `instance 1: paused; netgame server: ${SERVER_NOTE}`,
        `instance 2: paused; netgame client: ${CLIENT_NOTE}`,
        "instance 3: This engine bridge has no time-control support (rebuild/redownload with the latest bridge).",
      ]);
      expect(lines[3]).toMatch(/^instance 4: \S/);
      expect(lines).toHaveLength(4);
      expect(await h.text("set_pause", { paused: false, all: true })).toMatch(/^instance 1: resumed\ninstance 2: resumed\n/);
      expect(bridges[0].pauses).toEqual([1, 0]);
      expect(bridges[1].pauses).toEqual([1, 0]);
      expect(bridges[2].pauses).toEqual([]);
    });

    it("set_pause all with nothing bound is an error", async () => {
      const h = await offline();
      const res = await h.call("set_pause", { paused: false, all: true });
      expect(res.isError).toBe(true);
      expect(res.content?.[0]?.text).toBe("no instances are bound in this session");
    });
  });

  describe("join_game", () => {
    /** A client bridge that spectates until a join lands, the `lands`-th join it gets. */
    function spectateUntilJoin(b: FakeBridge, lands = 1) {
      b.setStatus({ spectating: "1" });
      let joins = 0;
      b.onCommand("join", () => {
        if (++joins >= lands) b.setStatus({ spectating: "0" });
      });
    }

    it("joins every client once it spectates and reports the slot of its +name", async () => {
      const { h, bridges } = await lan([{ extraArgs: HOST }, { extraArgs: client("client_a") }, { extraArgs: client("client_b") }]);
      for (const b of bridges.slice(1)) {
        spectateUntilJoin(b);
        b.respondTo("dumpplayers", ["MCP_PLAYERS", "player slot=0 spec=1 name=Host", "player slot=1 spec=0 name=\x1cGCLIENT_A", "player slot=2 spec=0 name=client_b"]);
      }
      const res = await h.call("join_game");
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("instance 2: joined as player 1\ninstance 3: joined as player 2");
      expect(res.structuredContent).toEqual({
        clients: [
          { instance: 2, joined: true, slot: 1 },
          { instance: 3, joined: true, slot: 2 },
        ],
      });
      expect(bridges.slice(1).map(joinsOf)).toEqual([1, 1]);
      expect(cmdsOf(bridges[0])).toEqual([]);
    });

    it("sends nothing to a client that already joined, and gives no slot without a +name or a matching row", async () => {
      const { h, bridges } = await lan([{ extraArgs: client() }, { extraArgs: client("ghost") }]);
      bridges[1].respondTo("dumpplayers", ["MCP_PLAYERS", "player slot=0 spec=1", "player slot=1 spec=0 name=other"]);
      const res = await h.call("join_game");
      expect(res.content?.[0]?.text).toBe("instance 1: joined\ninstance 2: joined");
      expect(res.structuredContent).toEqual({ clients: [{ instance: 1, joined: true }, { instance: 2, joined: true }] });
      expect(bridges.map(joinsOf)).toEqual([0, 0]);
    });

    it("never sends join while the client is still connecting", async () => {
      const { h, bridges } = await lan([{ extraArgs: client("a") }]);
      bridges[0].setStatus({ gamestate: "fullconsole", spectating: "1" });
      const res = await h.call("join_game", { timeoutSec: 0.5 });
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("instance 1: not in a level yet after 0.5s");
      expect(res.structuredContent).toEqual({ clients: [{ instance: 1, joined: false, reason: "connecting" }] });
      expect(joinsOf(bridges[0])).toBe(0);
    });

    it("retries a join that didn't take once, at half the budget", async () => {
      const sleeps: number[] = [];
      const io = { sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()) };
      const { h, bridges } = await lan([{ extraArgs: client("a") }], { io });
      spectateUntilJoin(bridges[0], 2);
      expect(await h.text("join_game", { timeoutSec: 1 })).toBe("instance 1: joined");
      expect(joinsOf(bridges[0])).toBe(2);
      // The retry goes out on the read at 500 ms, and the next poll sees it landed.
      expect(sleeps.length).toBe(6);
    });

    it("reports a client still spectating after the budget, having sent join and one retry", async () => {
      const { h, bridges } = await lan([{ extraArgs: client("a") }]);
      bridges[0].setStatus({ spectating: "1" });
      expect(await h.text("join_game", { timeoutSec: 1 })).toBe("instance 1: still spectating after 1.0s");
      expect(joinsOf(bridges[0])).toBe(2);
    });

    it("sends join again at once after a reconnect drops the client back to connecting", async () => {
      const sleeps: number[] = [];
      const io = { sleep: (ms: number) => (sleeps.push(ms), Promise.resolve()) };
      const { h, bridges } = await lan([{ extraArgs: client("a") }], { io });
      const b = bridges[0];
      b.setStatus({ spectating: "1" });
      let joins = 0;
      let since = 0;
      // The first join races a server `map`: the client reconnects, then spectates again.
      b.onCommand("join", () => {
        if (++joins === 1) b.setStatus({ gamestate: "fullconsole" });
        else b.setStatus({ spectating: "0" });
      });
      b.onCommand("", () => {
        if (joins === 1 && ++since === 3) b.setStatus({ gamestate: "level" });
      });
      expect(await h.text("join_game", { timeoutSec: 15 })).toBe("instance 1: joined");
      expect(joins).toBe(2);
      expect(sleeps.length).toBeLessThan(10);
    });

    it("refuses a server, and reports an unbound or status-less instance, per instance", async () => {
      const { h } = await lan([{ extraArgs: HOST }, { extraArgs: client("a"), caps: ["cmd", "time"] }]);
      const res = await h.call("join_game", { instances: [1, 2, 7] });
      expect(res.isError).toBeFalsy();
      const lines = (res.content?.[0]?.text ?? "").split("\n");
      expect(lines[0]).toBe("instance 1: not joined: join can't be used on the server");
      expect(lines[1]).toBe("instance 2: not joined: this engine bridge has no status support (rebuild with the latest bridge)");
      expect(lines[2]).toMatch(/^instance 7: not joined: Instance 7 isn't running in this session/);
    });

    it("is an error with no client instances, or on an engine whose clients enter as players", async () => {
      const { h } = await lan([{ extraArgs: HOST }, {}]);
      const none = await h.call("join_game");
      expect(none.isError).toBe(true);
      expect(none.content?.[0]?.text).toBe("no client instances: launch them with the client flag in extraArgs, or pass instances");
      await h.close();
      harness = undefined;
      for (const variant of [{ ...engine, netgame: undefined }, { ...engine, netgame: { ...LAN_CAPS, joinCommand: undefined } }]) {
        const { h: other } = await lan([{ extraArgs: client("a") }], { engine: variant });
        const res = await other.call("join_game");
        expect(res.isError).toBe(true);
        expect(res.content?.[0]?.text).toBe(
          `${engine.displayName} clients enter the game as players when they connect; there is nothing to join.`,
        );
        await other.close();
        harness = undefined;
      }
    });
  });

  describe("wait_for_log", () => {
    /** An offline harness whose instance-1 log reads each of `logs` in turn, then the last one forever. */
    async function waiting(logs: Array<string | undefined>, io: Partial<ContextIo> = {}) {
      let reads = 0;
      const current = () => logs[Math.min(reads, logs.length - 1)];
      const h = await offline(
        { exe: "/engine/zandronum" },
        {
          existsSync: () => current() !== undefined,
          readTextSync: () => current()!,
          sleep: () => (reads++, Promise.resolve()),
          ...io,
        },
      );
      return h;
    }

    it("matches a line already in the log at once, since sinceLine defaults to the launch", async () => {
      const h = await waiting(["a\n__MCPDONE_1__\nclient_a joined the game.\n"]);
      const res = await h.call("wait_for_log", { pattern: "joined the game" });
      expect(res.content?.[0]?.text).toBe("matched after 0.0s, nextLine=3\n3: client_a joined the game.");
      expect(res.structuredContent).toEqual({
        reason: "matched",
        lines: [{ line: 3, text: "client_a joined the game." }],
        nextLine: 3,
        waitedMs: 0,
      });
    });

    it("waits for count matches after sinceLine, so a resumed wait needs a new occurrence", async () => {
      const h = await waiting(["tick 1\n", "tick 1\ntick 2\n", "tick 1\ntick 2\nnoise\ntick 3\n"]);
      const res = await h.call("wait_for_log", { pattern: "^tick", sinceLine: 1, count: 2 });
      expect(res.content?.[0]?.text).toBe("matched after 0.2s, nextLine=4\n2: tick 2\n4: tick 3");
      expect(res.structuredContent).toMatchObject({ reason: "matched", nextLine: 4, waitedMs: 200 });
    });

    it("resumes at the last line it returned when more than count matched", async () => {
      const h = await waiting(["x 1\nx 2\nx 3\n"]);
      expect((await h.call("wait_for_log", { pattern: "x" })).structuredContent).toMatchObject({ nextLine: 1 });
    });

    it("times out after timeoutSec, reporting the matches so far", async () => {
      const h = await waiting(["a\n"]);
      const res = await h.call("wait_for_log", { pattern: "never", timeoutSec: 2 });
      expect(res.isError).toBeFalsy();
      expect(res.content?.[0]?.text).toBe("timeout after 2.0s, 0/1 match(es), nextLine=1");
      expect(res.structuredContent).toEqual({ reason: "timeout", lines: [], nextLine: 1, waitedMs: 2000 });
    });

    it("stops when the engine exits, still counting a line printed just before", async () => {
      let alive = true;
      const h = await waiting(["a\n", "a\n", "a\nbye\n"], { alive: () => alive });
      h.ctx.rememberEngine(1, 4242);
      const dies = await h.call("wait_for_log", { pattern: "never", timeoutSec: 10, count: 1 });
      expect(dies.structuredContent).toMatchObject({ reason: "timeout" });
      alive = false;
      const res = await h.call("wait_for_log", { pattern: "never" });
      expect(res.content?.[0]?.text).toBe("engine exited after 0.1s, 0/1 match(es), nextLine=2");
      expect(res.structuredContent).toMatchObject({ reason: "exited", waitedMs: 100 });
      expect((await h.call("wait_for_log", { pattern: "bye", sinceLine: 1 })).structuredContent).toMatchObject({ reason: "matched" });
    });

    it("reads a log that vanished mid-wait as no match yet", async () => {
      const h = await waiting(["a\n", undefined, "a\nhello\n"]);
      const res = await h.call("wait_for_log", { pattern: "hello" });
      expect(res.structuredContent).toMatchObject({ reason: "matched", nextLine: 2, waitedMs: 200 });
    });

    it("errors with no log, naming the path it looked for, and on an invalid pattern before reading", async () => {
      const none = await (await offline()).call("wait_for_log", { pattern: "x" });
      expect(none.isError).toBe(true);
      expect(none.content?.[0]?.text).toBe("No engine log for instance 1. Launch it via launch_instance, which enables logging.");
      const h = await waiting([undefined]);
      const missing = await h.call("wait_for_log", { pattern: "x" });
      expect(missing.content?.[0]?.text).toMatch(sepRe(/^No engine log for instance 1 \(looked for \/engine\/mcp-bridge-\d+\.log\)/));
      const bad = await h.call("wait_for_log", { pattern: "(" });
      expect(bad.isError).toBe(true);
      expect(bad.content?.[0]?.text).toMatch(/not a valid regex/);
    });
  });
});
