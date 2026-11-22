import { describe, it, expect } from "vitest";
import { gzipSync } from "node:zlib";
import {
  blessDemo,
  blessedSidecar,
  checkDemo,
  decodeRows,
  describeCheck,
  describeDiff,
  encodeRows,
  minimalSidecar,
  rowsForCheckpoint,
  type FixtureDriver,
} from "../src/demo/fixture.js";
import { CHECKPOINT_GROUPS, type Checkpoint, type CheckpointRow } from "../src/parsers/checkpoint.js";
import type { Sidecar, SidecarCheckpoints } from "../src/demo/sidecar.js";

const row = (i: number, cls: string, x: string): CheckpointRow => ({
  i, class: cls, h: `h${x}`, x, y: "0", z: "0", vx: "0", vy: "0", vz: "0", angle: "0", pitch: "0", health: 100, tics: 1, sprite: "POSS", frame: "A",
});

/** A playsim whose digest is a function of maptime, with an optional skew from some maptime on. */
interface World {
  end: number;
  /** From this maptime, actor #1's x differs ("row"), or only the inventory group ("group"). */
  skew?: { from: number; kind: "row" | "group" };
  /** Read a checkpoint at a maptime other than the clock's. */
  misread?: boolean;
  /** Stepping past this maptime stops short there with this reason (a level change). */
  stop?: { at: number; end: string };
}

function checkpointAt(t: number, w: World): Checkpoint {
  const off = w.skew !== undefined && t >= w.skew.from;
  const x = off && w.skew!.kind === "row" ? "bad" : `x${t}`;
  const groups = Object.fromEntries(CHECKPOINT_GROUPS.map((g) => [g, `${g}${t}`])) as Checkpoint["groups"];
  if (off) groups[w.skew!.kind === "row" ? "pos" : "inv"] = "skewed";
  return { maptime: w.misread ? t + 1 : t, actors: 2, rng: `r${t}`, hash: `${x}${groups.inv}`, groups, rows: [row(0, "DoomPlayer", `p${t}`), row(1, "Zombieman", x)] };
}

function driverFor(w: World, start: number) {
  const calls: string[] = [];
  const seen: number[] = [];
  let t = start;
  const driver: FixtureDriver = {
    checkpoint: (rows) => {
      calls.push(rows ? "rows" : "head");
      const cp = checkpointAt(t, w);
      return Promise.resolve(rows ? cp : { ...cp, rows: [] });
    },
    step: (n) => {
      calls.push(`step ${n}`);
      if (w.stop && t + n > w.stop.at) {
        const ran = w.stop.at - t;
        t = w.stop.at;
        return Promise.resolve({ ran, end: w.stop.end });
      }
      const ran = Math.min(n, w.end - t);
      t += ran;
      return Promise.resolve({ ran, end: t >= w.end ? "demo_end" : "done" });
    },
    progress: (m) => void seen.push(m),
  };
  return { driver, calls, seen };
}

async function blessed(w: World, start = 1, every = 35) {
  const run = await blessDemo(driverFor(w, start).driver, start, every);
  const cps: SidecarCheckpoints = { ...run.checkpoints, blessedAt: "t", lmpSha1: "l", files: [], rows: "r" };
  return { cps, rows: run.rows };
}

