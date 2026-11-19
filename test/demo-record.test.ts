import { describe, it, expect, afterEach } from "vitest";
import { startHarness, type Harness } from "./fakes/tool-harness.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { memFs } from "./fakes/mem-fs.js";
import { abs, norm, sepRe } from "./fakes/paths.js";
import type { LaunchArgs } from "../src/context.js";
import { engine } from "../src/engine.js";
import { envName, type EngineAdapter } from "../src/adapter.js";
import { finishRecording, launchSidecar, resolveRecordArgs, type RecordSetup } from "../src/demo/record.js";
import { parseSidecar, serializeSidecar, type Sidecar } from "../src/demo/sidecar.js";

const setup: RecordSetup = { demoDir: "/demos", saveDir: "/saves", recordFromSave: true, saveDirEnv: "X_SAVE_DIR" };

describe("resolveRecordArgs", () => {
  it("resolves a bare record name under the demo dir and creates it", () => {
    const { io, dirs } = memFs();
    expect(resolveRecordArgs({ map: "MAP02", record: "m1" }, setup, io)).toEqual({ args: { map: "MAP02", record: norm("/demos/m1.lmp") } });
    expect(dirs).toEqual([norm("/demos")]);
    expect(resolveRecordArgs({ record: "/elsewhere/t.lmp" }, setup, io)).toEqual({ args: { record: "/elsewhere/t.lmp" } });
  });

  it("refuses a take that would overwrite an existing lmp, and a relative path", () => {
    const { io, dirs } = memFs({ "/demos/m1.lmp": "x" });
    expect(resolveRecordArgs({ record: "m1" }, setup, io)).toEqual({ error: `${norm("/demos/m1.lmp")} already exists: pick a new record name` });
    expect(resolveRecordArgs({ record: "sub/m1" }, setup, io)).toMatchObject({ error: expect.stringMatching(/bare name or an absolute path/) });
    expect(dirs).toEqual([]);
  });

  it("resolves a save under the save dir or as given, and refuses a missing one", () => {
    const { io } = memFs({ "/saves/base.zds": "s", "/abs/b.zds": "s" });
    expect(resolveRecordArgs({ save: "base.zds" }, setup, io)).toEqual({ args: { save: abs("/saves/base.zds") } });
    expect(resolveRecordArgs({ save: "/abs/b.zds" }, { ...setup, saveDir: undefined }, io)).toEqual({ args: { save: abs("/abs/b.zds") } });
    expect(resolveRecordArgs({ save: "nope.zds" }, setup, io)).toEqual({ error: `save ${abs("/saves/nope.zds")} not found` });
    expect(resolveRecordArgs({ save: "base.zds" }, { ...setup, saveDir: undefined }, io)).toEqual({
      error: "save base.zds: give an absolute path, or set X_SAVE_DIR",
    });
  });

  it("records from a save only where the engine can", () => {
    const { io } = memFs({ "/saves/base.zds": "s" });
    expect(resolveRecordArgs({ save: "base.zds", record: "m6" }, setup, io)).toEqual({ args: { save: abs("/saves/base.zds"), record: norm("/demos/m6.lmp") } });
    expect(resolveRecordArgs({ save: "base.zds", record: "m6" }, { ...setup, recordFromSave: false }, io)).toMatchObject({
      error: expect.stringMatching(/can't record a demo from a savegame/),
    });
  });

  it("treats an empty record or save as cleared", () => {
    const { io } = memFs();
    expect(resolveRecordArgs({ map: "MAP01", record: "", save: "" }, setup, io)).toEqual({ args: { map: "MAP01" } });
  });
});

describe("launchSidecar", () => {
  it("hashes the iwad, files and save, with git revs, and leaves the take unwritten", () => {
    const { io } = memFs({ "/w/DOOM2.WAD": "iwad", "/mod/m.pk3": "pk3", "/eng/rel.wad": "rel", "/mod/dir": "dir", "/s/b.zds": "save" });
    const args: LaunchArgs = { iwad: "/w/DOOM2.WAD", files: ["/mod/m.pk3", "rel.wad", "/mod/dir"], map: "MAP02", skill: 4, save: "/s/b.zds", record: "/d/m.lmp" };
    expect(launchSidecar(args, "/eng", { engine: "zandronum", bridge: "0.16.0" }, io)).toEqual({
      version: 1,
      engine: "zandronum",
      bridge: "0.16.0",
      recordedAt: "2026-11-09T12:00:00.000Z",
      lmp: null,
      iwad: { path: abs("/w/DOOM2.WAD"), sha1: "sha1(iwad)" },
      files: [
        { path: abs("/mod/m.pk3"), sha1: "sha1(pk3)", git: { rev: "abc123", dirty: true } },
        { path: abs("/eng/rel.wad"), sha1: "sha1(rel)" },
        { path: abs("/mod/dir"), sha1: null, git: { rev: "abc123", dirty: true } },
      ],
      map: "MAP02",
      skill: 4,
      save: { path: "/s/b.zds", sha1: "sha1(save)" },
    });
  });

  it("fills nulls for what the launch didn't give", () => {
    const { io } = memFs();
    expect(launchSidecar({}, "/eng", { engine: "e", bridge: undefined }, io)).toMatchObject({
      bridge: null, iwad: null, files: [], map: null, skill: null, save: null,
    });
  });
});

describe("finishRecording", () => {
  const launched = (bridge: string | null): Sidecar => ({
    version: 1, engine: "zandronum", bridge, recordedAt: "t", lmp: null, iwad: null, files: [], map: "MAP02", skill: 4, save: null,
  });

  it("fills the sidecar's lmp, and the bridge version when launch didn't know it", () => {
    const { io, files } = memFs({ "/d/m.lmp": "take!", "/d/m.json": serializeSidecar(launched(null)) });
    expect(finishRecording("/d/m.lmp", "0.16.0", io)).toBe("recorded /d/m.lmp (5 bytes)");
    const s = parseSidecar(files.get("/d/m.json")!, "m.json");
    expect(s).toMatchObject({ sidecar: { bridge: "0.16.0", lmp: { file: "m.lmp", bytes: 5, sha1: "sha1(take!)" } } });
  });

  it("keeps a bridge version the sidecar already has, and null when neither knows one", () => {
    const { io, files } = memFs({ "/d/m.lmp": "t", "/d/m.json": serializeSidecar(launched("0.15.0")) });
    finishRecording("/d/m.lmp", "0.16.0", io);
    expect(parseSidecar(files.get("/d/m.json")!, "m.json")).toMatchObject({ sidecar: { bridge: "0.15.0" } });
    files.set("/d/m.json", serializeSidecar(launched(null)));
    finishRecording("/d/m.lmp", undefined, io);
    expect(parseSidecar(files.get("/d/m.json")!, "m.json")).toMatchObject({ sidecar: { bridge: null } });
  });

  it("says not written when the engine left no lmp", () => {
    const { io } = memFs();
    expect(finishRecording("/d/m.lmp", undefined, io)).toBe("recording not written: /d/m.lmp (the engine didn't quit cleanly)");
  });

  it("still reports the take when its sidecar is missing or invalid", () => {
    const { io, files } = memFs({ "/d/m.lmp": "t" });
    expect(finishRecording("/d/m.lmp", undefined, io)).toBe("recorded /d/m.lmp (1 bytes); sidecar not updated: ENOENT: /d/m.json");
    files.set("/d/m.json", "{");
    expect(finishRecording("/d/m.lmp", undefined, io)).toMatch(/^recorded \/d\/m\.lmp \(1 bytes\); sidecar not updated: \/d\/m\.json is not JSON/);
  });
});

describe("recording through the launch tools", () => {
  // A PID that is not (and cannot be) running, so a graceful quit sees the engine gone at once.
  const DEAD_PID = 0x7ffffff0;
  let bridge: FakeBridge | undefined;
  let harness: Harness | undefined;
  afterEach(async () => {
    await harness?.close();
    harness = undefined;
    await bridge?.close();
    bridge = undefined;
  });

  async function rig(opts: { initial?: Record<string, string>; config?: Record<string, unknown>; hello?: Record<string, unknown>; engine?: EngineAdapter } = {}) {
    bridge = await FakeBridge.start({ hello: opts.hello ?? { v: 1, t: "hello", engine: "zandronum", bridge: "0.16.0" } });
    const fs = memFs({ "/engine/zandronum": "exe", "/w/DOOM2.WAD": "iwad", ...opts.initial });
    const spawns: string[][] = [];
    harness = await startHarness({
      ...(opts.engine && { engine: opts.engine }),
      config: { exe: "/engine/zandronum", basePort: bridge.port, iwad: "/w/DOOM2.WAD", ...opts.config },
      io: {
        ...fs.io,
        hasBridge: () => true,
        findFreePort: () => Promise.resolve(bridge!.port),
        launchIo: {
          spawn: (_exe, args) => {
            spawns.push(args);
            return { pid: DEAD_PID, kill: () => {} };
          },
          waitForPort: () => Promise.resolve(),
          clearQuarantine: () => {},
          ensureDir: () => {},
          seedConfig: () => {},
        },
      },
    });
    return { h: harness, fs, spawns };
  }

  const sidecarOf = (files: Map<string, string>, json: string) => {
    const parsed = parseSidecar(files.get(json)!, json);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed.sidecar;
  };

  it("launches with -record under the engine's folder, mouse on, and writes the sidecar", async () => {
    const { h, fs, spawns } = await rig();
    expect(await h.text("launch_instance", { record: "m1", map: "MAP02", skill: 4 })).toBe(
      `launched instance 1 on bridge port ${bridge!.port}\nrecording to ${norm("/engine/m1.lmp")} (sidecar ${norm("/engine/m1.json")}); kill_instance writes the take`,
    );
    const argv = spawns[0];
    expect(argv.slice(argv.indexOf("-record"), argv.indexOf("-record") + 2)).toEqual(["-record", norm("/engine/m1.lmp")]);
    expect(argv[argv.indexOf("use_mouse") + 1]).toBe("1");
    expect(sidecarOf(fs.files, "/engine/m1.json")).toMatchObject({
      engine: engine.id, bridge: "0.16.0", lmp: null, iwad: { path: abs("/w/DOOM2.WAD"), sha1: "sha1(iwad)" }, map: "MAP02", skill: 4,
    });
    expect(h.ctx.launchArgsFor(1)?.args.record).toBe(norm("/engine/m1.lmp"));
  });

  it("uses the configured demo dir, and refuses an existing take before spawning", async () => {
    const { h, spawns } = await rig({ config: { demoDir: "/demos" }, initial: { "/demos/old.lmp": "x" } });
    const r = await h.call("launch_instance", { record: "old" });
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toBe(`${norm("/demos/old.lmp")} already exists: pick a new record name`);
    expect(spawns).toEqual([]);
  });

  it("says so when the sidecar can't be written, and still launches", async () => {
    const { h } = await rig();
    const text = await h.text("launch_instance", { record: "m1", files: ["/missing.pk3"] });
    expect(text.slice(text.indexOf("\n"))).toBe(`\nrecording to ${norm("/engine/m1.lmp")}; sidecar not written: ENOENT: ${abs("/missing.pk3")}`);
  });

  it("kill_instance reports the written take and fills the sidecar; a second kill says nothing more", async () => {
    const { h, fs } = await rig();
    await h.call("launch_instance", { record: "m1", map: "MAP02" });
    fs.files.set("/engine/m1.lmp", "demo-bytes");
    expect(await h.text("kill_instance")).toBe(`instance 1 quit cleanly\nrecorded ${norm("/engine/m1.lmp")} (10 bytes)`);
    expect(sidecarOf(fs.files, "/engine/m1.json").lmp).toEqual({ file: "m1.lmp", bytes: 10, sha1: "sha1(demo-bytes)" });
    expect(await h.text("kill_instance")).toBe("no instance 1 attached, nothing to kill");
  });

  it("a wait: false recording gets the bridge version once it attaches", async () => {
    const { h, fs } = await rig();
    await h.call("launch_instance", { record: "m1", wait: false });
    expect(sidecarOf(fs.files, "/engine/m1.json").bridge).toBeNull();
    await h.call("list_players");
    fs.files.set("/engine/m1.lmp", "d");
    await h.call("kill_instance");
    expect(sidecarOf(fs.files, "/engine/m1.json").bridge).toBe("0.16.0");
  });

  it("relaunch refuses a recording instance without a new record name, keeping it running", async () => {
    const { h, spawns } = await rig();
    await h.call("launch_instance", { record: "m1" });
    const r = await h.call("relaunch_instance");
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toBe(`Instance 1 records to ${norm("/engine/m1.lmp")}: give a new record name, or record: "" to stop recording.`);
    expect(spawns).toHaveLength(1);
    expect(h.ctx.registry.has(1)).toBe(true);
  });

  it("relaunch with a new name finishes the old take first; record: \"\" stops recording", async () => {
    const { h, fs, spawns } = await rig();
    await h.call("launch_instance", { record: "m1" });
    fs.files.set("/engine/m1.lmp", "a");
    expect(await h.text("relaunch_instance", { record: "m2" })).toBe(
      `recorded ${norm("/engine/m1.lmp")} (1 bytes)\nrelaunched instance 1 on bridge port ${bridge!.port} (old engine stopped)\n` +
        `recording to ${norm("/engine/m2.lmp")} (sidecar ${norm("/engine/m2.json")}); kill_instance writes the take`,
    );
    expect(spawns[1]).toContain(norm("/engine/m2.lmp"));
    fs.files.set("/engine/m2.lmp", "b");
    expect(await h.text("relaunch_instance", { record: "" })).toBe(
      `recorded ${norm("/engine/m2.lmp")} (1 bytes)\nrelaunched instance 1 on bridge port ${bridge!.port} (old engine stopped)`,
    );
    expect(spawns[2]).not.toContain("-record");
    expect(h.ctx.launchArgsFor(1)?.args.record).toBeUndefined();
  });

  it("relaunch refuses an existing take before quitting, and keeps the finished line when the new launch fails", async () => {
    const { h, fs, spawns } = await rig({ initial: { "/engine/taken.lmp": "x" } });
    await h.call("launch_instance", { record: "m1" });
    const refused = await h.call("relaunch_instance", { record: "taken" });
    expect(refused.content?.[0]?.text).toBe(`${norm("/engine/taken.lmp")} already exists: pick a new record name`);
    expect(h.ctx.registry.has(1)).toBe(true);
    fs.files.set("/engine/m1.lmp", "a");
    h.ctx.io.launchIo.waitForPort = () => Promise.reject(new Error("bridge port never opened"));
    const failed = await h.call("relaunch_instance", { record: "m2" });
    expect(failed.isError).toBe(true);
    expect(failed.content?.[0]?.text).toMatch(sepRe(/^recorded \/engine\/m1\.lmp \(1 bytes\)\nInstance 1 failed to come up/));
    expect(spawns).toHaveLength(2);
  });

  it("reset quits a recording instance before its SIGTERM sweep, so the take is written", async () => {
    const { h, fs } = await rig();
    await h.call("launch_instance", { record: "m1" });
    fs.files.set("/engine/m1.lmp", "abc");
    expect(await h.text("reset")).toBe(`instance 1: recorded ${norm("/engine/m1.lmp")} (3 bytes)\nReset complete. Reaped 0 orphaned engine process(es).`);
    expect(sidecarOf(fs.files, "/engine/m1.json").lmp?.bytes).toBe(3);
  });

  it("reset without an engine configured still finishes a recording", async () => {
    const { h, fs } = await rig();
    await h.call("launch_instance", { record: "m1" });
    fs.files.set("/engine/m1.lmp", "abc");
    (h.ctx.config as { exe?: string }).exe = undefined;
    expect(await h.text("reset")).toBe(
      `instance 1: recorded ${norm("/engine/m1.lmp")} (3 bytes)\nReset tracked instances. (${envName(engine, "EXE")} unset, so no orphan sweep.)`,
    );
  });

  it("starts from a save with -loadgame", async () => {
    const { h, spawns } = await rig({ config: { saveDir: "/saves" }, initial: { "/saves/base.zds": "s" }, engine: { ...engine, demoRecordFromSave: true, loadSaveArgs: (s) => ["-loadgame", s] } });
    await h.call("launch_instance", { save: "base.zds", record: "m6", mouse: false });
    const argv = spawns[0];
    expect(argv.slice(argv.indexOf("-loadgame"), argv.indexOf("-loadgame") + 4)).toEqual(["-loadgame", abs("/saves/base.zds"), "-record", norm("/engine/m6.lmp")]);
    expect(argv[argv.indexOf("use_mouse") + 1]).toBe("0");
  });

  it("refuses save with record on an engine that can't record from a save", async () => {
    bridge = await FakeBridge.start();
    const fs = memFs({ "/saves/base.zds": "s" });
    harness = await startHarness({
      engine: { ...engine, demoRecordFromSave: false },
      config: { exe: "/engine/zandronum", saveDir: "/saves" },
      io: { ...fs.io, existsSync: (p) => p === "/engine/zandronum" || fs.io.existsSync(p), hasBridge: () => true },
    });
    const r = await harness.call("launch_instance", { save: "base.zds", record: "m6" });
    expect(r.content?.[0]?.text).toMatch(/can't record a demo from a savegame/);
  });

  it("names the save dir's env var when a bare save name has nowhere to resolve", async () => {
    const { h } = await rig();
    const r = await h.call("launch_instance", { save: "base.zds" });
    expect(r.content?.[0]?.text).toBe(`save base.zds: give an absolute path, or set ${envName(engine, "SAVE_DIR")}`);
  });
});
