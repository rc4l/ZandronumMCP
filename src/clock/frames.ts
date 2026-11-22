/** The frozen clock's pure host half: frame_sweep's checks, job commands and end reasons (grammar: PROTOCOL.md, Frozen clock). */
import { CAPTURE_TAG } from "../screenshot/tag.js";

export const MAX_SWEEP_FRAMES = 64;
export const MAX_SWEEP_IMAGES = 8;
export const MAX_SWEEP_TICS = 16;
/** Frames one capture job takes: its settle frames plus the capture. */
export const SHOT_FRAMES = 4;

/** A frozen clock's step: the tics that moved maptime and how it ended (done, or why it stopped short). */
export interface TicRun {
  ran: number;
  end: string;
  /** The clock was frozen first (its live tic counted in `ran`), because a demo played or recorded. */
  froze?: true;
}

const END_TEXT: Record<string, string> = {
  paused:
    "a pause landed while frozen (a pause command, or a menu a human opened); steps refuse until freeze_time off then on",
  level_change: "the level changed or reloaded (at an intermission, steps refuse until freeze_time off)",
  stalled: "no tic ran for ~1 s",
  demo_end: "the demo ended (still frozen: one more step returns to the console, freeze_time off resumes)",
  stopped: "stopped (mcp_clock stop, or a thaw)",
  nointerp: "interpolation went off before a sub-tic frame (cl_capfps or r_NoInterpolate)",
  "not in a level": "not in a level (at an intermission, freeze_time off lets it run)",
};

/** An end reason or an engine refusal as reply text. */
export function clockEndText(reason: string): string {
  return END_TEXT[reason] ?? reason;
}

/** A frozen step's reply head. */
export function describeTicRun(run: TicRun): string {
  const froze = run.froze ? "; froze the clock: a paused tic desyncs a demo (freeze_time off resumes)" : "";
  const head = `advanced ${run.ran} tic(s) (frozen clock)${froze}`;
  return run.end === "done" ? head : `${head}; stopped: ${clockEndText(run.end)}`;
}

/** A frozen-clock capture's basename, namespaced by the server's `CAPTURE_TAG` like `screenshotName`. */
export function frameName(seq: number, i: number, tag: string = CAPTURE_TAG): string {
  return `mcp_frame_${tag}_${seq}_${i}`;
}

export interface SweepArgs {
  of: number;
  frames?: number[];
  tics: number;
  output: "image" | "file";
}

export interface SweepFrame {
  /** 0 for the last tic run; 1..tics for the tics the sweep steps. */
  tic: number;
  k: number;
  of: number;
  frac: number;
  name: string;
}

export interface SweepPlan {
  frames: SweepFrame[];
  /** mcp_clock commands, queued in this order. */
  jobs: string[];
  /** Frames the jobs need, which bounds the wait for them. */
  units: number;
}

/** frame_sweep's frames and jobs (`name` names frame i), or why the arguments can't run. */
export function planSweep(a: SweepArgs, name: (i: number) => string): SweepPlan | { error: string } {
  const ks = a.frames ?? Array.from({ length: a.of }, (_, k) => k);
  const bad = ks.find((k) => k > a.of);
  if (bad !== undefined) return { error: `frame ${bad} is past of (${a.of}): frames lie in 0..${a.of}` };
  const passes = Math.max(a.tics, 1);
  const total = ks.length * passes;
  if (total > MAX_SWEEP_FRAMES) {
    return { error: `${total} frames (frames x tics) is over ${MAX_SWEEP_FRAMES}: sweep fewer frames or tics` };
  }
  if (a.output === "image" && total > MAX_SWEEP_IMAGES) {
    return { error: `${total} images is over ${MAX_SWEEP_IMAGES} inline: use output "file", or fewer frames or tics` };
  }
  const frames: SweepFrame[] = [];
  const jobs: string[] = [];
  for (let t = 1; t <= passes; t++) {
    if (a.tics > 0) jobs.push("mcp_clock step 1");
    for (const k of ks) {
      const f = { tic: a.tics > 0 ? t : 0, k, of: a.of, frac: k / a.of, name: name(frames.length) };
      frames.push(f);
      jobs.push(`mcp_clock shot ${f.name} ${k} ${a.of}`);
    }
  }
  return { frames, jobs, units: a.tics + total * SHOT_FRAMES };
}
