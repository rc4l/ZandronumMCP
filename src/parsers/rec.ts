/**
 * Parsers for the `mcp_rec` CCMD's replies and the file its `dump` writes (grammar in PROTOCOL.md).
 */
import { firstError, kvNumbers, parseKvLines, statusRow, type KvRecord } from "./lines.js";
import { expandFlags } from "./actorstate.js";

export interface RecStatus {
  active: boolean;
  /** Tics that ran since the recording was armed. */
  ran: number;
  tics: number;
  rows: number;
  dropped: number;
  /** Actors given an id so far. */
  tracked: number;
  untracked: number;
  maptime: number;
  /** done, stopped, level_change, map_reset, or "-" while armed or before any recording. */
  reason: string;
}

/** The `MCP_REC active=...` status line, or undefined when the reply has none. */
export function parseRecStatus(lines: string[]): RecStatus | undefined {
  const row = statusRow(lines, "MCP_REC", "active");
  if (!row) return undefined;
  return {
    active: row.active === 1,
    ...kvNumbers(row, ["ran", "tics", "rows", "dropped", "tracked", "untracked", "maptime"]),
    reason: String(row.reason),
  };
}

/** The position of the var a refused schedule stopped at: the `MCP_REC var` lines before its first error. */
export function failedRecVar(lines: string[]): number | undefined {
  const at = lines.findIndex((l) => firstError([l]) !== undefined);
  return at < 0 ? undefined : parseKvLines(lines.slice(0, at), "MCP_REC var").length;
}

/** The `MCP_REC armed ...` line `go` prints, or undefined when it refused. */
export function parseRecArmed(lines: string[]): { watches: number; tracked: number; vars: number; tics: number; maptime: number } | undefined {
  const row = parseKvLines(lines, "MCP_REC armed")[0];
  return row && { watches: Number(row.watches), tracked: Number(row.tracked), vars: Number(row.vars ?? 0), tics: Number(row.tics), maptime: Number(row.maptime) };
}

/** The `MCP_REC wrote ...` line a successful `dump` prints. */
export function parseRecWrote(lines: string[]): { rows: number; dropped: number } | undefined {
  const row = parseKvLines(lines, "MCP_REC wrote")[0];
  return row && kvNumbers(row, ["rows", "dropped"]);
}

export interface RecHeader {
  map: string;
  /** The maptime the recording was armed at. */
  start: number;
  ran: number;
  rows: number;
  dropped: number;
  /** The sample columns, in the order asked. */
  fields: string[];
  reason: string;
}

export interface RecFile {
  header: RecHeader;
  /** One record per `rec t=<maptime> k=<kind> ...` line, in the order written. */
  rows: KvRecord[];
}

/** A dumped recording, or undefined without its `MCP_RECFILE` header line. */
export function parseRecFile(text: string): RecFile | undefined {
  const lines = text.split(/\r?\n/);
  const head = parseKvLines(lines, "MCP_RECFILE")[0];
  if (!head) return undefined;
  const fields = String(head.fields ?? "-");
  return {
    header: {
      map: String(head.map),
      start: Number(head.start),
      ran: Number(head.ran),
      rows: Number(head.rows),
      dropped: Number(head.dropped),
      fields: fields === "-" ? [] : fields.split(","),
      reason: String(head.reason),
    },
    // flags= reads as names, as find_actors and watch_actors give them.
    rows: parseKvLines(lines, "rec").map(expandFlags),
  };
}
