/** What each live tool may do while a demo plays (`demo=1`) or records (`demorec=1`), declared per `registerLive` call. */
import type { EngineStatus } from "../parsers/status.js";

/** A tool's demo class: read, netcmd (dropped by playback, recorded), write (outside the ticcmd stream, never replayed),
 *  input, menu, timeline (scripted input), load, or gate (pause and stepping: never refused, so they handle a demo themselves). */
export type DemoClass = "read" | "netcmd" | "write" | "input" | "menu" | "timeline" | "load" | "gate";

/** A class, or a function of the call's args for a tool whose args switch between reading and writing. */
export type DemoRow = DemoClass | ((args: Record<string, unknown>) => DemoClass);

export const writesWithValue: DemoRow = (args) => (args.value === undefined ? "read" : "write");
// Without a tid, give/take are the stock net commands; with one, mcp_inv writes directly.
export const netcmdUnlessTid: DemoRow = (args) => (args.tid === undefined ? "netcmd" : "write");
export const writesWithCommand: DemoRow = (args) => (args.command === undefined ? "read" : "write");

/** The class a call falls in. */
export function demoClass(row: DemoRow, args: Record<string, unknown>): DemoClass {
  return typeof row === "function" ? row(args) : row;
}

/** Classes no demo state can refuse, so the caller needn't read status for them. */
export function demoMayRefuse(cls: DemoClass): boolean {
  return cls !== "read" && cls !== "gate";
}

export interface DemoState {
  playing: boolean;
  recording: boolean;
}

export type DemoActivity = "playing" | "recording";

/** A status snapshot's demo flags. */
export function demoState(s: EngineStatus | undefined): DemoState {
  return { playing: s?.demo === "1", recording: s?.demorec === "1" };
}

/** What a demo is doing, playback first; undefined with none. */
export function demoActivity(s: EngineStatus | undefined): DemoActivity | undefined {
  const d = demoState(s);
  return d.playing ? "playing" : d.recording ? "recording" : undefined;
}

export type DemoVerdict = { refuse: string } | { note: string } | undefined;

const PLAYING: Partial<Record<DemoClass, (tool: string) => string>> = {
  netcmd: (t) => `${t} is a netcommand, which playback drops`,
  write: (t) => `${t} writes the game directly, which desyncs the replay`,
  input: () => "playback ignores real input",
  timeline: (t) => `${t} drives input, which playback ignores`,
};

const RECORDING: Partial<Record<DemoClass, (tool: string) => string>> = {
  write: (t) => `${t} writes the game directly, which isn't recorded, so the replay desyncs`,
  menu: () => "a menu opened mid-recording desynced its replay when measured",
  load: (t) => `${t} would end the take unwritten; kill_instance writes the recording first`,
};

/** Whether a call of `cls` may run in `state`: a refusal, a note for the reply, or nothing. */
export function demoVerdict(tool: string, cls: DemoClass, state: DemoState): DemoVerdict {
  if (state.playing) {
    const why = PLAYING[cls];
    if (why) return { refuse: `a demo is playing: ${why(tool)}` };
    if (cls === "load") return { note: `(${tool} ended the demo that was playing)` };
    return undefined;
  }
  const why = state.recording ? RECORDING[cls] : undefined;
  return why && { refuse: `a demo is recording: ${why(tool)}` };
}
