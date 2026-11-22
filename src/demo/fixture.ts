import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { checkpointRowSchema, diffCheckpoints, type Checkpoint, type CheckpointDiff, type CheckpointRow } from "../parsers/checkpoint.js";
import { clockEndText } from "../clock/frames.js";
import { SIDECAR_VERSION, type CheckpointHead, type Sidecar, type SidecarCheckpoints } from "./sidecar.js";

/** What the bless/check loop drives: a demo held frozen at its first tic. */
export interface FixtureDriver {
  /** `mcp_checkpoint`, with rows when asked. */
  checkpoint(rows: boolean): Promise<Checkpoint>;
  /** Exactly `tics` frozen steps: what ran and the clock's end reason (`done`, `demo_end` at the demo's end, or why it stopped short). */
  step(tics: number): Promise<{ ran: number; end: string }>;
  /** The maptime reached, for progress. */
  progress(maptime: number): void;
}

const rowsFileSchema = z.array(z.object({ maptime: z.number(), rows: z.array(checkpointRowSchema) }));

/** One checkpoint's rows in the gzipped rows file, in checkpoint order. */
export type RowsEntry = z.infer<typeof rowsFileSchema>[number];

const headOf = ({ rows: _, ...head }: Checkpoint): CheckpointHead => head;

async function expectAt(driver: FixtureDriver, rows: boolean, maptime: number): Promise<Checkpoint> {
  const cp = await driver.checkpoint(rows);
  if (cp.maptime !== maptime) throw new Error(`checkpoint read maptime ${cp.maptime}, expected ${maptime}`);
  return cp;
}

const stopped = (every: number, end: string) =>
  `stepping stopped within ${every} tic(s): ${clockEndText(end)}${end === "level_change" ? " (a demo fixture must stay on one map)" : ""}`;

/** A bless's checkpoints, before the sidecar stamps them. */
export type BlessedRun = Pick<SidecarCheckpoints, "every" | "start" | "end" | "lastPlayable" | "heads">;

/** Bless checkpoints every `every` tics plus one at the demo's end, throwing if stepping stops short since a fixture covers one map. */
export async function blessDemo(
  driver: FixtureDriver,
  start: number,
  every: number,
): Promise<{ checkpoints: BlessedRun; rows: RowsEntry[] }> {
  const heads: CheckpointHead[] = [];
  const rows: RowsEntry[] = [];
  const take = async (t: number) => {
    const cp = await expectAt(driver, true, t);
    heads.push(headOf(cp));
    rows.push({ maptime: t, rows: cp.rows });
  };
  let t = start;
  for (let end = "done"; end === "done"; ) {
    await take(t);
    const run = await driver.step(every);
    if (run.end !== "done" && run.end !== "demo_end") throw new Error(`after maptime ${t}, ${stopped(every, run.end)}`);
    t += run.ran;
    driver.progress(t);
    end = run.end;
  }
  await take(t);
  return { checkpoints: { every, start, end: t, lastPlayable: t - 1, heads }, rows };
}

export type CheckResult =
  | { inSync: true; checkpoints: number; start: number; end: number }
  /** `lastMatch` equal to `maptime` means the desync shows only after it (stepping stopped). */
  | { inSync: false; maptime: number; lastMatch?: number; why: string };

/** A differing checkpoint in words: the first actor that differs when rows name one, else the fields. */
export function describeDiff(diff: CheckpointDiff): string {
  const row = diff.firstRow;
  if (row?.only) return `actor #${row.i} ${row.class} is ${row.only === "a" ? "gone" : "new"} in the replay`;
  if (row) return `actor #${row.i} ${row.class} differs in ${row.fields.join(", ")}`;
  // The overall hash differs whenever anything does, so it says nothing beside the rest.
  const named = diff.fields.filter((f) => f !== "hash");
  return `checkpoint differs in ${(named.length > 0 ? named : diff.fields).join(", ")}`;
}

