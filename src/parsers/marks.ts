import path from "node:path";
import { parseKv, stripColor } from "./lines.js";

/** read_marks' `gamelog` as an absolute path or a bare name in the launches' gamelog `dir`, else why not. */
export function resolveGamelog(gamelog: string, dir: string | undefined, exeVar: string): { file: string } | { error: string } {
  if (path.isAbsolute(gamelog)) return { file: gamelog };
  if (path.basename(gamelog) === gamelog && dir) return { file: path.join(dir, gamelog) };
  return { error: `gamelog wants an absolute path${dir ? " or a bare file name" : ` (no gamelog dir: ${exeVar} is unset)`}: ${gamelog}` };
}

/** One `mcp_mark` playtest marker, as logged. */
export interface Mark {
  /** Per-process counter: "mark 3". */
  n: number;
  /** gametic, which keeps running while paused. */
  tic: number;
  /** Level time, frozen while paused. */
  maptime: number;
  map: string;
  x?: number;
  y?: number;
  z?: number;
  angle?: number;
  /** The `mcp_mark_round` script's result; "none" when that script isn't loaded. */
  round?: number | "none";
  wave?: number;
  /** Screenshot basename (no `.png`) in the engine's working dir; unset for `shot=none`. */
  shot?: string;
  note: string;
  /** Log timestamp, when the log prefixes one (Zandronum's gamelog does). */
  time?: string;
  /** 1-based line in the log file. */
  line: number;
}

// The gamelog prefixes "[HH:MM:SS] " or "[YY:MM:DD;HH:MM:SS] "; the bridge's tee log doesn't.
const MARK_RE = /^(?:\[([\d:;]+)\] )?MCP_MARK (.*)$/;

const STRING_KEYS = ["map", "shot"];

/** Every `MCP_MARK` line among numbered log lines. */
export function parseMarks(lines: Array<{ line: number; text: string }>): Mark[] {
  return lines.flatMap(({ line, text }) => {
    const m = stripColor(text).trim().match(MARK_RE);
    if (!m) return [];
    const kv = parseKv(m[2], STRING_KEYS, "note");
    if (kv.n === undefined) return [];
    const mark: Mark = {
      n: Number(kv.n),
      tic: Number(kv.tic),
      maptime: Number(kv.maptime),
      map: String(kv.map ?? ""),
      note: String(kv.note ?? ""),
      line,
    };
    for (const k of ["x", "y", "z", "angle", "wave"] as const) if (kv[k] !== undefined) mark[k] = Number(kv[k]);
    if (kv.round !== undefined) mark.round = kv.round === "none" ? "none" : Number(kv.round);
    if (kv.shot !== undefined && kv.shot !== "none") mark.shot = String(kv.shot);
    if (m[1]) mark.time = m[1];
    return [mark];
  });
}

/** One mark as a text line: `#n map tic= maptime= at x,y,z ... : note`. */
export function formatMark(m: Mark): string {
  const parts = [`#${m.n}`, m.map, `tic=${m.tic}`, `maptime=${m.maptime}`];
  if (m.x !== undefined) parts.push(`at ${m.x},${m.y},${m.z} angle=${m.angle}`);
  if (m.round !== undefined) parts.push(`round=${m.round}`);
  if (m.wave !== undefined) parts.push(`wave=${m.wave}`);
  if (m.time) parts.push(`time=${m.time}`);
  parts.push(m.shot ? `shot=${m.shot}` : "no shot", `(log line ${m.line})`);
  return `${parts.join(" ")}: ${m.note}`;
}
