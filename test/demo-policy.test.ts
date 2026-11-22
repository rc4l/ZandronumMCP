import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./fakes/tool-harness.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import {
  demoActivity,
  demoClass,
  demoMayRefuse,
  demoState,
  demoVerdict,
  netcmdUnlessTid,
  writesWithCommand,
  writesWithValue,
  type DemoClass,
} from "../src/demo/policy.js";

let bridge: FakeBridge | undefined;
let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  await bridge?.close();
  bridge = undefined;
});

async function live(status: Record<string, string>, caps = ["cmd", "event", "time", "status"]): Promise<Harness> {
  bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", caps } });
  bridge.setStatus(status);
  harness = await startHarness({ config: { basePort: bridge.port } });
  await harness.call("attach_instance");
  bridge.clearReceived();
  return harness;
}

const cmds = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => m.text ?? "");
const probes = () => cmds().filter((t) => /^mcp_status \S+$/.test(t)).length;

describe("demoState / demoActivity", () => {
  it("reads the flags, playback winning when both are set", () => {
    expect(demoState(undefined)).toEqual({ playing: false, recording: false });
    expect(demoState({ demo: "0", demorec: "1" })).toEqual({ playing: false, recording: true });
    expect([{}, { demorec: "1" }, { demo: "1", demorec: "1" }].map((s) => demoActivity(s))).toEqual([undefined, "recording", "playing"]);
  });
});

describe("demo policy classes", () => {
  it("classes arg-switched tools by their args", () => {
    expect(demoClass(writesWithValue, { prop: "health" })).toBe("read");
    expect(demoClass(writesWithValue, { prop: "health", value: 5 })).toBe("write");
    expect(demoClass(netcmdUnlessTid, { item: "Clip" })).toBe("netcmd");
    expect(demoClass(netcmdUnlessTid, { item: "Clip", tid: 0 })).toBe("write");
    expect(demoClass(writesWithCommand, {})).toBe("read");
    expect(demoClass(writesWithCommand, { command: "+attack" })).toBe("write");
    expect(demoClass("load", { command: "+attack" })).toBe("load");
  });

  it("decides each class per demo state", () => {
    const classes: DemoClass[] = ["read", "netcmd", "write", "input", "menu", "timeline", "load", "gate"];
    // r = refused, n = allowed with a note, - = allowed.
    const want: Record<DemoClass, [playing: string, recording: string]> = {
      read: ["-", "-"],
      netcmd: ["r", "-"],
      write: ["r", "r"],
      input: ["r", "-"],
      menu: ["-", "r"],
      timeline: ["r", "-"],
      load: ["n", "r"],
      gate: ["-", "-"],
    };
    const kind = (v: ReturnType<typeof demoVerdict>) => (v === undefined ? "-" : "refuse" in v ? "r" : "n");
    const wrong = classes.flatMap((c) => {
      const got = [
        kind(demoVerdict("t", c, { playing: true, recording: false })),
        kind(demoVerdict("t", c, { playing: false, recording: true })),
      ];
      const idle = kind(demoVerdict("t", c, { playing: false, recording: false }));
      return got.join() === want[c].join() && idle === "-" ? [] : [`${c}: ${got.join()} idle ${idle}`];
    });
    expect(wrong).toEqual([]);
    expect(classes.filter((c) => !demoMayRefuse(c))).toEqual(["read", "gate"]);
  });

  it("names the reason in a refusal", () => {
    expect(demoVerdict("summon", "netcmd", { playing: true, recording: false })).toEqual({
      refuse: "a demo is playing: summon is a netcommand, which playback drops",
    });
    expect(demoVerdict("summon_at", "write", { playing: false, recording: true })).toEqual({
      refuse: "a demo is recording: summon_at writes the game directly, which isn't recorded, so the replay desyncs",
    });
  });
});

