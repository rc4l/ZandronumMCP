/** The `record` tools' pure half: option checks, the `mcp_rec` schedule and the dump's reply (format: PROTOCOL.md, mcp_rec). */
import { command, isPlainToken, kvArgs } from "../commands/builders.js";
import type { KvRecord } from "../parsers/lines.js";
import type { RecFile } from "../parsers/rec.js";
import { FIELDS, tableOf, type Cell, type Field } from "../sampler/watch.js";
import { PROBE_EXPR, type MapSlot } from "../acs/probe.js";
import { bitNames, BUTTON_NAMES, WEAPON_FLAG_NAMES } from "../parsers/actorstate.js";

export const PLAYER_REC_FIELDS = ["buttons", "modbuttons", "wclass", "pending", "refire", "wflags", "wstate", "wlabel", "wsprite", "wframe", "wtics"] as const;
export const FIELD_GROUPS = { input: PLAYER_REC_FIELDS.slice(0, 2), weaponstate: PLAYER_REC_FIELDS.slice(2) } as const;
export type RecField = Exclude<Field, "class"> | "state" | "label" | "tics" | (typeof PLAYER_REC_FIELDS)[number];
export type RecFieldOption = RecField | keyof typeof FIELD_GROUPS;
/** findactors' keys but class (a head column), then the state's id, label and tics left. */
const recFields: RecField[] = [...FIELDS.filter((f): f is Exclude<Field, "class"> => f !== "class"), "state", "label", "tics", ...PLAYER_REC_FIELDS];
export const REC_FIELDS = recFields as [RecField, ...RecField[]];
export const DEFAULT_REC_FIELDS: readonly RecField[] = ["tid", "hp", "x", "y", "z", "sprite", "frame"];

export const REC_EVENTS = ["spawn", "destroy", "state", "damage", "death", "psprite"] as const;
export type RecEvent = (typeof REC_EVENTS)[number];
export const DEFAULT_REC_EVENTS: readonly RecEvent[] = ["spawn", "destroy", "damage", "death"];

export function expandFields(fields: readonly RecFieldOption[]): RecField[] {
  return [...new Set(fields.flatMap((f) => Object.hasOwn(FIELD_GROUPS, f) ? FIELD_GROUPS[f as keyof typeof FIELD_GROUPS] : [f as RecField]))];
}

export function needsPlayerCap(o: { fields: readonly RecFieldOption[]; events: readonly RecEvent[] }): boolean {
  return o.events.includes("psprite") || expandFields(o.fields).some((f) => (PLAYER_REC_FIELDS as readonly string[]).includes(f));
}

// The engine's bounds (mcp_actorstate.cpp), and the host's run-mode cap of 60 s.
export const MAX_WATCHES = 8;
export const MAX_REC_TICS = 10500;
export const MAX_RUN_TICS = 2100;
export const MAX_REC_SCRIPTS = 32;
export const MAX_REC_VARS = 32;
export const MAX_TRACKED = 512;
export const MAX_ENGINE_ROWS = 20000;
// Summaries kept in a reply, and event lines in its text; the file always has everything.
export const SUMMARY_CAP = 50;
export const EVENT_LINES = 40;

export interface Watch {
  class?: string;
  tid?: number;
  player?: number;
}

export interface RecVar {
  map?: string;
  world?: number;
  global?: number;
  index?: number;
  sourceFile?: string;
  object?: string;
  includeDirs?: string[];
  /** Filled by the host after all source groups resolve, before any engine command. */
  resolved?: MapSlot;
}

/** Positions of the sourceFile vars, grouped by identical sourceFile/object/includeDirs (one resolve each), in first-seen order. */
export function groupVarsBySource(vars: readonly RecVar[]): number[][] {
  const groups = new Map<string, number[]>();
  for (const [i, v] of vars.entries()) {
    if (v.sourceFile === undefined) continue;
    const key = JSON.stringify([v.sourceFile, v.object, v.includeDirs]);
    groups.set(key, [...(groups.get(key) ?? []), i]);
  }
  return [...groups.values()];
}

export interface RecordOptions {
  watch: Watch[];
  fields: readonly RecField[];
  events: readonly RecEvent[];
  scripts?: "all" | Array<string | number>;
  vars?: RecVar[];
  tics: number;
  run: boolean;
  everyTics: number;
  onChange: boolean;
}

