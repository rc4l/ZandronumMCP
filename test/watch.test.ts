import { describe, it, expect } from "vitest";
import {
  runWatch,
  tableOf,
  summarize,
  needsDetail,
  describeWatch,
  DEFAULT_FIELDS,
  DETAIL_FIELDS,
  type Snapshot,
  type WatchPort,
  type WatchOptions,
  type WatchResult,
  type ClassSummary,
} from "../src/sampler/watch.js";
import { STALL_TICS } from "../src/sampler/stepping.js";
import type { KvRecord } from "../src/parsers/lines.js";

const imp = (x: number, extra: KvRecord = {}): KvRecord => ({ class: "DoomImp", tid: 7, hp: 60, x, y: 0, z: 0, sprite: "TROO", frame: "A", ...extra });
const fog = (): KvRecord => ({ class: "TeleportFog", tid: 0, hp: 1000, x: 5, y: 5, z: 0, sprite: "TFOG", frame: "A" });
const snap = (maptime: number, actors: KvRecord[], truncated = false): Snapshot => ({ maptime, actors, truncated });

/** A port replaying `script` after the first snapshot; the last entry repeats. */
function scripted(script: Array<Snapshot | { error: string }>) {
  const steps: number[] = [];
  let i = 0;
  const port: WatchPort = {
    snapshot: async () => script[Math.min(i++, script.length - 1)],
    step: async (n) => {
      steps.push(n);
    },
  };
  return { port, steps };
}

const opts = (o: Partial<WatchOptions> = {}): WatchOptions => ({
  tics: 10,
  everyTics: 2,
  fields: DEFAULT_FIELDS,
  untilGone: false,
  maxRows: 500,
  ...o,
});

const ok = (r: WatchResult | { error: string }): WatchResult => {
  if ("error" in r) throw new Error(r.error);
  return r;
};