describe("demo policy enforcement in registerLive", () => {
  it("refuses a netcommand during playback without sending it", async () => {
    const h = await live({ demo: "1" });
    const result = await h.call("summon", { className: "DoomImp" });
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toBe("a demo is playing: summon is a netcommand, which playback drops");
    expect(cmds().some((t) => t.includes("summon"))).toBe(false);
  });

  it("allows a call once a refresh shows the playback ended", async () => {
    const h = await live({ demo: "1" });
    // The cached snapshot still says demo=1; the policy's refresh reads the ended one.
    bridge!.setStatus({ demo: "0" });
    expect(await h.text("summon", { className: "DoomImp" })).toBe("summoned DoomImp");
  });

  it("refreshes a stale pending snapshot before deciding", async () => {
    const h = await live({ pending: "1" });
    bridge!.setStatus({ pending: "0", demo: "1" });
    const result = await h.call("summon_at", { className: "DoomImp", x: 0, y: 0 });
    expect(result.content?.[0]?.text).toMatch(/^a demo is playing: summon_at writes/);
  });

  it("notes that a load ended the playing demo", async () => {
    const h = await live({ demo: "1" });
    bridge!.respondTo("map MAP02", []);
    bridge!.queueStatus({ demo: "1" }, { demo: "1" }, { demo: "0" });
    const result = await h.call("load_map", { mapName: "MAP02" });
    expect(result.isError).toBeFalsy();
    expect(result.content?.map((c) => c.text)).toContain("(load_map ended the demo that was playing)");
  });

  it("allows an input-only call while recording and still settles after it", async () => {
    const h = await live({ demorec: "1" });
    const result = await h.call("mouse_move", { x: 5, y: 5 });
    expect(result.isError).toBeFalsy();
    expect(bridge!.events.length).toBeGreaterThan(0);
    // One refresh for the policy, one after the input.
    expect(probes()).toBe(2);
  });

  it("classes each args-switched tool by its call's args", async () => {
    const h = await live({ demo: "1" });
    const reply = async (tool: string, args: Record<string, unknown>) => (await h.call(tool, args)).content?.[0]?.text ?? "";
    expect(await reply("set_actor_prop", { prop: "health" })).not.toMatch(/^a demo is/);
    expect(await reply("set_actor_prop", { prop: "health", value: 5 })).toMatch(/^a demo is playing: set_actor_prop writes/);
    expect(await reply("give", { item: "Clip" })).toMatch(/^a demo is playing: give is a netcommand/);
    expect(await reply("take", { item: "Clip", tid: 0 })).toMatch(/^a demo is playing: take writes/);
    expect(await reply("record", { watch: [{ player: 0 }], tics: 1 })).not.toMatch(/^a demo is/);
  });

  it("refuses a menu while recording", async () => {
    const h = await live({ demorec: "1" });
    const result = await h.call("menu_key", { key: "enter" });
    expect(result.content?.[0]?.text).toMatch(/^a demo is recording: a menu /);
    expect(bridge!.events).toEqual([]);
  });

  it("counts a launch-time recording as recording when status can't be read", async () => {
    const h = await live({});
    h.ctx.rememberLaunchArgs(1, { record: "/demos/m1.lmp" }, bridge!.port, "/log");
    // A timed-out read clears the cached snapshot; the policy's refresh times out too.
    bridge!.swallowProbes(2);
    await h.ctx.attachedClient(1)!.readStatus(0);
    const result = await h.call("remove_actor", { tid: 3 });
    expect(result.content?.[0]?.text).toMatch(/^a demo is recording: remove_actor/);
  });

  it("decides nothing on a bridge without the status cap", async () => {
    const h = await live({ demo: "1" }, ["cmd", "event", "time"]);
    bridge!.respondTo("summon", ["ok"]);
    expect(await h.text("summon", { className: "DoomImp" })).toBe("ok");
  });

  it("reads no status for a call no demo state can refuse", async () => {
    const h = await live({ demo: "1" });
    bridge!.respondTo("getacsvar", ["acsvar world 5 = 42"]);
    await h.call("get_acs_var", { scope: "world", index: 5 });
    expect(probes()).toBe(0);
  });
});
