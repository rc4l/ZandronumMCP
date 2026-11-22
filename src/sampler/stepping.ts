/** The chunked tools' tic budget in measured map tics, since `step N` can run short and a short step is topped up. */

import { pollUntil } from "../poll.js";

/** Map tics without an advance that count as a stall: step_until's default chunk. */
export const STALL_TICS = 5;

/** How one stepped chunk moved the map tic counter; level_change when it went back (a new or restarted map). */
export type ChunkMove = "advanced" | "level_change" | "idle" | "stalled";

export type StallTracker = (before: number, after: number, n: number) => ChunkMove;

/** A chunked tool's stall check, needing STALL_TICS of steps without an advance so one jittery chunk isn't a stall. */
export function stallTracker(): StallTracker {
  let idle = 0;
  return (before, after, n) => {
    if (!(after > before) && !(after < before)) {
      idle += n;
      return idle >= STALL_TICS ? "stalled" : "idle";
    }
    idle = 0;
    return after > before ? "advanced" : "level_change";
  };
}

/** A read and the maptime its own status line reported (NaN when unreadable). */
export interface Reading<T> {
  value: T;
  maptime: number;
}

export interface StepWithinOptions<T> {
  /** Map tics to run, measured. */
  budget: number;
  /** The most one step asks for. */
  chunkTics: number;
  /** The read taken before any step. */
  first: Reading<T>;
  step(n: number): Promise<unknown>;
  /** Read after each step; run serially, never beside `step`. */
  read(): Promise<Reading<T>>;
  /** Stop early on a met condition or an error value, checked before the chunk's stall or level change. */
  done(value: T): boolean;
  /** stop ends at a maptime that went back; count keeps going and counts the new map's tics. */
  levelChange: "stop" | "count";
  /** A tracker shared across calls, so idle chunks add up across them. */
  track?: StallTracker;
  /** Runs after each chunk is classified and counted, before `done`. */
  onChunk?(move: ChunkMove, value: T): void;
}

export interface StepWithinResult<T> {
  /** The last read's value. */
  value: T;
  /** Measured map tics; a step that moved more than asked shows here as an overshoot. */
  elapsed: number;
  /** The last counted maptime: `first`'s, or the latest one that advanced or changed the level. */
  maptime: number;
  /** budget also covers the iteration cap, where elapsed can fall short. */
  end: "done" | "budget" | "stalled" | "level_change";
}

/** Step in chunks of at most chunkTics until `done`, a stall, a level change (stop) or `budget` measured map tics. */
export async function stepWithin<T>(o: StepWithinOptions<T>): Promise<StepWithinResult<T>> {
  const track = o.track ?? stallTracker();
  let { value, maptime: at } = o.first;
  let elapsed = 0;
  const result = (end: StepWithinResult<T>["end"]) => ({ value, elapsed, maptime: at, end });
  if (o.done(value)) return result("done");
  // Each chunk advances or adds idle, so this cap only bounds an engine that barely moves.
  for (let i = 0; i < 2 * o.budget + STALL_TICS && elapsed < o.budget; i++) {
    const n = Math.min(o.chunkTics, o.budget - elapsed);
    await o.step(n);
    const got = await o.read();
    value = got.value;
    const move = track(at, got.maptime, n);
    const counted = move === "advanced" || (move === "level_change" && o.levelChange === "count");
    if (counted) {
      // A map change restarts maptime: this chunk adds the new map's tics, beside the old map's already counted.
      elapsed += move === "advanced" ? got.maptime - at : got.maptime;
      at = got.maptime;
    }
    o.onChunk?.(move, value);
    if (o.done(value)) return result("done");
    if (move === "stalled" || (move === "level_change" && !counted)) return result(move);
  }
  return result("budget");
}

// An armed engine run (input_timeline, record) is polled about once a second through its nominal
// time, then every 100 ms; ~1 s without a tic is a stall.
export const ARMED_CHUNK_MS = 1000;
export const ARMED_POLL_MS = 100;
export const ARMED_STALL_MS = 1000;

/** Poll an armed engine run until inactive or `progress` stalls, returning the last status (still active means stalled). */
export async function pollArmedRun<S extends { active: boolean }>(
  read: () => Promise<S>,
  progress: (s: S) => number,
  run: { tics: number; runMs: number; sleep: (ms: number) => Promise<void> },
): Promise<S> {
  let seen = -1;
  let idleMs = 0;
  let waited = 0;
  let lastWait = 0;
  const wait = async () => {
    lastWait = waited < run.runMs ? Math.min(ARMED_CHUNK_MS, run.runMs - waited) : ARMED_POLL_MS;
    waited += lastWait;
    await run.sleep(lastWait);
  };
  const poll = async () => {
    const s = await read();
    idleMs = progress(s) > seen ? 0 : idleMs + lastWait;
    seen = progress(s);
    return s;
  };
  await wait();
  const polled = await pollUntil(poll, (s) => !s.active || idleMs >= ARMED_STALL_MS, {
    waits: Math.ceil(run.runMs / ARMED_CHUNK_MS) + run.tics + ARMED_STALL_MS / ARMED_POLL_MS,
    wait,
  });
  return polled.value;
}

/** The reply note for a budget end short of `budget` (only the iteration cap ends one there), else none. */
export function capNote(r: Pick<StepWithinResult<unknown>, "end" | "elapsed">, budget: number): string[] {
  if (r.end !== "budget" || r.elapsed >= budget) return [];
  return [`stopped after ${r.elapsed} of ${budget} tic(s): the iteration cap was hit (the map tic counter kept stuttering)`];
}
