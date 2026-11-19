import { describe, it, expect } from "vitest";
import { capNote, pollArmedRun, stepWithin, stallTracker, STALL_TICS, ARMED_STALL_MS, type ChunkMove, type StepWithinOptions } from "../src/sampler/stepping.js";

/** An engine whose step of n moves maptime `advance(n)`; each read returns the maptime as its value. */
function engine(advance: (n: number) => number, t = 100) {
  const steps: number[] = [];
  const opts = (o: Partial<StepWithinOptions<number>> = {}): StepWithinOptions<number> => ({
    budget: 10,
    chunkTics: 2,
    first: { value: t, maptime: t },
    step: async (n) => {
      steps.push(n);
      t += advance(n);
    },
    read: async () => ({ value: t, maptime: t }),
    done: () => false,
    levelChange: "stop",
    ...o,
  });
  return { opts, steps };
}

/** Reads return `times` in turn (the last repeats), each with its index as the value. */
function scripted(times: number[]) {
  let i = 0;
  const steps: number[] = [];
  const opts = (o: Partial<StepWithinOptions<number>> = {}): StepWithinOptions<number> => ({
    budget: 10,
    chunkTics: 2,
    first: { value: -1, maptime: 100 },
    step: async (n) => void steps.push(n),
    read: async () => {
      const at = Math.min(i++, times.length - 1);
      return { value: at, maptime: times[at] };
    },
    done: () => false,
    levelChange: "stop",
    ...o,
  });
  return { opts, steps };
}

const zandronum = (n: number) => Math.max(1, n - 1);

describe("stepWithin", () => {
  it("tops up short steps until the budget is met in measured tics", async () => {
    const { opts, steps } = engine(zandronum);
    const r = await stepWithin(opts({ budget: 35 }));
    expect(r).toEqual({ value: 135, elapsed: 35, maptime: 135, end: "budget" });
    expect(steps).toEqual([...Array(34).fill(2), 1]);
  });

  it("runs exact steps in chunks, the last one short", async () => {
    const { opts, steps } = engine((n) => n);
    const r = await stepWithin(opts({ budget: 12, chunkTics: 5 }));
    expect(r).toMatchObject({ elapsed: 12, end: "budget" });
    expect(steps).toEqual([5, 5, 2]);
  });

  it("reports an overshoot as measured, never clamped", async () => {
    const { opts, steps } = engine((n) => n + 1);
    const r = await stepWithin(opts({ budget: 5, chunkTics: 2 }));
    expect(r).toMatchObject({ elapsed: 6, maptime: 106, end: "budget" });
    expect(steps).toEqual([2, 2]);
  });

  it("ends done without stepping when the first read already is, and on the read that is", async () => {
    const { opts, steps } = engine((n) => n);
    expect(await stepWithin(opts({ done: () => true }))).toEqual({ value: 100, elapsed: 0, maptime: 100, end: "done" });
    expect(steps).toEqual([]);
    const r = await stepWithin(opts({ done: (v) => v >= 104 }));
    expect(r).toEqual({ value: 104, elapsed: 4, maptime: 104, end: "done" });
  });

  it("stops on an error value, even on a chunk that stalled or changed the level", async () => {
    type V = number | { error: string };
    const err = { error: "no level" };
    const base = { budget: 10, chunkTics: 5, first: { value: 0 as V, maptime: 100 }, step: async () => {}, levelChange: "stop" as const };
    const done = (v: V) => typeof v !== "number";
    const stalled = await stepWithin<V>({ ...base, read: async () => ({ value: err, maptime: NaN }), done });
    expect(stalled).toMatchObject({ value: err, end: "done", elapsed: 0 });
    const back = await stepWithin<V>({ ...base, read: async () => ({ value: err, maptime: 3 }), done });
    expect(back).toMatchObject({ value: err, end: "done" });
  });

  it("rides out an idle chunk, then stalls once STALL_TICS of steps pass without an advance", async () => {
    const { opts, steps } = scripted([100, 101, 101, 101, 101]);
    const r = await stepWithin(opts());
    // idle 2, advance resets, then idle 2, 4, 6 >= 5.
    expect(r).toEqual({ value: 4, elapsed: 1, maptime: 101, end: "stalled" });
    expect(steps).toEqual([2, 2, 2, 2, 2]);
    expect(STALL_TICS).toBe(5);
    // A 1-tic top-up that lands nothing is idle, not a stall on its own.
    const topUp = scripted([109, 109, 110]);
    expect(await stepWithin(topUp.opts())).toMatchObject({ elapsed: 10, end: "budget" });
    expect(topUp.steps).toEqual([2, 1, 1]);
  });

  it("treats an unreadable maptime as idle", async () => {
    const { opts } = scripted([NaN]);
    expect(await stepWithin(opts({ chunkTics: 5 }))).toMatchObject({ elapsed: 0, end: "stalled" });
  });

  it("stops at a maptime that went back, or counts the new map's tics", async () => {
    const stop = scripted([102, 3, 5]);
    expect(await stepWithin(stop.opts())).toEqual({ value: 1, elapsed: 2, maptime: 102, end: "level_change" });
    const count = scripted([102, 3, 5, 10]);
    // 2 tics, then the new map's 3, 2 and 5: the last chunk overshoots to 12.
    expect(await stepWithin(count.opts({ levelChange: "count" }))).toEqual({ value: 3, elapsed: 12, maptime: 10, end: "budget" });
  });

  it("calls onChunk with each move and value before done is checked", async () => {
    const seen: Array<[ChunkMove, number]> = [];
    const order: string[] = [];
    const { opts } = scripted([102, 102, 1, 4]);
    const r = await stepWithin(
      opts({
        levelChange: "count",
        onChunk: (move, v) => (seen.push([move, v]), order.push("chunk")),
        done: (v) => (order.push("done"), v === 3),
      }),
    );
    expect(seen).toEqual([["advanced", 0], ["idle", 1], ["level_change", 2], ["advanced", 3]]);
    expect(order).toEqual(["done", ...Array(4).fill(["chunk", "done"]).flat()]);
    expect(r).toMatchObject({ elapsed: 2 + 1 + 3, end: "done" });
  });

  it("carries idle tics across calls through a shared tracker", async () => {
    const track = stallTracker();
    const first = scripted([100]);
    expect(await stepWithin(first.opts({ budget: 3, chunkTics: 3, track, done: (v) => v === 0 }))).toMatchObject({ end: "done", elapsed: 0 });
    // 3 idle tics carried over plus 3 more reach STALL_TICS on the first chunk.
    const second = scripted([100]);
    expect(await stepWithin(second.opts({ budget: 3, chunkTics: 3, track }))).toMatchObject({ end: "stalled" });
    expect(second.steps).toEqual([3]);
  });

  it("ends as budget at the iteration cap, with the measured shortfall", async () => {
    // One tic every third chunk: two idle chunks (4 < 5 tics) between advances never stall.
    const times = Array.from({ length: 60 }, (_, i) => 100 + Math.floor((i + 1) / 3));
    const { opts, steps } = scripted(times);
    const r = await stepWithin(opts({ budget: 20 }));
    expect(steps).toHaveLength(2 * 20 + STALL_TICS);
    expect(r).toMatchObject({ end: "budget", elapsed: 15 });
    expect(capNote(r, 20)).toEqual([expect.stringMatching(/^stopped after 15 of 20 tic\(s\): the iteration cap was hit/)]);
  });
});