// Printable ASCII with inner spaces (the list is quoted then), minus what the quoted token or the comma split would eat.
const SENDABLE_NAME = /^(?!.*["\\,;])[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;

/** Why a recording can't be armed as asked, or undefined. */
export function recordProblem(o: RecordOptions): string | undefined {
  if (o.watch.length === 0 && o.scripts === undefined && !o.vars?.length) return "give watch, scripts or vars: nothing to record";
  if ((o.vars?.length ?? 0) > MAX_REC_VARS) return `at most ${MAX_REC_VARS} vars can be recorded`;
  for (const [i, v] of (o.vars ?? []).entries()) {
    const why = (text: string) => `var ${i + 1}: ${text}`;
    if ([v.map, v.world, v.global].filter((x) => x !== undefined).length !== 1) return why("give exactly one of map, world or global");
    if (v.sourceFile !== undefined && v.map === undefined) return why("sourceFile requires map");
    if (v.sourceFile === undefined && (v.object !== undefined || v.includeDirs !== undefined)) return why("object and includeDirs require sourceFile");
    if (v.sourceFile !== undefined && v.index !== undefined) return why("put the index in the sourceFile map expression, not index");
    if (v.sourceFile !== undefined && !PROBE_EXPR.test(v.map!)) return why("map must be a name followed by constant [index] and .member parts with sourceFile");
  }
  const empty = o.watch.findIndex((w) => w.class === undefined && w.tid === undefined && w.player === undefined);
  if (empty >= 0) return `watch ${empty + 1}: give class, tid or player`;
  if (o.run && o.tics > MAX_RUN_TICS) {
    return `run mode records at most ${MAX_RUN_TICS} tics (60 s); run: false arms up to ${MAX_REC_TICS}`;
  }
  for (const s of Array.isArray(o.scripts) ? o.scripts : []) {
    if (typeof s !== "string") continue;
    // mcp_rec reads an item strtol takes whole (a sign too) as a number.
    if (/^[+-]?\d+$/.test(s)) return `script name ${JSON.stringify(s)} reads as a number in mcp_rec`;
    if (!SENDABLE_NAME.test(s)) {
      return `script name ${JSON.stringify(s)} can't be sent (quotes, backslashes, commas, semicolons, non-ASCII and edge spaces don't survive the console); use scripts: "all"`;
    }
  }
  return undefined;
}

/** The one console line that arms a recording: stop and clear, the setup, go, then `then` (run before any tic). */
export function recordSchedule(o: RecordOptions, then?: string): string {
  const list = o.scripts === "all" ? "all" : o.scripts?.join(",");
  // A spaced name or a leading $ needs the list quoted; recordProblem refused anything a quote can't carry.
  const scripts = list === undefined ? [] : [isPlainToken(list) ? command("mcp_rec", "scripts", list) : `mcp_rec scripts "${list}"`];
  const go = kvArgs({ tics: o.tics, run: o.run ? 1 : undefined, every: o.everyTics, changes: o.onChange ? 1 : 0 });
  return [
    "mcp_rec stop",
    "mcp_rec clear",
    ...o.watch.map((w) => command("mcp_rec", "watch", ...kvArgs({ class: w.class, tid: w.tid, player: w.player }))),
    command("mcp_rec", "fields", o.fields.join(",")),
    command("mcp_rec", "events", o.events.length > 0 ? o.events.join(",") : "none"),
    ...scripts,
    ...(o.vars ?? []).map((v) => {
      const r = v.resolved;
      return command("mcp_rec", "var", ...kvArgs(r ? {
        slot: r.slot, v: 1, code: r.digest.len, first: r.digest.first, md5: r.digest.md5, index: r.index, label: v.map,
      } : { map: v.map, world: v.world, global: v.global, index: v.index }));
    }),
    command("mcp_rec", "go", ...go),
    ...(then !== undefined ? [then] : []),
  ].join("; ");
}

export interface ActorSummary {
  id: number;
  /** From its spawn or seen row; null when the file has none. */
  class: string | null;
  tid?: number;
  first: number;
  last: number;
  spawned?: number;
  destroyed?: number;
  died?: number;
}

export interface ScriptSummary {
  /** 0 for an end with no recorded start. */
  serial: number;
  /** The number, or a named script's name. */
  script: number | string;
  module?: string;
  start?: number;
  end?: number;
  activator?: string;
}

/** One summary per recorder id in first-row order, rows without one (scripts, untracked targets) making none. */
export function actorSummaries(rows: KvRecord[]): ActorSummary[] {
  const byId = new Map<number, ActorSummary>();
  for (const r of rows) {
    const id = Number(r.id);
    if (!(id > 0)) continue;
    const t = Number(r.t);
    let a = byId.get(id);
    if (!a) {
      a = { id, class: null, first: t, last: t };
      byId.set(id, a);
    }
    a.last = t;
    // The latest tid seen: a spawn row's is 0, set only after it.
    if (r.tid !== undefined) a.tid = Number(r.tid);
    if (r.k === "spawn" || r.k === "seen") {
      a.class = String(r.class);
      if (r.k === "spawn") a.spawned = t;
    }
    if (r.k === "destroy") a.destroyed = t;
    if (r.k === "death") a.died ??= t;
  }
  return [...byId.values()];
}

/** One summary per script serial, in start order; each serial-0 end (no recorded start) is its own. */
export function scriptSummaries(rows: KvRecord[]): ScriptSummary[] {
  const out: ScriptSummary[] = [];
  const bySerial = new Map<number, ScriptSummary>();
  for (const r of rows) {
    if (r.k !== "script_start" && r.k !== "script_end") continue;
    const serial = Number(r.serial);
    let s = bySerial.get(serial);
    if (!s) {
      s = { serial, script: r.name !== undefined ? String(r.name) : Number(r.script) };
      out.push(s);
      if (serial > 0) bySerial.set(serial, s);
    }
    if (r.k === "script_start") Object.assign(s, { module: String(r.module), start: Number(r.t), activator: String(r.act) });
    else s.end = Number(r.t);
  }
  return out;
}

export interface VarSummary {
  var: number;
  name: string;
  values: [number, number][];
  changes: number;
  valuesOmitted?: number;
}

export function varSummaries(rows: KvRecord[]): VarSummary[] {
  const vars = new Map<number, VarSummary>();
  for (const r of rows) {
    if (r.k !== "var") continue;
    const n = Number(r.var);
    let v = vars.get(n);
    if (!v) {
      v = { var: n, name: String(r.name), values: [], changes: 0 };
      vars.set(n, v);
    }
    if (r.prev !== undefined) v.changes++;
    if (v.values.length < SUMMARY_CAP) v.values.push([Number(r.t), Number(r.value)]);
    else v.valuesOmitted = (v.valuesOmitted ?? 0) + 1;
  }
  return [...vars.values()];
}

const isSample = (r: KvRecord) => r.k === "sample";

/** Each recorder id's class, joined from its spawn or seen row. */
function classesOf(rows: KvRecord[]): Map<number, string | null> {
  return new Map(actorSummaries(rows).map((a) => [a.id, a.class]));
}

/** At most `max` rows: events first, then samples fill what is left, all in file order. */
export function capRows(rows: KvRecord[], max: number): KvRecord[] {
  if (rows.length <= max) return rows;
  let events = 0;
  let samples = max - Math.min(max, rows.filter((r) => !isSample(r)).length);
  return rows.filter((r) => (isSample(r) ? samples-- > 0 : events++ < max));
}

export interface RecordResult {
  /** done, stopped, level_change, map_reset, or recording (read while still armed). */
  reason: string;
  /** Tics that ran, from `start`. */
  tics: number;
  start: number;
  end: number;
  table: { columns: string[]; rows: Cell[][] };
  actors: ActorSummary[];
  scripts: ScriptSummary[];
  vars: VarSummary[];
  /** Rows per kind, across the whole file. */
  counts: Record<string, number>;
  rowsDropped?: number;
  engineDropped?: number;
  untracked?: number;
  actorsOmitted?: number;
  scriptsOmitted?: number;
  file: string;
}

const HEAD = ["t", "kind", "id", "class"];
const CELL_DECODERS: Record<string, readonly string[]> = { buttons: BUTTON_NAMES, modbuttons: BUTTON_NAMES, wflags: WEAPON_FLAG_NAMES };

/** The reply for a dumped recording: the table capped at `maxRows`, summaries capped at SUMMARY_CAP. */
export function recordResult(rec: RecFile, file: string, maxRows: number, untracked = 0): RecordResult {
  const { header, rows } = rec;
  const actors = actorSummaries(rows);
  const scripts = scriptSummaries(rows);
  const classes = classesOf(rows);
  const counts: Record<string, number> = {};
  for (const r of rows) counts[String(r.k)] = (counts[String(r.k)] ?? 0) + 1;
  const kept = capRows(rows, maxRows);
  const head = (r: KvRecord): Cell[] => [r.t, r.k, r.id ?? null, classes.get(Number(r.id)) ?? null];
  const columns = [...HEAD, ...header.fields, "info"];
  const tableRows = tableOf(kept, head, header.fields, ["t", "k", "id", "class"]).map((row) => row.map((cell, i) =>
    cell !== null && CELL_DECODERS[columns[i]] ? bitNames(Number(cell), CELL_DECODERS[columns[i]]).join("+") || "-" : cell));
  return {
    reason: header.reason === "-" ? "recording" : header.reason,
    tics: header.ran,
    start: header.start,
    end: header.start + header.ran,
    table: { columns, rows: tableRows },
    actors: actors.slice(0, SUMMARY_CAP),
    scripts: scripts.slice(0, SUMMARY_CAP),
    vars: varSummaries(rows),
    counts,
    ...(rows.length > kept.length ? { rowsDropped: rows.length - kept.length } : {}),
    ...(header.dropped ? { engineDropped: header.dropped } : {}),
    ...(untracked ? { untracked } : {}),
    ...(actors.length > SUMMARY_CAP ? { actorsOmitted: actors.length - SUMMARY_CAP } : {}),
    ...(scripts.length > SUMMARY_CAP ? { scriptsOmitted: scripts.length - SUMMARY_CAP } : {}),
    file,
  };
}

/** The reply's caveat lines: whatever the table, the engine or the file left out. */
export function recordNotes(r: RecordResult, rec: RecFile): string[] {
  return [
    ...(r.rowsDropped ? [`${r.rowsDropped} row(s) past maxRows left out of the table (events kept first); the file has them all`] : []),
    ...(r.engineDropped ? [`${r.engineDropped} row(s) past the engine's ${MAX_ENGINE_ROWS}-row buffer were never recorded`] : []),
    ...(r.untracked ? [`${r.untracked} matching actor(s) past the ${MAX_TRACKED}-actor cap were not tracked`] : []),
    ...(rec.rows.length !== rec.header.rows ? [`the file has ${rec.rows.length} row(s), its header says ${rec.header.rows}`] : []),
  ];
}

function actorLine(a: ActorSummary): string {
  const name = `#${a.id} ${a.class ?? "?"}${a.tid ? ` tid ${a.tid}` : ""}`;
  const from = `${a.spawned !== undefined ? "spawned" : "seen"} ${a.first}`;
  const span = a.destroyed !== undefined ? `${from}, destroyed ${a.destroyed}` : a.last > a.first ? `${from}..${a.last}` : from;
  return `${name}: ${span}${a.died !== undefined ? `, died ${a.died}` : ""}`;
}

function scriptLine(s: ScriptSummary): string {
  const start = s.start !== undefined ? `started ${s.start} in ${s.module} by ${s.activator}` : "no recorded start";
  return `script ${s.script} serial ${s.serial}: ${start}, ${s.end !== undefined ? `ended ${s.end}` : "still running"}`;
}

/** An event row as one text line: maptime, kind, who, then its other keys. */
function eventLine(r: KvRecord, classes: Map<number, string | null>): string {
  const id = Number(r.id);
  const who = r.serial !== undefined ? `serial ${r.serial}` : id > 0 ? `#${id} ${classes.get(id) ?? "?"}` : "untracked";
  const rest = Object.entries(r).filter(([k]) => !["t", "k", "id", "serial", "class"].includes(k));
  return `  ${r.t} ${r.k} ${who}: ${rest.map(([k, v]) => `${k}=${v}`).join(" ")}`;
}

/** The text reply: a header, one line per actor and script, up to EVENT_LINES events, the notes, the file. */
export function describeRecord(r: RecordResult, rec: RecFile, notes: string[]): string {
  const samples = r.counts.sample ?? 0;
  const seen = r.counts.seen ?? 0;
  const vars = r.counts.var ?? 0;
  const events = rec.rows.length - samples - seen - vars;
  const head =
    `recorded ${r.tics} tic(s), maptime ${r.start}..${r.end}: ${r.actors.length + (r.actorsOmitted ?? 0)} actor(s), ` +
    `${rec.rows.length} row(s) (${samples} sample, ${seen} seen, ${events} event, ${vars} var), ${r.reason}`;
  const classes = classesOf(rec.rows);
  const eventRows = rec.rows.filter((row) => !isSample(row) && row.k !== "seen" && row.k !== "var");
  return [
    head,
    ...r.actors.map(actorLine),
    ...(r.actorsOmitted ? [`(${r.actorsOmitted} more actor(s) in the file)`] : []),
    ...r.scripts.map(scriptLine),
    ...(r.scriptsOmitted ? [`(${r.scriptsOmitted} more script(s) in the file)`] : []),
    ...r.vars.map((v) => {
      const more = v.values.length - Math.min(12, v.values.length) + (v.valuesOmitted ?? 0);
      return `${v.name}: ${v.values.slice(0, 12).map(([t, value]) => `${value} @${t}`).join(", ")}${more ? ` (+${more} more)` : ""}`;
    }),
    ...(eventRows.length ? ["events:", ...eventRows.slice(0, EVENT_LINES).map((row) => eventLine(row, classes))] : []),
    ...(eventRows.length > EVENT_LINES ? [`(${eventRows.length - EVENT_LINES} more event(s) in the file)`] : []),
    ...notes,
    `file: ${r.file}`,
  ].join("\n");
}
