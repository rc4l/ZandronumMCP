/** input_timeline's pure host side: the segment schema, its `mcp_input` schedule and the per-segment summary. */
import { z } from "zod";
import { command, refToken, type RefArg } from "../commands/builders.js";
import type { InputRow } from "../parsers/input.js";
import { waypointFields, toWaypoint } from "../movement/target.js";
import type { Waypoint } from "../movement/moveto.js";

/** The engine overlay enforces the same caps (mcp_input.cpp). */
export const MAX_SEGMENTS = 64;
export const MAX_TICS = 2100;

/** Raw ticcmd units for an axis value of 1: running forward, running strafe, full swim/fly. */
const AXIS_UNITS = { forward: 0x32 << 8, side: 0x28 << 8, up: 0x300 } as const;

const axis = z.number().min(-1).max(1).optional();

export const segmentArg = z
  .object({
    tics: z.number().int().min(1).max(MAX_TICS).optional().describe("Timed segment: how many tics this input is held for; give tics or to, not both."),
    to: z.object(waypointFields).strict().optional().describe("Walk segment: exactly one of {x, y}, {tid} or {class}, as one move_to waypoint."),
    radius: z.number().min(0).max(32767).optional().describe("Walk only: exact stand-off, default 0; a solid actor adds both radii and a 1-unit gap."),
    speed: z.number().positive().max(1).optional().describe("Walk only: thrust cap, default 1 (running)."),
    pass: z.boolean().optional().describe("Walk only: run through the target instead of stopping on it."),
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

/** Entry commands, timed tic total and whole-run limits, or why the timeline is refused. */
export function planTimeline(
  segments: Segment[],
  maxTics?: number,
  stuckTics = 35,
): { error: string } | { segTics: number; walks: number; commands: string[]; limits?: ScheduleLimits } {
  let segTics = 0;
  let walks = 0;
  const commands: string[] = [];
  for (const [i, s] of segments.entries()) {
    if ((s.tics === undefined) === (s.to === undefined)) return { error: `segment ${i + 1}: give tics or to, not both` };
    if (s.to !== undefined) {
      const target = toWaypoint(s.to);
      if (!target) return { error: `segment ${i + 1}: give exactly one of x and y, tid or class in to` };
      const movement = ["forward", "side", "up", "angle", "turn", "pitch"] as const;
      if (movement.some((k) => s[k] !== undefined)) return { error: `segment ${i + 1}: a walk takes no forward, side, up, angle, turn or pitch` };
      walks++;
      commands.push(walkCommand({ target, standoff: s.radius ?? 0, speed: s.speed ?? 1, pass: s.pass ?? false, buttons: s.buttons }));
      continue;
    }
    if (s.radius !== undefined || s.speed !== undefined || s.pass !== undefined) return { error: `segment ${i + 1}: radius, speed and pass are walk-only` };
    if (s.angle !== undefined && s.turn !== undefined) return { error: `segment ${i + 1}: give angle or turn, not both` };
    segTics += s.tics!;
    commands.push(
      command(
        "mcp_input",
        "seg",
        s.tics!,
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
  if (segTics > MAX_TICS) return { error: `${segTics} tics in all; the limit is ${MAX_TICS} (60 s)` };
  if (maxTics !== undefined && maxTics < segTics) return { error: `maxTics ${maxTics} is below the timed total ${segTics}` };
  return { segTics, walks, commands, ...(walks || maxTics !== undefined ? { limits: { maxTics: maxTics ?? MAX_TICS, stuckTics } } : {}) };
}

/** A walk entry: steer to a point or actor until there (or past it, with pass). */
export interface Walk {
  target: RefArg;
  standoff: number;
  pass: boolean;
  speed: number;
  buttons?: string[];
}

/** The `mcp_input walk` command for one walk entry. */
export function walkCommand(w: Walk): string {
  return command("mcp_input", "walk", refToken(w.target), num(w.standoff), w.pass ? 1 : 0, num(w.speed), w.buttons?.length ? w.buttons.join(",") : "-");
}

/** go's optional tic limit (whole run) and stuck window; the engine's defaults apply when absent. */
export interface ScheduleLimits {
  maxTics: number;
  stuckTics: number;
}

/** One console line that replaces any armed timeline, where a failed seg makes `go` refuse so a typo arms nothing. */
export function scheduleCommand(entryCommands: string[], pauseAfter: boolean, limits?: ScheduleLimits): string {
  const go = command("mcp_input", "go", pauseAfter ? 1 : 0, ...(limits ? [limits.maxTics, limits.stuckTics] : []));
  return ["mcp_input stop", "mcp_input clear", ...entryCommands, go].join("; ");
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
  walk?: { target: NonNullable<Segment["to"]>; outcome: string; distance?: number; at?: { x: number; y: number } };
}

const point = (r: InputRow): Point => ({ x: r.x, y: r.y, z: r.z });

/** Summarize consumed entries, zero-tic walks included, from the whole trail or only each entry's last row. */
export function summarizeSegments(
  start: InputRow,
  rows: InputRow[],
  logs: Map<number, string[]>,
  walks?: { entries: Segment[]; done: number; reason: string; dist?: number; target?: { x: number; y: number } },
): SegmentSummary[] {
  const last = new Map<number, InputRow | undefined>(rows.map((r) => [r.seg, r]));
  if (walks) {
    for (const [i, s] of walks.entries.entries()) {
      if (s.to && (i < walks.done || (i === walks.done && walks.reason !== "done"))) {
        if (!last.has(i + 1)) last.set(i + 1, undefined);
      }
    }
  }
  const entries = [...last.keys()].sort((a, b) => a - b);
  const lastWalk = entries.filter((seg) => walks?.entries[seg - 1]?.to).at(-1);
  let prev = start;
  let next = start.maptime;
  return entries.map((seg) => {
    const row = last.get(seg);
    const r = row ?? prev;
    const summary: SegmentSummary = {
      seg,
      start: next,
      end: row ? r.maptime : next,
      tics: row ? r.maptime - next + 1 : 0,
      from: point(prev),
      to: point(r),
      angle: r.angle,
      health: r.health,
      log: logs.get(seg) ?? [],
    };
    const target = walks?.entries[seg - 1]?.to;
    if (walks && target) {
      const waypoint = toWaypoint(target) as Waypoint;
      const distance = seg === lastWalk ? walks.dist : "x" in waypoint ? Math.hypot(waypoint.x - r.x, waypoint.y - r.y) : undefined;
      summary.walk = {
        target,
        outcome: seg <= walks.done ? "arrived" : walks.reason,
        ...(distance !== undefined ? { distance } : {}),
        ...(seg === lastWalk && walks.target ? { at: walks.target } : {}),
      };
    }
    prev = r;
    if (row) next = r.maptime + 1;
    return summary;
  });
}

const at = (p: Point) => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;

/** The text reply: one line per segment that ran, its log lines indented, then why it ended early. */
export function describeTimeline(
  reason: string,
  segments: SegmentSummary[],
  planned: { segments: number; tics: number; walks?: number; limit?: number; done?: number },
  consumed: number,
): string {
  const lines = segments.flatMap((s) => [
    `seg ${s.seg}/${planned.segments}${s.walk ? ` walk to ${targetText(s.walk.target!)}` : ""} maptime ${s.start}-${s.end} (${s.tics} tic(s)): ${at(s.from)} -> ${at(s.to)} angle ${s.angle.toFixed(1)}, health ${s.health}${s.walk ? `: ${s.walk.outcome}${s.walk.distance === undefined ? "" : `, ${s.walk.distance.toFixed(1)} from target`}` : ""}`,
    ...s.log.map((l) => `  ${l}`),
  ]);
  if (planned.walks) lines.push(`${reason} in seg ${Math.min(planned.done! + 1, planned.segments)}/${planned.segments} after ${consumed} tic(s)${reason === "timeout" ? ` (limit ${planned.limit})` : ""}`);
  else if (reason !== "done") lines.push(`${reason} after ${consumed} of ${planned.tics} tic(s)`);
  return lines.join("\n");
}

function targetText(target: NonNullable<Segment["to"]>): string {
  if (target.tid !== undefined) return `tid ${target.tid}`;
  if (target.class !== undefined) return `class ${target.class}`;
  return `(${target.x}, ${target.y})`;
}