describe("blessDemo", () => {
  it("checkpoints with rows at the start, every interval and the demo's end", async () => {
    const { driver, calls, seen } = driverFor({ end: 80 }, 1);
    const run = await blessDemo(driver, 1, 35);
    expect(run.checkpoints).toMatchObject({ every: 35, start: 1, end: 80, lastPlayable: 79 });
    expect(run.checkpoints.heads.map((h) => h.maptime)).toEqual([1, 36, 71, 80]);
    expect(run.checkpoints.heads[0]).not.toHaveProperty("rows");
    expect(run.rows.map((r) => [r.maptime, r.rows.length])).toEqual([[1, 2], [36, 2], [71, 2], [80, 2]]);
    expect(calls).toEqual(["rows", "step 35", "rows", "step 35", "rows", "step 35", "rows"]);
    expect(seen).toEqual([36, 71, 80]);
  });

  it("refuses a demo whose stepping stops short, naming the one-map limit on a level change", async () => {
    await expect(blessDemo(driverFor({ end: 200, stop: { at: 50, end: "level_change" } }, 1).driver, 1, 35)).rejects.toThrow(
      /^after maptime 36, stepping stopped within 35 tic\(s\): .*\(a demo fixture must stay on one map\)$/,
    );
    await expect(blessDemo(driverFor({ end: 200, stop: { at: 50, end: "stalled" } }, 1).driver, 1, 35)).rejects.toThrow(/stopped within 35 tic\(s\): [^(]*$/);
  });

  it("fails on a checkpoint read at another maptime", async () => {
    await expect(blessDemo(driverFor({ end: 80, misread: true }, 1).driver, 1, 35)).rejects.toThrow("checkpoint read maptime 2, expected 1");
  });
});

describe("checkDemo", () => {
  const check = async (w: World, cps: SidecarCheckpoints, rows: { rows: CheckpointRow[] }[] | undefined, start = 1) => {
    const d = driverFor(w, start);
    const asked: number[] = [];
    const result = await checkDemo(d.driver, start, cps, (i, maptime) => (asked.push(maptime), rows?.[i]?.rows));
    return { result, calls: d.calls, asked };
  };

  it("is in sync on the same world, comparing heads only", async () => {
    const { cps, rows } = await blessed({ end: 80 });
    const { result, calls } = await check({ end: 80 }, cps, rows);
    expect(result).toEqual({ inSync: true, checkpoints: 4, start: 1, end: 80 });
    expect(calls.filter((c) => c === "rows")).toEqual([]);
    expect(describeCheck(result)).toBe("in sync: 4 checkpoint(s), maptime 1..80");
  });

  it("names the first differing actor from the blessed rows, and stops there", async () => {
    const { cps, rows } = await blessed({ end: 200 });
    const { result, calls, asked } = await check({ end: 200, skew: { from: 50, kind: "row" } }, cps, rows);
    expect(result).toEqual({ inSync: false, maptime: 71, lastMatch: 36, why: "actor #1 Zombieman differs in x" });
    expect(calls.slice(-2)).toEqual(["head", "rows"]);
    expect(asked).toEqual([71]);
    expect(describeCheck(result)).toBe("desynced at maptime 71 (last match 36): actor #1 Zombieman differs in x");
  });

  it("falls back to the checkpoint fields when no row differs or the rows are missing", async () => {
    const { cps, rows } = await blessed({ end: 200 });
    const group = await check({ end: 200, skew: { from: 1, kind: "group" } }, cps, rows);
    expect(group.result).toMatchObject({ maptime: 1, why: "checkpoint differs in inv" });
    expect(describeCheck(group.result)).toBe("desynced at maptime 1 (no checkpoint matched): checkpoint differs in inv");
    const noRows = await check({ end: 200, skew: { from: 50, kind: "row" } }, cps, undefined);
    expect(noRows.result).toMatchObject({ why: "checkpoint differs in pos" });
  });

  it("is a desync when the start or end moves, or the demo plays past the blessed end", async () => {
    const { cps, rows } = await blessed({ end: 80 });
    expect((await check({ end: 80 }, cps, rows, 2)).result).toEqual({ inSync: false, maptime: 2, why: "the demo started at maptime 2, blessed at 1" });
    expect((await check({ end: 60 }, cps, rows)).result).toEqual({ inSync: false, maptime: 60, lastMatch: 36, why: "the demo ended at maptime 60, blessed at 80" });
    expect((await check({ end: 200 }, cps, rows)).result).toEqual({ inSync: false, maptime: 106, lastMatch: 71, why: "still playing past the blessed end, maptime 80" });
  });

  it("compares the head at the demo's end, so the tail after the last interval counts", async () => {
    const { cps, rows } = await blessed({ end: 80 });
    expect((await check({ end: 80, skew: { from: 75, kind: "row" } }, cps, rows)).result).toEqual({
      inSync: false, maptime: 80, lastMatch: 71, why: "actor #1 Zombieman differs in x",
    });
  });

  it("is a desync after the last match when stepping stops short", async () => {
    const { cps, rows } = await blessed({ end: 200 });
    const { result } = await check({ end: 200, stop: { at: 50, end: "level_change" } }, cps, rows);
    expect(result).toMatchObject({ inSync: false, maptime: 36, lastMatch: 36 });
    expect(describeCheck(result)).toMatch(/^desynced after maptime 36, which matched: stepping stopped within 35 tic\(s\): .*one map\)$/);
  });
});