/** Check the blessed checkpoints by head hash, comparing rows only at the first that differs and stopping frozen there. */
export async function checkDemo(
  driver: FixtureDriver,
  start: number,
  blessed: SidecarCheckpoints,
  rowsAt: (i: number, maptime: number) => CheckpointRow[] | undefined,
): Promise<CheckResult> {
  if (start !== blessed.start) return { inSync: false, maptime: start, why: `the demo started at maptime ${start}, blessed at ${blessed.start}` };
  const compareAt = async (i: number, t: number): Promise<CheckResult | undefined> => {
    const want = blessed.heads[i]!;
    if (diffCheckpoints({ ...want, rows: [] }, await expectAt(driver, false, t)).equal) return undefined;
    const diff = diffCheckpoints({ ...want, rows: rowsAt(i, t) ?? [] }, await expectAt(driver, true, t));
    return { inSync: false, maptime: t, lastMatch: blessed.heads[i - 1]?.maptime, why: describeDiff(diff) };
  };
  // The last head is the one taken at the demo's end.
  const last = blessed.heads.length - 1;
  let t = start;
  let i = 0;
  for (let end = "done"; end === "done"; i++) {
    if (i >= last) return { inSync: false, maptime: t, lastMatch: blessed.heads[i - 1]?.maptime, why: `still playing past the blessed end, maptime ${blessed.end}` };
    const bad = await compareAt(i, t);
    if (bad) return bad;
    const run = await driver.step(blessed.every);
    if (run.end !== "done" && run.end !== "demo_end") return { inSync: false, maptime: t, lastMatch: t, why: stopped(blessed.every, run.end) };
    t += run.ran;
    driver.progress(t);
    end = run.end;
  }
  if (t !== blessed.end) return { inSync: false, maptime: t, lastMatch: blessed.heads[i - 1]!.maptime, why: `the demo ended at maptime ${t}, blessed at ${blessed.end}` };
  return (await compareAt(last, t)) ?? { inSync: true, checkpoints: last + 1, start, end: t };
}

/** A check result's reply line. */
export function describeCheck(r: CheckResult): string {
  if (r.inSync) return `in sync: ${r.checkpoints} checkpoint(s), maptime ${r.start}..${r.end}`;
  if (r.lastMatch === r.maptime) return `desynced after maptime ${r.maptime}, which matched: ${r.why}`;
  const last = r.lastMatch === undefined ? "no checkpoint matched" : `last match ${r.lastMatch}`;
  return `desynced at maptime ${r.maptime} (${last}): ${r.why}`;
}

export function encodeRows(entries: RowsEntry[]): Buffer {
  return gzipSync(JSON.stringify(entries));
}

/** A rows file's entries, or why it can't be read. */
export function decodeRows(buf: Buffer, file: string): { entries: RowsEntry[] } | { error: string } {
  try {
    const parsed = rowsFileSchema.safeParse(JSON.parse(gunzipSync(buf).toString("utf8")));
    if (!parsed.success) return { error: `${file} is not a checkpoint rows file` };
    return { entries: parsed.data };
  } catch (e) {
    return { error: `${file} can't be read: ${(e as Error).message}` };
  }
}

/** The rows of checkpoint `i` from a decoded rows file, or why there are none. */
export function rowsForCheckpoint(decoded: { entries: RowsEntry[] } | { error: string }, file: string, i: number, maptime: number): { rows: CheckpointRow[] } | { note: string } {
  if ("error" in decoded) return { note: `(no actor rows: ${decoded.error})` };
  // Matched by maptime too, so a rows file from another bless can't name the wrong actor.
  const entry = decoded.entries[i];
  return entry?.maptime === maptime ? { rows: entry.rows } : { note: `(no actor rows: ${file} doesn't match the sidecar)` };
}

/** What a bless adds to a sidecar beside its run: when, the baseline files and the rows file's name. */
export interface BlessStamp {
  at: string;
  lmp: NonNullable<Sidecar["lmp"]>;
  files: Sidecar["files"];
  rows: string;
}

/** A blessed demo's sidecar: `base` with the take named (when it had none) and the run's checkpoints stamped. */
export function blessedSidecar(base: Sidecar, run: BlessedRun, stamp: BlessStamp): Sidecar & { checkpoints: SidecarCheckpoints } {
  const checkpoints = { ...run, blessedAt: stamp.at, lmpSha1: stamp.lmp.sha1, files: stamp.files, rows: stamp.rows };
  return { ...base, lmp: base.lmp ?? stamp.lmp, checkpoints };
}

/** A sidecar for a demo that had none, so a bless has somewhere to go: what the instance ran, nothing recorded. */
export function minimalSidecar(engine: string, bridge: string | undefined, lmp: NonNullable<Sidecar["lmp"]>, current: Sidecar | undefined): Sidecar {
  // The launch's map, skill and save describe the instance, not this take.
  return {
    version: SIDECAR_VERSION,
    engine,
    bridge: bridge ?? null,
    recordedAt: null,
    lmp,
    iwad: current?.iwad ?? null,
    files: current?.files ?? [],
    map: null,
    skill: null,
    save: null,
  };
}
