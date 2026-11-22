/** Parsers for the `mcp_input` CCMD's status line, armed line and per-tic trail (grammar in PROTOCOL.md). */
import { kvNumbers, parseKvLines, statusRow, type KvRecord } from "./lines.js";

export interface InputStatus {
  active: boolean;
  /** Tics of the timeline that ran. */
  consumed: number;
  total: number;
  seg: number;
  maptime: number;
  /** done, level_change, stopped, or "-" while armed or before any run. */
  reason: string;
}

/** The `MCP_INPUT active=...` status line, or undefined when the reply has none. */
export function parseInputStatus(lines: string[]): InputStatus | undefined {
  const row = statusRow(lines, "MCP_INPUT", "active");
  if (!row) return undefined;
  return {
    active: row.active === 1,
    ...kvNumbers(row, ["consumed", "total", "seg", "maptime"]),
    reason: String(row.reason),
  };
}

/** The `MCP_INPUT armed ...` line `go` prints, or undefined when it refused. */
export function parseInputArmed(lines: string[]): { segs: number; tics: number; maptime: number } | undefined {
  const row = parseKvLines(lines, "MCP_INPUT armed")[0];
  return row && { segs: Number(row.segs), tics: Number(row.tics), maptime: Number(row.maptime) };
}

const ROW_NUMBERS = ["maptime", "seg", "x", "y", "z", "angle", "pitch", "momx", "momy", "momz", "health"] as const;

/** The player after one tic of the timeline; `maptime` is the tic its input was applied in. */
export type InputRow = Record<(typeof ROW_NUMBERS)[number], number> & { buttons: string[] };

function toRow(r: KvRecord): InputRow {
  return { ...kvNumbers(r, ROW_NUMBERS), buttons: r.buttons === "-" ? [] : String(r.buttons).split(",") };
}

/** `mcp_input trail` as `start` (the player when armed, absent from a later index) and tic rows, or undefined if the CCMD never ran. */
export function parseInputTrail(lines: string[]): { start: InputRow | undefined; rows: InputRow[] } | undefined {
  // Only what follows the header: game output printed before it may start with the same words.
  const flat = lines.flatMap((l) => l.split(/\r?\n/)).map((l) => l.trim());
  const header = flat.indexOf("MCP_INPUT_TRAIL");
  if (header < 0) return undefined;
  const body = flat.slice(header + 1);
  const start = parseKvLines(body, "start")[0];
  return { start: start && toRow(start), rows: parseKvLines(body, "tic").map(toRow) };
}
