/**
 * Parse and summarise the one-line `mcp_status` snapshot the bridge rides on a
 * command's correlator sentinel (see `correlation/sentinel.ts`). Pure — no
 * `BridgeClient` reference — so it's testable without a socket.
 */
import { kvPairs } from "./lines.js";

export type EngineStatus = Record<string, string>;

/**
 * Parse a console line that carries the correlator sentinel. Returns the
 * `key=value` fields when the line is the `mcp_status` form (sentinel followed
 * by fields), or `undefined` for the legacy bare-`echo` form (just the
 * sentinel, nothing else) — the caller uses `undefined` to mean "no status
 * available", not "engine state unknown".
 */
export function parseStatus(line: string, sentinel: string): EngineStatus | undefined {
  const tokens = line.trim().split(/\s+/);
  if (tokens[0] !== sentinel || tokens.length < 2) return undefined;
  return Object.fromEntries(kvPairs(tokens.slice(1)));
}

interface StatusRow {
  key: string;
  /** The value this field takes when nothing unusual is going on. */
  normal: string;
  note: (value: string, status: EngineStatus) => string;
  /** False for a state that doesn't stop the MCP driving the sim (`step` runs through it). */
  blocker?: false;
}

/**
 * One row per condition worth surfacing. `health`/`armor` are deliberately NOT
 * rows here — they're always-present data for `player_state`, not "unusual"
 * conditions — so they never appear in the note. Adding a future condition is
 * one row, not a new branch.
 */
const ROWS: StatusRow[] = [
  { key: "paused", normal: "0", note: () => "paused", blocker: false },
  // The focus-loss pause, which `step` can't run through. Fires only when the overlay sends it.
  { key: "pauseext", normal: "0", note: () => "paused by focus loss (pauseext)" },
  {
    key: "menu",
    normal: "off",
    note: (_v, status) =>
      status.menuclass ? `a menu is open (${status.menuclass})` : "a menu is open",
  },
  { key: "console", normal: "up", note: (v) => `console is ${v}` },
  { key: "gamestate", normal: "level", note: (v) => `not in a level (${v})` },
  {
    key: "player",
    normal: "alive",
    note: (v) => (v === "none" ? "no player" : `player is ${v}`),
  },
  { key: "spectating", normal: "0", note: () => "spectating" },
  { key: "demo", normal: "0", note: () => "playing back a demo" },
  { key: "automap", normal: "0", note: () => "automap is open" },
  { key: "chat", normal: "0", note: () => "chat input is open" },
  { key: "demorec", normal: "0", note: () => "recording a demo", blocker: false },
  // A queued map/load/playdemo that hasn't run yet. Fires only when the overlay sends it.
  { key: "pending", normal: "0", note: () => "a map/save/demo load is pending" },
  // run_acs snippet modules in the level, which make a save unloadable.
  {
    key: "acstemp",
    normal: "0",
    note: (v) => `${v} run_acs snippet module(s) loaded (saves refused until the map changes)`,
    blocker: false,
  },
];

function unusualRows(status: EngineStatus): Array<{ row: StatusRow; note: string }> {
  return ROWS.flatMap((row) => {
    const value = status[row.key];
    if (value === undefined || value === row.normal) return [];
    return [{ row, note: row.note(value, status) }];
  });
}

/**
 * Summarise a status snapshot as a short human-readable note, or `undefined`
 * when nothing about it is unusual (the common case, so a normal round trip
 * costs nothing to read).
 */
export function describeStatus(status: EngineStatus): string | undefined {
  const phrases = unusualRows(status).map((u) => u.note);
  return phrases.length ? `Engine state: ${phrases.join(", ")}.` : undefined;
}

/**
 * The note a reply carries, given the one the same client's last reply was
 * built from (`prev`) and the current one (`note`): the note when it changed or
 * the reply is an error, a one-off "back to normal" when it cleared, otherwise
 * nothing, so silence means unchanged. The caller stores `note`, not the
 * returned text, as the next `prev`.
 */
export function footerNote(
  prev: string | undefined,
  note: string | undefined,
  isError: boolean,
): string | undefined {
  if (note) return note !== prev || isError ? note : undefined;
  return prev ? "Engine state: back to normal." : undefined;
}

/** The unusual conditions that can stop a driven sim or eat its input, worded as in
 *  `describeStatus`: every row but `paused` (the normal driving state), `demorec` and `acstemp`. */
export function statusBlockers(status: EngineStatus | undefined): string[] {
  if (!status) return [];
  return unusualRows(status)
    .filter((u) => u.row.blocker !== false)
    .map((u) => u.note);
}

/** The snapshot once it carries `field`, or why it doesn't (`supported` is the bridge's status cap). */
export function requireField(
  status: EngineStatus | undefined,
  supported: boolean,
  field: string,
  hint = "",
): { status: EngineStatus } | { error: string } {
  if (status?.[field] !== undefined) return { status };
  if (!supported) return { error: "this engine bridge has no status support (rebuild with the latest bridge)" };
  return {
    error: status
      ? `the engine's status snapshot has no ${field}= field (rebuild the engine with the latest overlay)${hint}`
      : "status read timed out (engine busy, e.g. loading a map); retry",
  };
}