describe("runWatch", () => {
  it("samples until tics elapse, dropping repeated maptimes and keeping true ones across gaps", async () => {
    const { port, steps } = scripted([snap(102, [imp(10)]), snap(102, [imp(10)]), snap(105, [imp(30)]), snap(107, [imp(40)]), snap(110, [imp(50)])]);
    const r = ok(await runWatch(port, opts(), snap(100, [imp(0)])));
    expect(r.reason).toBe("done");
    expect(r.tics).toBe(10);
    expect(r.samples).toBe(5);
    expect(r.table.columns).toEqual(["maptime", ...DEFAULT_FIELDS]);
    expect(r.table.rows.map((row) => [row[0], row[4]])).toEqual([[100, 0], [102, 10], [105, 30], [107, 40], [110, 50]]);
    expect(steps).toEqual([2, 2, 2, 2, 2]);
    expect(r.truncatedSamples).toBeUndefined();
    expect(r.rowsDropped).toBeUndefined();
  });

  it("steps only the tics left in the last chunk", async () => {
    const { port, steps } = scripted([snap(3, []), snap(6, []), snap(9, []), snap(10, [])]);
    const r = ok(await runWatch(port, opts({ everyTics: 3 }), snap(0, [])));
    expect(steps).toEqual([3, 3, 3, 1]);
    expect(r.reason).toBe("done");
  });

  it("summarizes an actor that appears and then vanishes, by class", async () => {
    const { port } = scripted([snap(2, [imp(0), fog()]), snap(4, [imp(0), fog(), fog()]), snap(6, [imp(0)]), snap(10, [imp(0)])]);
    const r = ok(await runWatch(port, opts(), snap(0, [imp(0)])));
    expect(r.classes).toEqual([
      { class: "DoomImp", firstSeen: 0, lastSeen: 10, maxCount: 1, samples: 5 },
      { class: "TeleportFog", firstSeen: 2, lastSeen: 4, maxCount: 2, samples: 2 },
    ]);
  });

  it("stops gone with untilGone once matches were seen and the latest snapshot has none", async () => {
    const { port } = scripted([snap(2, [fog()]), snap(4, [fog()]), snap(6, []), snap(8, [fog()])]);
    const r = ok(await runWatch(port, opts({ untilGone: true }), snap(0, [])));
    expect(r.reason).toBe("gone");
    expect(r.tics).toBe(6);
    expect(r.samples).toBe(4);
    expect(r.classes[0]).toMatchObject({ firstSeen: 2, lastSeen: 4 });
    // Without untilGone the same run goes on to the end.
    const again = scripted([snap(2, [fog()]), snap(4, [fog()]), snap(6, []), snap(10, [fog()])]);
    expect(ok(await runWatch(again.port, opts(), snap(0, []))).reason).toBe("done");
  });

  it("waits for a spawn when the watch starts empty", async () => {
    const { port } = scripted([snap(2, []), snap(4, []), snap(10, [])]);
    const r = ok(await runWatch(port, opts({ untilGone: true }), snap(0, [])));
    expect(r.reason).toBe("done");
    expect(r.classes).toEqual([]);
  });

  it("stalls once maptime holds across STALL_TICS of steps, not on one jittery chunk", async () => {
    const { port, steps } = scripted([snap(0, []), snap(3, []), snap(3, []), snap(3, []), snap(3, [])]);
    const r = ok(await runWatch(port, opts({ everyTics: 2 }), snap(0, [])));
    expect(r.reason).toBe("stalled");
    expect(r.tics).toBe(3);
    // One idle chunk, an advance resets the count, then 3 idle chunks (6 >= 5 tics).
    expect(steps).toEqual([2, 2, 2, 2, 2]);
    expect(STALL_TICS).toBe(5);
    const unreadable = scripted([snap(NaN, [])]);
    expect(ok(await runWatch(unreadable.port, opts({ everyTics: 5 }), snap(0, []))).reason).toBe("stalled");
  });

  it("ends as level_change when maptime goes back, keeping the samples before it", async () => {
    const { port } = scripted([snap(4, [imp(0)]), snap(1, []), snap(3, [])]);
    const r = ok(await runWatch(port, opts({ everyTics: 2, tics: 20 }), snap(2, [imp(0)])));
    expect(r.reason).toBe("level_change");
    expect(r.tics).toBe(2);
    expect(r.samples).toBe(2);
  });

  it("tops up Zandronum-short steps, so rows land everyTics apart and the total reaches tics", async () => {
    let t = 100;
    const steps: number[] = [];
    const port: WatchPort = {
      snapshot: async () => snap(t, [imp(t)]),
      step: async (n) => {
        steps.push(n);
        t += Math.max(1, n - 1);
      },
    };
    const r = ok(await runWatch(port, opts({ tics: 70, everyTics: 2 }), snap(t, [imp(t)])));
    expect(r.reason).toBe("done");
    expect(r.tics).toBe(70);
    expect(r.samples).toBe(36);
    expect(r.table.rows.map((row) => row[0])).toEqual(Array.from({ length: 36 }, (_, i) => 100 + 2 * i));
    expect(steps).toEqual(Array.from({ length: 35 }, () => [2, 1]).flat());
  });

  it("returns a snapshot error as is", async () => {
    const { port } = scripted([snap(2, []), { error: "unknown class Foo" }]);
    expect(await runWatch(port, opts(), snap(0, []))).toEqual({ error: "unknown class Foo" });
  });

  it("counts truncated samples", async () => {
    const { port } = scripted([snap(2, [imp(0)], true), snap(4, [imp(0)]), snap(10, [imp(0)], true)]);
    expect(ok(await runWatch(port, opts(), snap(0, [imp(0)], true))).truncatedSamples).toBe(3);
  });

  it("stops adding rows past maxRows while the summary stays exact", async () => {
    const { port } = scripted([snap(2, [imp(0), imp(1)]), snap(4, [imp(0), imp(1)]), snap(10, [imp(0), imp(1)])]);
    const r = ok(await runWatch(port, opts({ maxRows: 3 }), snap(0, [imp(0), imp(1)])));
    expect(r.table.rows).toHaveLength(3);
    expect(r.rowsDropped).toBe(5);
    expect(r.samples).toBe(4);
    expect(r.classes[0]).toMatchObject({ maxCount: 2, samples: 4, lastSeen: 10 });
  });
});