describe("describeDiff", () => {
  it("leaves out the overall hash unless it is all that differs", () => {
    expect(describeDiff({ equal: false, fields: ["rng", "hash", "state"] })).toBe("checkpoint differs in rng, state");
    expect(describeDiff({ equal: false, fields: ["hash"] })).toBe("checkpoint differs in hash");
  });

  it("says which side an actor is missing from", () => {
    const only = (side: "a" | "b") => describeDiff({ equal: false, fields: ["actors"], firstRow: { i: 9, class: "DoomImp", fields: ["missing"], only: side } });
    expect(only("a")).toBe("actor #9 DoomImp is gone in the replay");
    expect(only("b")).toBe("actor #9 DoomImp is new in the replay");
  });
});

describe("rows file", () => {
  it("round-trips through gzip, and says why a bad one can't be read", () => {
    const entries = [{ maptime: 1, rows: [row(0, "DoomPlayer", "p")] }];
    expect(decodeRows(encodeRows(entries), "f")).toEqual({ entries });
    expect(decodeRows(gzipSync('{"a":1}'), "f")).toEqual({ error: "f is not a checkpoint rows file" });
    expect(decodeRows(Buffer.from("plain"), "f")).toEqual({ error: expect.stringMatching(/^f can't be read: /) });
  });
});

describe("rowsForCheckpoint", () => {
  const entries = [{ maptime: 5, rows: [row(0, "DoomPlayer", "p")] }];

  it("gives a checkpoint's rows only when its maptime matches, else a note", () => {
    expect(rowsForCheckpoint({ entries }, "f", 0, 5)).toEqual({ rows: entries[0].rows });
    expect(rowsForCheckpoint({ entries }, "f", 0, 6)).toEqual({ note: "(no actor rows: f doesn't match the sidecar)" });
    expect(rowsForCheckpoint({ entries }, "f", 1, 5)).toEqual({ note: "(no actor rows: f doesn't match the sidecar)" });
    expect(rowsForCheckpoint({ error: "f is missing" }, "f", 0, 5)).toEqual({ note: "(no actor rows: f is missing)" });
  });
});

describe("blessedSidecar", () => {
  const lmp = { file: "d.lmp", bytes: 3, sha1: "s" };
  const run = { every: 35, start: 1, end: 71, lastPlayable: 70, heads: [] };
  const stamp = { at: "2026-11-13T00:00:00.000Z", lmp, files: [{ path: "/m", sha1: "m" }], rows: "d.rows.json.gz" };

  it("stamps the run and keeps the base's own take, naming it only when the base has none", () => {
    const base = minimalSidecar("zandronum", undefined, { ...lmp, sha1: "old" }, undefined);
    const got = blessedSidecar(base, run, stamp);
    expect(got.checkpoints).toEqual({ ...run, blessedAt: stamp.at, lmpSha1: "s", files: stamp.files, rows: "d.rows.json.gz" });
    expect(got.lmp).toEqual({ ...lmp, sha1: "old" });
    expect(blessedSidecar({ ...base, lmp: null }, run, stamp).lmp).toEqual(lmp);
  });
});

describe("minimalSidecar", () => {
  const lmp = { file: "d.lmp", bytes: 3, sha1: "s" };

  it("takes the instance's iwad and files but not its map, skill or save", () => {
    const current = { iwad: { path: "/w", sha1: "i" }, files: [{ path: "/m", sha1: "m" }], map: "MAP01", skill: 3, save: { path: "/s", sha1: "x" } } as Sidecar;
    expect(minimalSidecar("zandronum", "0.16.0", lmp, current)).toEqual({
      version: 1, engine: "zandronum", bridge: "0.16.0", recordedAt: null, lmp,
      iwad: { path: "/w", sha1: "i" }, files: [{ path: "/m", sha1: "m" }], map: null, skill: null, save: null,
    });
  });

  it("has no iwad or files for an attached instance", () => {
    expect(minimalSidecar("uzdoom", undefined, lmp, undefined)).toMatchObject({ bridge: null, iwad: null, files: [] });
  });
});
