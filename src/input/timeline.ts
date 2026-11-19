/** input_timeline's pure host side: the segment schema, its `mcp_input` schedule and the per-segment summary. */
import { z } from "zod";
import { command } from "../commands/builders.js";
import type { InputRow } from "../parsers/input.js";

/** The engine overlay enforces the same caps (mcp_input.cpp). */
export const MAX_SEGMENTS = 64;
export const MAX_TICS = 2100;

/** Raw ticcmd units for an axis value of 1: running forward, running strafe, full swim/fly. */
const AXIS_UNITS = { forward: 0x32 << 8, side: 0x28 << 8, up: 0x300 } as const;

const axis = z.number().min(-1).max(1).optional();

export const segmentArg = z
  .object({
    tics: z.number().int().min(1).max(MAX_TICS).describe("How many tics this input is held for."),
    buttons: z
      .array(z.string().regex(/^[A-Za-z0-9_]+$/, "a button name is letters, digits or _"))
      .optional()
      .describe("Held for every tic of the segment, e.g. attack, altattack, use, jump, crouch, reload, zoom, speed, strafe, turn180, user1-4."),
    forward: axis.describe("1 = running forward, 0.5 = walking, negative = backward."),
    side: axis.describe("1 = running strafe to the right, negative = left."),
    up: axis.describe("Swim/fly up (1) or down (-1)."),
    angle: z.number().finite().optional().describe("Absolute heading in Doom degrees (0 east, 90 north), held for the segment."),
    turn: z.number().min(-180).max(180).optional().describe("Degrees turned per tic; positive is left (counter-clockwise)."),
    pitch: z.number().min(-90).max(90).optional().describe("Absolute view pitch as in set_view: negative looks up."),
  })
  .strict();

export type Segment = z.infer<typeof segmentArg>;

/** A number as a console token: at most 4 decimals, never exponent form. */
const num = (v: number) => String(Number(v.toFixed(4)));

const units = (v: number | undefined, scale: number) => Math.round((v ?? 0) * scale);

/** The `mcp_input seg` command for each segment plus the tic total, or why the timeline is refused. */
export function planTimeline(segments: Segment[]): { error: string } | { total: number; commands: string[] } {
  let total = 0;
  const commands: string[] = [];
  for (const [i, s] of segments.entries()) {
    if (s.angle !== undefined && s.turn !== undefined) return { error: `segment ${i + 1}: give angle or turn, not both` };
    total += s.tics;
    commands.push(
      command(
        "mcp_input",
        "seg",
        s.tics,
        s.buttons?.length ? s.buttons.join(",") : "-",
        units(s.forward, AXIS_UNITS.forward),
        units(s.side, AXIS_UNITS.side),
        units(s.up, AXIS_UNITS.up),
        s.angle === undefined ? "-" : num(((s.angle % 360) + 360) % 360),
        num(s.turn ?? 0),
        s.pitch === undefined ? "-" : num(s.pitch),
      ),
    );
  }
  if (total > MAX_TICS) return { error: `${total} tics in all; the limit is ${MAX_TICS} (60 s)` };
  return { total, commands };
}

/** One console line that replaces any armed timeline, where a failed seg makes `go` refuse so a typo arms nothing. */
export function scheduleCommand(segCommands: string[], pauseAfter: boolean): string {
  return ["mcp_input stop", "mcp_input clear", ...segCommands, `mcp_input go ${pauseAfter ? 1 : 0}`].join("; ");
}

/** Log lines per 1-based segment, split on `MCP_INPUT_SEG <n>` and cut at `MCP_INPUT_END`, minus the bridge's own replies. */
export function splitLog(lines: string[]): Map<number, string[]> {
  const bySeg = new Map<number, string[]>();
  let current: string[] | undefined;
  for (const line of lines) {
    const marker = /^MCP_INPUT_SEG (\d+)\b/.exec(line);
    if (marker) {
      current = [];
      bySeg.set(Number(marker[1]), current);
    } else if (line.startsWith("MCP_INPUT_END")) break;
    else if (current && !line.startsWith("MCP_INPUT")) current.push(line);
  }
  return bySeg;
}

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface SegmentSummary {
  /** 1-based index into the requested segments. */
  seg: number;
  /** Map tics its first and last input were applied in. */
  start: number;
  end: number;
  tics: number;
  from: Point;
  to: Point;
  /** Heading and health after its last tic. */
  angle: number;
  health: number;
  log: string[];
}

const point = (r: InputRow): Point => ({ x: r.x, y: r.y, z: r.z });

/** One summary per segment that ran at least one tic, from the whole trail or only each segment's last row. */
export function summarizeSegments(start: InputRow, rows: InputRow[], logs: Map<number, string[]>): SegmentSummary[] {
  const last: InputRow[] = [];
  for (const r of rows) {
    if (last.at(-1)?.seg === r.seg) last[last.length - 1] = r;
    else last.push(r);
  }
  let prev = start;
  let next = start.maptime;
  return last.map((r) => {
    const summary = {
      seg: r.seg,
      start: next,
      end: r.maptime,
      tics: r.maptime - next + 1,
      from: point(prev),
      to: point(r),
      angle: r.angle,
      health: r.health,
      log: logs.get(r.seg) ?? [],
    };
    prev = r;
    next = r.maptime + 1;
    return summary;
  });
}

const at = (p: Point) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;

/** The text reply: one line per segment that ran, its log lines indented, then why it ended early. */
export function describeTimeline(
  reason: string,
  segments: SegmentSummary[],
  planned: { segments: number; tics: number },
  consumed: number,
): string {
  const lines = segments.flatMap((s) => [
    `seg ${s.seg}/${planned.segments} maptime ${s.start}-${s.end} (${s.tics} tic(s)): ${at(s.from)} -> ${at(s.to)} angle ${s.angle.toFixed(1)}, health ${s.health}`,
    ...s.log.map((l) => `  ${l}`),
  ]);
  if (reason !== "done") lines.push(`${reason} after ${consumed} of ${planned.tics} tic(s)`);
  return lines.join("\n");
}
