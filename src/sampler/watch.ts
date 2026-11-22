/** watch_actors' sampling loop, behind a port so tests can script its snapshots. */
import type { KvRecord } from "../parsers/lines.js";
import { stallTracker, stepWithin } from "./stepping.js";

/** Every key a `findactors` row can carry (mcp_actorstate.cpp), detail-only ones last. */
export const FIELDS = [
  "class", "tid", "hp", "spawnhp", "x", "y", "z", "angle", "pitch", "dist", "sprite", "frame", "flags", "target",
  "master", "tracer", "special", "args", "vel", "radius", "height", "floorz", "player",
] as const;
export type Field = (typeof FIELDS)[number];
/** The keys `findactors` prints only with `detail=1`. */
export const DETAIL_FIELDS: readonly Field[] = FIELDS.slice(FIELDS.indexOf("master"));
export const DEFAULT_FIELDS: readonly Field[] = ["class", "tid", "hp", "x", "y", "z", "sprite", "frame"];

export interface Snapshot {
  /** The map tic the snapshot's own status line reported; NaN when unreadable. */
  maptime: number;
  actors: KvRecord[];
  truncated: boolean;
}

export interface WatchPort {
  snapshot(): Promise<Snapshot | { error: string }>;
  /** Run the sim about `n` tics, then leave it paused. */
  step(n: number): Promise<unknown>;
}

export interface WatchOptions {
  tics: number;
  everyTics: number;
  fields: readonly Field[];
  untilGone: boolean;
  maxRows: number;
}

export type Cell = string | number | number[] | null;

export interface ClassSummary {
  class: string;
  firstSeen: number;
  lastSeen: number;
  maxCount: number;
  samples: number;
}

export interface WatchResult {
  reason: "done" | "gone" | "level_change" | "stalled";
  /** Map tics between the first and the last sample. */
  tics: number;
  samples: number;
  table: { columns: string[]; rows: Cell[][] };
  classes: ClassSummary[];
  truncatedSamples?: number;
  rowsDropped?: number;
}

/** Whether any of `fields` needs `findactors detail=1`. */
export function needsDetail(fields: readonly Field[]): boolean {
  return fields.some((f) => DETAIL_FIELDS.includes(f));
}

const NUMBER_LIST = /^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?)+$/;

/** A row cell: a missing key is null, a comma list of numbers (vel, args) a number array. */
function cell(v: string | number | undefined): Cell {
  if (v === undefined) return null;
  return typeof v === "string" && NUMBER_LIST.test(v) ? v.split(",").map(Number) : v;
}

/** One fixed-width row per record, where `overflow` (the keys `head` shows) adds a last cell of every other key as `k=v` text. */
export function tableOf(
  records: KvRecord[],
  head: (r: KvRecord) => Cell[],
  fields: readonly string[],
  overflow?: readonly string[],
): Cell[][] {
  return records.map((r) => {
    const row = [...head(r), ...fields.map((f) => cell(r[f]))];
    if (!overflow) return row;
    const rest = Object.entries(r).filter(([k]) => !overflow.includes(k) && !fields.includes(k));
    return [...row, rest.length ? rest.map(([k, v]) => `${k}=${v}`).join(" ") : null];
  });
}

/** Fold one sample into the per-class summary. */
export function summarize(classes: Map<string, ClassSummary>, maptime: number, actors: KvRecord[]): void {
  const counts = new Map<string, number>();
  for (const a of actors) counts.set(String(a.class), (counts.get(String(a.class)) ?? 0) + 1);
  for (const [name, count] of counts) {
    const c = classes.get(name);
    if (!c) {
      classes.set(name, { class: name, firstSeen: maptime, lastSeen: maptime, maxCount: count, samples: 1 });
      continue;
    }
    c.lastSeen = maptime;
    c.maxCount = Math.max(c.maxCount, count);
    c.samples++;
  }
}

/** Sample every `everyTics` measured map tics until `tics` pass, a stall, a level change or (untilGone) every match is gone. */
export async function runWatch(port: WatchPort, opts: WatchOptions, first: Snapshot): Promise<WatchResult | { error: string }> {
  const start = first.maptime;
  const rows: Cell[][] = [];
  const classes = new Map<string, ClassSummary>();
  let samples = 0;
  let truncatedSamples = 0;
  let rowsDropped = 0;
  let seen = false;
  let last = start;
  const take = (s: Snapshot) => {
    samples++;
    if (s.truncated) truncatedSamples++;
    const got = tableOf(s.actors, () => [s.maptime], opts.fields);
    const room = Math.max(0, opts.maxRows - rows.length);
    rows.push(...got.slice(0, room));
    rowsDropped += got.length - Math.min(room, got.length);
    summarize(classes, s.maptime, s.actors);
    if (s.actors.length) seen = true;
    last = s.maptime;
  };
  const finish = (reason: WatchResult["reason"]): WatchResult => ({
    reason,
    tics: last - start,
    samples,
    table: { columns: ["maptime", ...opts.fields], rows },
    classes: [...classes.values()],
    ...(truncatedSamples ? { truncatedSamples } : {}),
    ...(rowsDropped ? { rowsDropped } : {}),
  });

  take(first);
  const track = stallTracker();
  const read = async () => {
    const value = await port.snapshot();
    return { value, maptime: "error" in value ? NaN : value.maptime };
  };
  while (last - start < opts.tics) {
    // The budget is at least 1, so the value is always a fresh snapshot.
    const r = await stepWithin<Snapshot | { error: string }>({
      budget: Math.min(opts.everyTics, opts.tics - (last - start)),
      chunkTics: opts.everyTics,
      first: { value: first, maptime: last },
      step: (n) => port.step(n),
      read,
      done: (s) => "error" in s,
      levelChange: "stop",
      track,
    });
    const s = r.value;
    if ("error" in s) return s;
    if (r.end === "stalled" || r.end === "level_change") return finish(r.end);
    take(s);
    if (opts.untilGone && seen && s.actors.length === 0) return finish("gone");
  }
  return finish("done");
}

/** The text reply: a header line, then one line per class seen. */
export function describeWatch(target: string, r: WatchResult): string {
  const extra = [
    ...(r.rowsDropped ? [`${r.rowsDropped} row(s) dropped past maxRows`] : []),
    ...(r.truncatedSamples ? [`${r.truncatedSamples} sample(s) cut by limit`] : []),
  ];
  const head = `watched ${target} for ${r.tics} tic(s): ${r.samples} samples, ${r.table.rows.length} rows, ${r.reason}`;
  const lines = r.classes.map(
    (c) =>
      `${c.class}: seen ${c.firstSeen}..${c.lastSeen} (${c.lastSeen - c.firstSeen} tics), max ${c.maxCount} at once, ${c.samples} samples`,
  );
  return [[head, ...extra].join("; "), ...(lines.length ? lines : ["no matches seen"])].join("\n");
}
