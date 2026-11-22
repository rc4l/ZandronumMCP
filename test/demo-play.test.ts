import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./fakes/tool-harness.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { memFs } from "./fakes/mem-fs.js";
import { abs, norm, sepRe } from "./fakes/paths.js";
import { checkSidecar, resolvePlayTarget } from "../src/demo/play.js";
import { serializeSidecar, type Sidecar } from "../src/demo/sidecar.js";
import { engine } from "../src/engine.js";

const sidecar = (over: Partial<Sidecar> = {}): Sidecar => ({
  // The adapter's id, so the tool tests match whichever engine core is synced into.
  version: 1, engine: engine.id, bridge: "0.16.0", recordedAt: "t", lmp: null,
  iwad: { path: "/w/DOOM2.WAD", sha1: "sha1(iwad)" }, files: [], map: "MAP02", skill: 4, save: null, ...over,
});

describe("resolvePlayTarget", () => {
  const has = (...paths: string[]) => (p: string) => paths.map(norm).includes(p);

  it("takes an absolute path as a file, adding .lmp", () => {
    expect(resolvePlayTarget("/d/a.lmp", "/demos", has())).toEqual({ file: "/d/a.lmp" });
    expect(resolvePlayTarget("/d/a", undefined, has())).toEqual({ file: "/d/a.lmp" });
  });

  it("takes a bare name as a file under the dir only when it exists, else as a lump", () => {
    expect(resolvePlayTarget("m1", "/demos", has("/demos/m1.lmp"))).toEqual({ file: norm("/demos/m1.lmp") });
    expect(resolvePlayTarget("DEMO1", "/demos", has())).toEqual({ lump: "DEMO1" });
    expect(resolvePlayTarget("m1", undefined, has("/demos/m1.lmp"))).toEqual({ lump: "m1" });
    expect(resolvePlayTarget("sub/m1", "/demos", () => true)).toEqual({ lump: "sub/m1" });
  });
});