describe("tableOf", () => {
  it("keeps parsed numbers, turns number lists into arrays and a missing key into null", () => {
    const a: KvRecord = { class: "DoomImp", hp: 60, vel: "1.50,-2.00,0.00", args: "0,0,0,0,0", flags: "monster,solid", target: "player0" };
    const b: KvRecord = { class: "TeleportFog", hp: 1000, flags: "" };
    expect(tableOf([a, b], () => [5], ["class", "hp", "vel", "args", "flags", "target", "sprite"])).toEqual([
      [5, "DoomImp", 60, [1.5, -2, 0], [0, 0, 0, 0, 0], "monster,solid", "player0", null],
      [5, "TeleportFog", 1000, null, null, "", null, null],
    ]);
  });

  it("puts the keys neither the head nor the fields show in an overflow cell, null when none are left", () => {
    const rows: KvRecord[] = [
      { t: 3, k: "damage", id: 1, amount: 9, type: "None", hp: 51 },
      { t: 3, k: "sample", id: 1, hp: 51 },
    ];
    expect(tableOf(rows, (r) => [r.t, r.k], ["hp"], ["t", "k", "id"])).toEqual([
      [3, "damage", 51, "amount=9 type=None"],
      [3, "sample", 51, null],
    ]);
  });
});

describe("summarize", () => {
  it("counts each class once per sample", () => {
    const classes = new Map<string, ClassSummary>();
    summarize(classes, 1, [fog(), fog(), imp(0)]);
    summarize(classes, 3, [fog()]);
    expect([...classes.values()]).toEqual([
      { class: "TeleportFog", firstSeen: 1, lastSeen: 3, maxCount: 2, samples: 2 },
      { class: "DoomImp", firstSeen: 1, lastSeen: 1, maxCount: 1, samples: 1 },
    ]);
  });
});

describe("needsDetail", () => {
  it("is true only when a detail-only field is asked for", () => {
    expect(needsDetail(DEFAULT_FIELDS)).toBe(false);
    expect(needsDetail(["x", "dist", "flags", "target"])).toBe(false);
    for (const f of DETAIL_FIELDS) expect(needsDetail(["x", f])).toBe(true);
    expect(DETAIL_FIELDS).toEqual(["master", "tracer", "special", "args", "vel", "radius", "height", "floorz", "player"]);
  });
});

describe("describeWatch", () => {
  const base: WatchResult = {
    reason: "done",
    tics: 70,
    samples: 36,
    table: { columns: ["maptime"], rows: Array.from({ length: 36 }, () => [0]) },
    classes: [{ class: "TeleportFog", firstSeen: 1203, lastSeen: 1274, maxCount: 1, samples: 36 }],
  };

  it("prints a header and one line per class", () => {
    expect(describeWatch("DoomImp tid 7", base)).toBe(
      "watched DoomImp tid 7 for 70 tic(s): 36 samples, 36 rows, done\nTeleportFog: seen 1203..1274 (71 tics), max 1 at once, 36 samples",
    );
  });

  it("names dropped rows and cut samples, and says when nothing matched", () => {
    expect(describeWatch("tid 3", { ...base, classes: [], rowsDropped: 4, truncatedSamples: 2 })).toBe(
      "watched tid 3 for 70 tic(s): 36 samples, 36 rows, done; 4 row(s) dropped past maxRows; 2 sample(s) cut by limit\nno matches seen",
    );
  });
});