describe("capNote", () => {
  it("notes only a budget end that fell short of the budget", () => {
    expect(capNote({ end: "budget", elapsed: 20 }, 20)).toEqual([]);
    expect(capNote({ end: "budget", elapsed: 21 }, 20)).toEqual([]);
    for (const end of ["done", "stalled", "level_change"] as const) expect(capNote({ end, elapsed: 3 }, 20)).toEqual([]);
  });
});

describe("stallTracker", () => {
  it("classifies advances, level changes, idle and stalls", () => {
    const t = stallTracker();
    expect(t(10, 12, 2)).toBe("advanced");
    expect(t(12, 3, 2)).toBe("level_change");
    expect(t(3, 3, 4)).toBe("idle");
    expect(t(3, NaN, 1)).toBe("stalled");
  });
});

describe("pollArmedRun", () => {
  /** Reads `ran` in turn (the last repeats), active until `endAt`; records each sleep. */
  function armed(ran: number[], endAt = Infinity) {
    const sleeps: number[] = [];
    let i = 0;
    const read = async () => {
      const r = ran[Math.min(i++, ran.length - 1)];
      return { ran: r, active: r < endAt };
    };
    return { read, sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
  }

  it("waits out the nominal time in chunks, then polls until the run ends", async () => {
    const a = armed([10, 35, 70], 70);
    const s = await pollArmedRun(a.read, (r) => r.ran, { tics: 70, runMs: 2000, sleep: a.sleep });
    expect(s).toEqual({ ran: 70, active: false });
    expect(a.sleeps).toEqual([1000, 1000, 100]);
  });

  it("returns still active once progress sits still for the stall time", async () => {
    const a = armed([5]);
    const s = await pollArmedRun(a.read, (r) => r.ran, { tics: 10, runMs: 0, sleep: a.sleep });
    expect(s.active).toBe(true);
    expect(a.sleeps.slice(1).reduce((x, y) => x + y, 0)).toBe(ARMED_STALL_MS);
  });
});