describe("checkSidecar", () => {
  const file = (path: string, sha1: string | null, rev?: string) => ({ path, sha1, ...(rev && { git: { rev, dirty: false } }) });

  it("refuses another engine, and another iwad", () => {
    expect(checkSidecar(sidecar({ engine: "other" }), engine.id, sidecar()).refuse).toBe(`recorded on other, not ${engine.id}: its replay can't match`);
    expect(checkSidecar(sidecar(), engine.id, sidecar({ iwad: { path: "/w/TNT.WAD", sha1: "x" } })).refuse).toBe(
      "recorded against iwad /w/DOOM2.WAD (sha1 sha1(iwad)), but the instance runs /w/TNT.WAD (sha1 x): relaunch with that iwad",
    );
  });

  it("compares nothing for an instance with no launch options, and no iwad when either lacks one", () => {
    expect(checkSidecar(sidecar(), engine.id, undefined)).toEqual({ notes: [expect.stringMatching(/weren't compared/)], changes: [] });
    expect(checkSidecar(sidecar({ iwad: null }), engine.id, sidecar({ iwad: { path: "/x", sha1: "y" } }))).toEqual({ notes: [], changes: [] });
    expect(checkSidecar(sidecar(), engine.id, sidecar({ iwad: null }))).toEqual({ notes: [], changes: [] });
  });

  it("compares a blessed sidecar's files with the bless-time ones", () => {
    const blessed = sidecar({
      files: [file("/a.pk3", "old")],
      checkpoints: { every: 35, start: 1, end: 9, lastPlayable: 8, blessedAt: "t", lmpSha1: "l", files: [file("/a.pk3", "1")], rows: "r", heads: [] },
    });
    const checked = checkSidecar(blessed, engine.id, sidecar({ files: [file("/a.pk3", "2")] }));
    expect(checked).toEqual({ notes: ["/a.pk3 changed since blessing"], changes: [{ path: "/a.pk3", kind: "changed" }] });
  });

  it("notes files changed, missing or added since recording", () => {
    const recorded = sidecar({
      files: [file("/a.pk3", "1"), file("/b.pk3", "2", "aaaaaaaaaaaa"), file("/dir", null, "cccccccccccc"), file("/gone.wad", "3"), file("/same.wad", "4", "r")],
    });
    const now = sidecar({
      files: [file("/a.pk3", "1x"), file("/b.pk3", "2x", "bbbbbbbbbbbb"), file("/dir", null, "dddddddddddd"), file("/same.wad", "4", "r"), file("/new.pk3", "5")],
    });
    expect(checkSidecar(recorded, engine.id, now).notes).toEqual([
      "/a.pk3 changed since recording",
      "/b.pk3 changed since recording (git aaaaaaaaa -> bbbbbbbbb)",
      "/dir changed since recording (git ccccccccc -> ddddddddd)",
      "/gone.wad was loaded when recording, not now",
      "/new.pk3 is loaded now, not when recording",
    ]);
  });
});

/** The overlay's demo half of `mcp_clock`, where `playdemo` starts and engages an armed freeze on the
 *  next frame and steps stop at the demo's end with `demo_end`. */
class DemoClock {
  frozen = false;
  armed = false;
  demo = false;
  maptime = 0;
  steps = 0;
  reason = "-";
  jobs = 0;
  /** The demo's last maptime: a step past it ends the demo. */
  end = 500;
  /** A playdemo that starts on the next frame, at this maptime. */
  starting?: number;
  loaded = false;
  /** The playdemo starts, but an armed freeze never engages. */
  neverEngage = false;
  gamestate = "level";
  /** Set at demo_end: the first live tic after it drops to the console, and a playdemo queued with it. */
  endPending = false;
  /** Ends the next step run with this reason. */
  abort?: string;
  refuse: Record<string, string> = {};
  printed: string[] = [];
  readonly reply: string[] = [];
  /** `mcp_checkpoint`'s reply: a digest that is a function of maptime, skewed from `skew.from` on. */
  readonly cp: string[] = [];
  skew?: { from: number; kind: "row" | "group" };
  constructor(private readonly bridge: FakeBridge) {}

  private checkpoint(rows: boolean): string[] {
    const m = this.maptime;
    const off = this.skew !== undefined && m >= this.skew.from;
    const x = off && this.skew!.kind === "row" ? "bad" : `x${m}`;
    const inv = off && this.skew!.kind === "group" ? "skewed" : "i0";
    const head = `MCP_CHECKPOINT maptime=${m} actors=1 rng=r${m} hash=${x}${inv} pos=${x} vel=v angle=a health=h tics=t state=s inv=${inv}`;
    const row = `MCP_CHECKPOINT_ROW i=3 class=Zombieman h=h${x} x=${x} y=0 z=0 vx=0 vy=0 vz=0 angle=0 pitch=0 health=20 tics=4 sprite=POSS frame=A`;
    return rows ? [head, row] : [head];
  }

  status() {
    return `MCP_CLOCK frozen=${+this.frozen} gametic=${this.maptime} maptime=${this.maptime} interp=1 jobs=${this.jobs ? 1 : 0} steps=${this.steps} shots=0 reason=${this.reason} armed=${this.armed ? "demo" : "-"}`;
  }

  private frame() {
    if (this.endPending && !this.frozen) [this.endPending, this.starting, this.gamestate] = [false, undefined, "fullconsole"];
    if (this.starting !== undefined) {
      [this.demo, this.maptime, this.starting, this.gamestate] = [true, this.starting, undefined, "level"];
      if (this.armed && !this.neverEngage) [this.frozen, this.armed, this.steps] = [true, false, 0];
    }
    if (this.jobs === 0) return;
    this.reason = this.abort ?? "done";
    for (; this.jobs > 0 && !this.abort; this.jobs--) {
      this.maptime++;
      this.steps++;
      // The tic that reads the demo's end counts in steps (PROTOCOL.md, demo_end).
      if (this.maptime >= this.end) {
        [this.reason, this.demo, this.endPending] = ["demo_end", false, true];
        break;
      }
    }
    [this.jobs, this.abort] = [0, undefined];
  }

  run(text: string) {
    this.frame();
    this.reply.length = 0;
    for (const [verb, sub, arg] of text.split(";").map((p) => p.trim().split(/\s+/))) {
      if (verb === "load") this.loaded = true;
      if (verb === "playdemo" && sub.includes("missing")) this.printed.push("Can't find demo");
      else if (verb === "playdemo") [this.starting, this.loaded] = [(this.loaded ? 100 : 0) + 1, false];
      if (verb === "mcp_checkpoint") this.cp.splice(0, this.cp.length, ...this.checkpoint(sub === "rows"));
      if (verb !== "mcp_clock") continue;
      if (this.refuse[sub]) this.reply.push(`error ${this.refuse[sub]}`);
      else if (sub === "status") this.reply.push(this.status(), ...this.printed.splice(0));
      else if (sub === "thaw") [this.frozen, this.armed] = [false, false];
      else if (sub === "freeze" && this.frozen) this.reply.push(this.status());
      else if (sub === "freeze") {
        this.armed = true;
        this.reply.push("MCP_CLOCK armed=demo frozen=0");
      } else if (sub === "step") {
        [this.jobs, this.reason] = [Number(arg), "-"];
        this.reply.push("MCP_CLOCK queued jobs=1");
      } else if (sub === "stop") {
        [this.armed, this.jobs] = [false, 0];
        this.reply.push("MCP_CLOCK stopped dropped=0");
      }
    }
    this.bridge.setStatus({ frozen: String(+this.frozen), demo: this.demo ? "1" : "0", maptime: String(this.maptime), gamestate: this.gamestate });
  }
}

describe("play_demo and seek_demo", () => {
  let bridge: FakeBridge | undefined;
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await bridge?.close();
    bridge = undefined;
  });

  const CAPS = ["cmd", "event", "time", "status", "clock", "demo"];

  async function rig(opts: { files?: Record<string, string>; caps?: string[]; config?: Record<string, unknown> } = {}) {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "zandronum", caps: opts.caps ?? CAPS } });
    const clock = new DemoClock(bridge);
    const fs = memFs({ "/w/DOOM2.WAD": "iwad", ...opts.files });
    harness = await startHarness({ config: { basePort: bridge.port, exe: "/engine/zandronum", ...opts.config }, io: fs.io });
    bridge.respondTo("mcp_clock", clock.reply);
    bridge.respondTo("mcp_checkpoint", clock.cp);
    bridge.onCommand("", (text) => clock.run(text));
    clock.run("");
    await harness.call("attach_instance");
    bridge.clearReceived();
    return { h: harness, clock, fs };
  }

  const sent = () => bridge!.received.filter((m) => m.t === "cmd").map((m) => (m.text ?? "").replace(/\s*;\s*mcp_status \S+$/, ""));
  const launchedWith = (h: Harness, args: Record<string, unknown>) =>
    h.ctx.rememberLaunchArgs(1, { iwad: "/w/DOOM2.WAD", ...args }, bridge!.port, "/engine/mcp-bridge-1.log");

  it("holds a demo from the engine's folder at its first tic", async () => {
    const { h } = await rig({ files: { "/engine/m1.lmp": "d" } });
    const res = await h.call("play_demo", { name: "m1", hold: true });
    expect(res.content?.[0]?.text).toBe(`holding ${norm("/engine/m1.lmp")} at maptime 1`);
    expect(res.structuredContent).toMatchObject({ maptime: 1, lmp: norm("/engine/m1.lmp") });
    expect(sent()).toContain("mcp_clock freeze demo ; playdemo /engine/m1.lmp");
  });

  it("starts from the sidecar's save, checks it, and gives a blessed end", async () => {
    const side = sidecar({
      save: { path: "/saves/b.zds", sha1: "s" },
      files: [{ path: abs("/mod/m.pk3"), sha1: "sha1(older)" }],
      checkpoints: {
        every: 35, start: 101, end: 400, lastPlayable: 399, blessedAt: "t", lmpSha1: "x", files: [{ path: abs("/mod/m.pk3"), sha1: "sha1(old)" }], rows: "r", heads: [],
      },
    });
    const { h } = await rig({ config: { demoDir: "/demos" }, files: { "/demos/m6.lmp": "d", "/demos/m6.json": serializeSidecar(side), "/mod/m.pk3": "new" } });
    launchedWith(h, { files: ["/mod/m.pk3"] });
    const res = await h.call("play_demo", { name: "m6", hold: true });
    expect(res.content?.[0]?.text).toBe(`holding ${norm("/demos/m6.lmp")} at maptime 101\n${abs("/mod/m.pk3")} changed since blessing`);
    expect(res.structuredContent).toMatchObject({ maptime: 101, lmp: norm("/demos/m6.lmp"), end: 400 });
    expect(sent()).toContain("mcp_clock freeze demo ; load /saves/b.zds ; playdemo /demos/m6.lmp");
  });

  it("refuses a sidecar from another iwad, and an unreadable one", async () => {
    const { h, fs } = await rig({ files: { "/engine/m1.lmp": "d", "/engine/m1.json": serializeSidecar(sidecar()), "/w/TNT.WAD": "tnt" } });
    launchedWith(h, { iwad: "/w/TNT.WAD" });
    const res = await h.call("play_demo", { name: "m1", hold: true });
    expect(res.isError).toBe(true);
    expect(res.content?.[0]?.text).toBe(
      `${norm("/engine/m1.lmp")}: recorded against iwad /w/DOOM2.WAD (sha1 sha1(iwad)), but the instance runs ${abs("/w/TNT.WAD")} (sha1 sha1(tnt)): relaunch with that iwad`,
    );
    fs.files.set("/engine/m1.json", "{}");
    expect(await h.text("play_demo", { name: "m1" })).toMatch(/sidecar version undefined/);
    expect(sent().some((c) => c.includes("playdemo"))).toBe(false);
  });

  it("plays unheld as before, with the sidecar's notes, and refuses on a frozen clock", async () => {
    const { h, clock } = await rig({ files: { "/engine/m1.lmp": "d", "/engine/m1.json": serializeSidecar(sidecar()) } });
    expect(await h.text("play_demo", { name: "m1" })).toBe("(playing)\n(no launch options for this instance, so its iwad and files weren't compared with the recording's)");
    expect(sent()).toContain("playdemo /engine/m1.lmp");
    clock.frozen = true;
    clock.run("");
    const res = await h.call("play_demo", { name: "DEMO1" });
    expect(res.content?.[0]?.text).toBe("time is frozen: freeze_time off first");
  });

  it("thaws a frozen clock before arming, so a held demo can be re-held", async () => {
    const { h } = await rig({ files: { "/engine/m1.lmp": "d" } });
    await h.call("play_demo", { name: "m1", hold: true });
    bridge!.clearReceived();
    expect((await h.call("play_demo", { name: "m1", hold: true })).content?.[0]?.text).toBe(`holding ${norm("/engine/m1.lmp")} at maptime 1`);
    expect(sent()).toContain("mcp_clock thaw ; mcp_clock freeze demo ; playdemo /engine/m1.lmp");
  });

  it("refuses hold without the bridge's demo support", async () => {
    const { h } = await rig({ caps: ["cmd", "event", "time", "status", "clock"] });
    expect(await h.text("play_demo", { name: "DEMO1", hold: true })).toBe("hold needs a bridge with demo support: rebuild the engine with the current overlay");
  });

  it("disarms and says why when the demo doesn't engage: an arm refusal, or a demo that never starts", async () => {
    const { h, clock } = await rig();
    clock.refuse.freeze = "not in a level";
    const refused = await h.call("play_demo", { name: "DEMO1", hold: true });
    expect(refused.content?.[0]?.text).toBe("DEMO1 didn't start held within ~5 s: not in a level (disarmed)");
    expect(sent().at(-1)).toBe("mcp_clock stop");
    delete clock.refuse.freeze;
    expect(await h.text("play_demo", { name: "missing", hold: true })).toBe("missing didn't start held within ~5 s: Can't find demo (disarmed)");
    expect(clock.armed).toBe(false);
    clock.neverEngage = true;
    expect(await h.text("play_demo", { name: "DEMO1", hold: true })).toBe("DEMO1 didn't start held within ~5 s (disarmed)");
  });

  it("refuses a name the console can't take as one token", async () => {
    const { h } = await rig();
    expect(await h.text("play_demo", { name: "a;b" })).toBe('can\'t pass a;b to the console: it contains ";"');
  });

  it("seeks forward exactly, and rewinds by replaying the demo held", async () => {
    const { h } = await rig({ files: { "/engine/m1.lmp": "d" } });
    await h.call("play_demo", { name: "m1", hold: true });
    const fwd = await h.call("seek_demo", { maptime: 300 });
    expect(fwd.content?.[0]?.text).toBe("at maptime 300");
    expect(fwd.structuredContent).toMatchObject({ maptime: 300, ended: false });
    expect(await h.text("seek_demo", { maptime: 300 })).toBe("at maptime 300");
    bridge!.clearReceived();
    expect(await h.text("seek_demo", { maptime: 100 })).toBe("at maptime 100 (replayed from its start)");
    expect(sent()).toContain("mcp_clock thaw ; mcp_clock freeze demo ; playdemo /engine/m1.lmp");
    expect(await h.text("seek_demo", { maptime: 1 })).toBe("at maptime 1 (replayed from its start)");
  });

  it("stops at the demo's end when unblessed, and rewinds from there", async () => {
    const { h } = await rig();
    await h.call("play_demo", { name: "DEMO1", hold: true });
    const past = await h.call("seek_demo", { maptime: 600 });
    expect(past.content?.[0]?.text).toBe("at maptime 500: the demo ended at maptime 500, before 600");
    expect(past.structuredContent).toMatchObject({ maptime: 500, ended: true });
    bridge!.clearReceived();
    expect(await h.text("seek_demo", { maptime: 200 })).toBe("at maptime 200 (replayed from its start)");
    // Thawed alone first: the ended demo's console drop would take a playdemo queued with the thaw.
    expect(sent()).toContain("mcp_clock thaw");
    expect(sent()).toContain("mcp_clock freeze demo ; playdemo DEMO1");
  });

  it("refuses past a blessed end, and before a save-started demo's first tic", async () => {
    const side = sidecar({
      save: { path: "/saves/b.zds", sha1: "s" },
      checkpoints: { every: 35, start: 101, end: 400, lastPlayable: 399, blessedAt: "t", lmpSha1: "x", files: [], rows: "r", heads: [] },
    });
    const { h } = await rig({ files: { "/engine/m6.lmp": "d", "/engine/m6.json": serializeSidecar(side) } });
    await h.call("play_demo", { name: "m6", hold: true });
    expect(await h.text("seek_demo", { maptime: 400 })).toBe(`${norm("/engine/m6.lmp")} ends at maptime 399 (blessed): seek to that or earlier`);
    expect(await h.text("seek_demo", { maptime: 50 })).toBe(`${norm("/engine/m6.lmp")} starts at maptime 101; held there`);
  });

  it("reports a step that ended short for another reason", async () => {
    const { h, clock } = await rig();
    await h.call("play_demo", { name: "DEMO1", hold: true });
    clock.abort = "paused";
    expect(await h.text("seek_demo", { maptime: 50 })).toMatch(/^at maptime 1: a pause landed while frozen/);
  });

  it("needs a held demo, and a demo it started to rewind", async () => {
    const { h, clock } = await rig();
    expect(await h.text("seek_demo", { maptime: 5 })).toBe("no held demo: play_demo with hold: true first");
    // Held by hand: playing and frozen, but nothing to replay.
    clock.run("mcp_clock freeze demo ; playdemo DEMO1");
    clock.run("");
    expect(await h.text("seek_demo", { maptime: 10 })).toBe("at maptime 10");
    expect(await h.text("seek_demo", { maptime: 5 })).toBe("maptime 5 is behind 10, and a demo this session didn't start can't be replayed: play_demo it with hold: true");
  });

  it("says why a rewind's re-hold failed", async () => {
    const { h, clock } = await rig();
    await h.call("play_demo", { name: "DEMO1", hold: true });
    await h.call("seek_demo", { maptime: 20 });
    clock.neverEngage = true;
    expect(await h.text("seek_demo", { maptime: 5 })).toBe("DEMO1 didn't start held within ~5 s (disarmed)");
  });

  it("refuses seek without the bridge's demo support", async () => {
    const { h } = await rig({ caps: ["cmd", "event", "time", "status", "clock"] });
    expect(await h.text("seek_demo", { maptime: 5 })).toBe("seek_demo needs a bridge with demo support: rebuild the engine with the current overlay");
  });

  describe("check_demo", () => {
    const sidecarAt = (fs: { files: Map<string, string> }, p: string) => JSON.parse(fs.files.get(p)!) as Sidecar;

    it("blesses a demo with no sidecar from the instance's launch, then checks it in sync from the frozen end", async () => {
      const { h, fs } = await rig({ files: { "/engine/m1.lmp": "take", "/mod/m.pk3": "pk3" } });
      launchedWith(h, { files: ["/mod/m.pk3"], map: "MAP01", skill: 2 });
      const { result, progress } = await h.callWithProgress("check_demo", { name: "m1", bless: true });
      expect(result.content?.[0]?.text).toBe(`blessed ${norm("/engine/m1.lmp")}: 16 checkpoint(s) every 35 tic(s), maptime 1..500`);
      expect(result.structuredContent).toMatchObject({ checkpoints: 16, start: 1, end: 500, lastPlayable: 499 });
      expect(progress[0]?.message).toBe("blessing m1.lmp: maptime 1");
      const side = sidecarAt(fs, "/engine/m1.json");
      expect(side).toMatchObject({
        engine: engine.id, recordedAt: null, map: null, skill: null, save: null,
        lmp: { file: "m1.lmp", bytes: 4, sha1: "sha1(take)" },
        iwad: { path: abs("/w/DOOM2.WAD"), sha1: "sha1(iwad)" },
        files: [{ path: abs("/mod/m.pk3"), sha1: "sha1(pk3)" }],
      });
      expect(side.checkpoints).toMatchObject({
        every: 35, start: 1, end: 500, lastPlayable: 499, blessedAt: "2026-11-09T12:00:00.000Z", lmpSha1: "sha1(take)",
        files: [{ path: abs("/mod/m.pk3"), sha1: "sha1(pk3)" }], rows: "m1.rows.json.gz",
      });
      expect(side.checkpoints!.heads[1]).toMatchObject({ maptime: 36, actors: 1, rng: "r36" });
      expect(fs.blobs.has("/engine/m1.rows.json.gz")).toBe(true);
      expect(h.ctx.demoFor(1)).toMatchObject({ lastPlayable: 499, end: 500 });
      expect(await h.text("seek_demo", { maptime: 500 })).toBe(`${norm("/engine/m1.lmp")} ends at maptime 499 (blessed): seek to that or earlier`);
      bridge!.clearReceived();
      const check = await h.call("check_demo", { name: "m1" });
      expect(check.content?.[0]?.text).toBe("in sync: 16 checkpoint(s), maptime 1..500");
      expect(check.structuredContent).toMatchObject({ inSync: true, checkpoints: 16, start: 1, end: 500, changed: [] });
      expect(sent()).toContain("mcp_clock freeze demo ; playdemo /engine/m1.lmp");
      expect(sent().filter((c) => c === "mcp_checkpoint rows")).toEqual([]);
    });

    it("keeps a recorded sidecar's fields when blessing it, and an existing lmp entry", async () => {
      const recorded = sidecar({ lmp: { file: "m1.lmp", bytes: 9, sha1: "rec" }, recordedAt: "2026-11-01T00:00:00Z" });
      const { h, fs } = await rig({ files: { "/engine/m1.lmp": "take", "/engine/m1.json": serializeSidecar(recorded) } });
      const res = await h.call("check_demo", { name: "m1", bless: true, every: 100 });
      expect(res.content?.[0]?.text).toBe(
        `blessed ${norm("/engine/m1.lmp")}: 6 checkpoint(s) every 100 tic(s), maptime 1..500\n(no launch options for this instance, so its iwad and files weren't compared with the recording's)`,
      );
      const side = sidecarAt(fs, "/engine/m1.json");
      expect(side).toMatchObject({ recordedAt: "2026-11-01T00:00:00Z", map: "MAP02", lmp: { sha1: "rec" } });
      expect(side.checkpoints).toMatchObject({ every: 100, lmpSha1: "sha1(take)", files: [] });
    });

    it("fills a recorded sidecar's missing lmp entry when blessing", async () => {
      const { h, fs } = await rig({ files: { "/engine/m1.lmp": "take", "/engine/m1.json": serializeSidecar(sidecar()) } });
      await h.call("check_demo", { name: "m1", bless: true });
      expect(sidecarAt(fs, "/engine/m1.json").lmp).toEqual({ file: "m1.lmp", bytes: 4, sha1: "sha1(take)" });
    });

    it("blesses an attached instance's demo with no iwad or files", async () => {
      const { h, fs } = await rig({ files: { "/engine/m1.lmp": "take" } });
      await h.call("check_demo", { name: "m1", bless: true });
      expect(sidecarAt(fs, "/engine/m1.json")).toMatchObject({ iwad: null, files: [], bridge: null });
    });

    it("stops at the first desync, frozen there, naming the actor from the blessed rows and the files changed", async () => {
      const { h, fs, clock } = await rig({ files: { "/engine/m1.lmp": "take", "/mod/m.pk3": "pk3" } });
      launchedWith(h, { files: ["/mod/m.pk3"] });
      await h.call("check_demo", { name: "m1", bless: true });
      fs.files.set("/mod/m.pk3", "pk3 v2");
      clock.skew = { from: 100, kind: "row" };
      const res = await h.call("check_demo", { name: "m1" });
      expect(res.content?.[0]?.text).toBe(
        `desynced at maptime 106 (last match 71): actor #3 Zombieman differs in x\n${abs("/mod/m.pk3")} changed since blessing`,
      );
      expect(res.structuredContent).toMatchObject({ inSync: false, maptime: 106, lastMatch: 71, changed: [abs("/mod/m.pk3")] });
      expect([clock.frozen, clock.demo, clock.maptime]).toEqual([true, true, 106]);
    });

    it("names the checkpoint fields when the rows file is missing or unreadable", async () => {
      const { h, fs, clock } = await rig({ files: { "/engine/m1.lmp": "take" } });
      await h.call("check_demo", { name: "m1", bless: true });
      clock.skew = { from: 1, kind: "group" };
      fs.files.delete("/engine/m1.rows.json.gz");
      expect(await h.text("check_demo", { name: "m1" })).toBe(
        `desynced at maptime 1 (no checkpoint matched): checkpoint differs in inv\n(no launch options for this instance, so its iwad and files weren't compared with the recording's)\n(no actor rows: ${norm("/engine/m1.rows.json.gz")} is missing)`,
      );
      fs.io.writeFileAtomic("/engine/m1.rows.json.gz", Buffer.from("junk"));
      expect(await h.text("check_demo", { name: "m1" })).toMatch(sepRe(/\(no actor rows: \/engine\/m1\.rows\.json\.gz can't be read: /));
    });

    it("doesn't name an actor from a rows file of another bless", async () => {
      const { h, fs, clock } = await rig({ files: { "/engine/m1.lmp": "take" } });
      await h.call("check_demo", { name: "m1", bless: true });
      const stale = fs.blobs.get("/engine/m1.rows.json.gz")!;
      await h.call("check_demo", { name: "m1", bless: true, every: 100 });
      fs.io.writeFileAtomic("/engine/m1.rows.json.gz", stale);
      clock.skew = { from: 50, kind: "row" };
      expect(await h.text("check_demo", { name: "m1" })).toMatch(
        sepRe(/^desynced at maptime 101 \(last match 1\): checkpoint differs in pos\n.*\n\(no actor rows: \/engine\/m1\.rows\.json\.gz doesn't match the sidecar\)$/),
      );
    });

    it("is a desync when the demo ends elsewhere", async () => {
      const { h, clock } = await rig({ files: { "/engine/m1.lmp": "take" } });
      await h.call("check_demo", { name: "m1", bless: true });
      clock.end = 450;
      expect(await h.text("check_demo", { name: "m1" })).toMatch(/^desynced at maptime 450 \(last match 421\): the demo ended at maptime 450, blessed at 500/);
    });

    it("refuses an unblessed or changed demo, a lump, and a bridge without demo support", async () => {
      const { h, fs } = await rig({ files: { "/engine/m1.lmp": "take", "/engine/m2.lmp": "x" } });
      expect(await h.text("check_demo", { name: "m2" })).toBe(`${norm("/engine/m2.lmp")} isn't blessed: check_demo with bless: true first`);
      expect(await h.text("check_demo", { name: "DEMO1", bless: true })).toBe(
        "DEMO1 isn't a demo file (a WAD lump has no sidecar): give a name in the demo folder or an absolute .lmp path",
      );
      await h.call("check_demo", { name: "m1", bless: true });
      fs.files.set("/engine/m1.lmp", "edited");
      expect(await h.text("check_demo", { name: "m1" })).toBe(`${norm("/engine/m1.lmp")} changed since it was blessed (sha1 sha1(take) -> sha1(edited)): bless it again`);
      fs.files.set("/engine/m1.json", serializeSidecar(sidecar({ engine: "other" })));
      expect(await h.text("check_demo", { name: "m1", bless: true })).toBe(`${norm("/engine/m1.lmp")}: recorded on other, not ${engine.id}: its replay can't match`);
    });

    it("refuses without the bridge's demo support", async () => {
      const { h } = await rig({ caps: ["cmd", "event", "time", "status", "clock"], files: { "/engine/m1.lmp": "take" } });
      expect(await h.text("check_demo", { name: "m1", bless: true })).toBe("check_demo needs a bridge with demo support: rebuild the engine with the current overlay");
    });

    it("says why the demo didn't hold, or why stepping stopped", async () => {
      const { h, clock } = await rig({ files: { "/engine/m1.lmp": "take" } });
      clock.neverEngage = true;
      expect(await h.text("check_demo", { name: "m1", bless: true })).toBe(`${norm("/engine/m1.lmp")} didn't start held within ~5 s (disarmed)`);
      clock.neverEngage = false;
      clock.abort = "paused";
      expect(await h.text("check_demo", { name: "m1", bless: true })).toMatch(/^after maptime 1, stepping stopped within 35 tic\(s\): a pause landed while frozen/);
    });
  });

  it("forgets the played demo with the instance", async () => {
    const { h } = await rig();
    await h.call("play_demo", { name: "DEMO1", hold: true });
    expect(h.ctx.demoFor(1)?.name).toBe("DEMO1");
    h.ctx.forgetInstance(1);
    expect(h.ctx.demoFor(1)).toBeUndefined();
    h.ctx.rememberDemo(1, { name: "x", start: "playdemo x" });
    h.ctx.forgetAll();
    expect(h.ctx.demoFor(1)).toBeUndefined();
  });
});
