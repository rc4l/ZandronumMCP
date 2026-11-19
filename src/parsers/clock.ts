/** The frozen clock's `mcp_clock status` line (grammar: PROTOCOL.md, Frozen clock). */
import { kvNumbers, statusRow } from "./lines.js";

export interface ClockStatus {
  frozen: boolean;
  gametic: number;
  maptime: number;
  interp: boolean;
  /** Why interpolation is off (cl_capfps or r_NoInterpolate); only when it is. */
  nointerp?: string;
  jobs: number;
  /** Tics that moved maptime since the freeze, its own live tic included. */
  steps: number;
  shots: number;
  /** How the last job run ended: - while one runs, done, or why it stopped. */
  reason: string;
  /** `mcp_clock freeze demo` is waiting for an offline demo's first tic (absent on older builds: false). */
  armedDemo: boolean;
}

/** The first `mcp_clock status` line among `lines` (the freeze and queue replies carry no steps=), or undefined. */
export function parseClockStatus(lines: string[]): ClockStatus | undefined {
  const rec = statusRow(lines, "MCP_CLOCK", "steps");
  if (!rec) return undefined;
  return {
    frozen: rec.frozen === 1,
    ...kvNumbers(rec, ["gametic", "maptime"]),
    interp: rec.interp === 1,
    ...(rec.nointerp !== undefined && { nointerp: String(rec.nointerp) }),
    ...kvNumbers(rec, ["jobs", "steps", "shots"]),
    reason: String(rec.reason),
    armedDemo: rec.armed === "demo",
  };
}
