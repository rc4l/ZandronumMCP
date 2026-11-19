/** run_scenario's step loop, behind a port so tests can script its replies. */
import type { ZodRawShape } from "zod";
import { parseArgs, type ToolArgs, type ToolReply } from "./dispatch.js";
import { MAX_CALLS } from "./schema.js";

/** A step's text, cut past this. */
export const STEP_TEXT_CHARS = 500;
/** A step's structured result: arrays cut to this many rows, fewer until it serializes within STEP_JSON_CHARS. */
export const STEP_ROWS = 20;
export const STEP_JSON_CHARS = 2000;
/** The serialized step results a reply keeps; past it, later steps keep only their kind and ok (and a failed one's summary line). */
export const REPLY_CHARS = 24000;
/** A summary line's step text, and a failed step's text once the reply is full. */
export const SUMMARY_CHARS = 100;
// Log tools whose left-out sinceLine a scenario fills: read_log reads on from the last read, wait_for_log waits from the start.
const READ_LOG = "read_log";
const WAIT_FOR_LOG = "wait_for_log";

export interface CallStep {
  call: string;
  args: ToolArgs;
}
export interface ExpectStep<C> {
  expect: C;
}
export interface RepeatStep<C> {
  repeat: Array<CallStep | ExpectStep<C>>;
  until?: C;
  maxIterations: number;
}
export type Step<C> = CallStep | ExpectStep<C> | RepeatStep<C>;

export interface Scenario<C> {
  instance: number;
  steps: Step<C>[];
  onFail: "stop" | "continue";
  maxSeconds: number;
}

/** A condition read: whether it holds, and its comparison as text. */
export interface ConditionRead {
  met: boolean;
  text: string;
}

export interface ScenarioPort<C> {
  /** A tool's input shape; undefined when no tool has that name. */
  shape(call: string): ZodRawShape | undefined;
  /** Why a scenario refuses a tool, if it does. */
  refusal(call: string): string | undefined;
  /** Call a tool with its args, instance included. */
  invoke(call: string, args: ToolArgs): Promise<ToolReply>;
  evalCondition(c: C): Promise<ConditionRead | { error: string }>;
  /** The map tic counter, read fresh; undefined when unreadable. */
  maptime(): Promise<number | undefined>;
  /** The engine-log line the scenario began at, read_log's first resume point and wait_for_log's default; undefined without a log. */
  logStart: number | undefined;
  /** The client's cancel: once aborted, no further call or condition read starts. */
  signal: AbortSignal;
  /** Wall-clock milliseconds. */
  now(): number;
}

interface StepBase {
  index: number;
  ok: boolean;
  text?: string;
}
export interface CallResult extends StepBase {
  call: string;
  structured?: Record<string, unknown> | string;
  omitted?: { rows?: number; chars?: number };
  hint?: string;
}
export interface ExpectResult extends StepBase {
  /** The condition's kind. */
  expect: string;
}
export interface RepeatResult extends StepBase {
  /** The last iteration's body results. */
  repeat: Array<CallResult | ExpectResult>;
  iterations: number;
}
export type StepResult = CallResult | ExpectResult | RepeatResult;

export interface ScenarioResult {
  ok: boolean;
  /** The first failed step. */
  failedAt?: number;
  calls: number;
  maptimeStart?: number;
  maptimeEnd?: number;
  steps: StepResult[];
  notes?: string[];
}

export interface ScenarioOutcome {
  result: ScenarioResult;
  /** The run ended at a failure: under onFail stop, or a thrown error or a cap. */
  halted: boolean;
}

interface Ran<R> {
  // Every step the runner builds has its text; only bare() can drop it.
  result: R & { text: string };
  halt: boolean;
}

/** Why a call step can't run, or undefined when its tool and args check out. */
function callProblem(port: Pick<ScenarioPort<unknown>, "shape" | "refusal">, step: CallStep, instance: number): string | undefined {
  const refused = port.refusal(step.call);
  if (refused) return `not callable in a scenario (${refused})`;
  const shape = port.shape(step.call);
  if (!shape) return "no such tool";
  if (!("instance" in shape)) return "takes no instance; call it on its own";
  if ("instance" in step.args) return "instance is the scenario's; drop it from args";
  const parsed = parseArgs(shape, { ...step.args, instance });
  return "error" in parsed ? parsed.error : undefined;
}

/** Every call step's problem, one line each naming the step (i, or i.j in a repeat) and its tool. */
function validate<C>(port: Pick<ScenarioPort<C>, "shape" | "refusal">, s: Scenario<C>): string[] {
  const calls = s.steps.flatMap((step, i): Array<{ step: CallStep; at: string }> => {
    if ("call" in step) return [{ step, at: `${i}` }];
    if (!("repeat" in step)) return [];
    return step.repeat.flatMap((inner, j) => ("call" in inner ? [{ step: inner, at: `${i}.${j}` }] : []));
  });
  return calls.flatMap(({ step, at }) => {
    const why = callProblem(port, step, s.instance);
    return why ? [`step ${at} (${step.call}): ${why}`] : [];
  });
}

function capText(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}... (${s.length - max} more chars)`;
}

const stepText = (s: string) => capText(s, STEP_TEXT_CHARS);

/** A step's text as its summary line shows it: the first line, cut at SUMMARY_CHARS; cutting it again changes nothing. */
function summaryText(s: string): string {
  const first = s.split("\n")[0];
  return first.length <= SUMMARY_CHARS ? first : `${first.slice(0, SUMMARY_CHARS)}...`;
}

/** A reply's text blocks joined, any other block named. */
function replyText(reply: ToolReply): string {
  return reply.content.map((c) => (c.type === "text" ? c.text : `[${c.type} omitted]`)).join("\n");
}

/** `v` with every array at any depth cut to `rows` entries, counting what it drops into `dropped.n`. */
function trimArrays(v: unknown, rows: number, dropped: { n: number }): unknown {
  if (Array.isArray(v)) {
    dropped.n += Math.max(0, v.length - rows);
    return v.slice(0, rows).map((x) => trimArrays(x, rows, dropped));
  }
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimArrays(x, rows, dropped)]));
  }
  return v;
}

/** A structured result cut to fit a step: arrays to STEP_ROWS rows, halved until it fits STEP_JSON_CHARS, else its JSON cut there. */
export function capStructured(structured: Record<string, unknown>): Pick<CallResult, "structured" | "omitted"> {
  for (let rows = STEP_ROWS; ; rows = Math.floor(rows / 2)) {
    const dropped = { n: 0 };
    const trimmed = trimArrays(structured, rows, dropped) as Record<string, unknown>;
    if (JSON.stringify(trimmed).length <= STEP_JSON_CHARS) {
      return dropped.n > 0 ? { structured: trimmed, omitted: { rows: dropped.n } } : { structured: trimmed };
    }
    if (rows === 0) break;
  }
  const json = JSON.stringify(structured);
  return { structured: json.slice(0, STEP_JSON_CHARS), omitted: { chars: json.length - STEP_JSON_CHARS } };
}

/** A step as kept once the reply is full: its index, kind and ok, and a failed one's summary line. */
function bare(r: StepResult & { text: string }): StepResult {
  const why = r.ok ? {} : { text: summaryText(r.text) };
  if ("call" in r) return { index: r.index, call: r.call, ok: r.ok, ...why };
  if ("expect" in r) return { index: r.index, expect: r.expect, ok: r.ok, ...why };
  return { index: r.index, repeat: [], iterations: r.iterations, ok: r.ok, ...why };
}

/** Every call step `s` can't run, as the refusal to return before runScenario, or undefined. */
export function scenarioRefusal<C>(port: Pick<ScenarioPort<C>, "shape" | "refusal">, s: Scenario<C>): string | undefined {
  const problems = validate(port, s);
  return problems.length > 0 ? ["refused, nothing ran:", ...problems].join("\n") : undefined;
}

/** Run the steps in order on `s.instance` once `scenarioRefusal` passed them, a failed step ending the run only under onFail stop. */
export async function runScenario<C extends { kind: string }>(
  port: ScenarioPort<C>,
  s: Scenario<C>,
): Promise<ScenarioOutcome> {
  const startMs = port.now();
  let calls = 0;
  let cursor = port.logStart;

  /** `work`'s value, or why the run must end: a cap reached, or what `work` threw. */
  async function attempt<T>(isCall: boolean, work: () => Promise<T>): Promise<{ value: T } | { halt: string }> {
    if (port.signal.aborted) return { halt: "stopped: the client cancelled the run" };
    if (isCall && calls >= MAX_CALLS) return { halt: `stopped: ${MAX_CALLS} calls ran (the cap)` };
    if (port.now() - startMs >= s.maxSeconds * 1000) return { halt: `stopped: maxSeconds (${s.maxSeconds}) passed` };
    if (isCall) calls++;
    try {
      return { value: await work() };
    } catch (e) {
      return { halt: e instanceof Error ? e.message : String(e) };
    }
  }

  async function runCall(step: CallStep, index: number): Promise<Ran<CallResult>> {
    const since = step.call === READ_LOG ? cursor : step.call === WAIT_FOR_LOG ? port.logStart : undefined;
    const resume = step.args.sinceLine === undefined && since !== undefined ? { sinceLine: since } : {};
    const got = await attempt(true, () => port.invoke(step.call, { ...step.args, ...resume, instance: s.instance }));
    if ("halt" in got) return { result: { index, call: step.call, ok: false, text: stepText(got.halt) }, halt: true };
    const reply = got.value;
    const next = reply.structuredContent?.nextLine;
    if (step.call === READ_LOG && typeof next === "number") cursor = next;
    const result = { index, call: step.call, ok: reply.isError !== true, text: stepText(replyText(reply)) };
    if (!reply.structuredContent) return { result, halt: false };
    const capped = capStructured(reply.structuredContent);
    const hint = capped.omitted && { hint: `cut to fit; call ${step.call} on its own for all of it` };
    return { result: { ...result, ...capped, ...hint }, halt: false };
  }

  /** A condition read as met, unmet, unreadable (error) or ending the run (halt), with its text. */
  async function evaluate(c: C): Promise<{ state: "met" | "unmet" | "error" | "halt"; text: string }> {
    const got = await attempt(false, () => port.evalCondition(c));
    if ("halt" in got) return { state: "halt", text: got.halt };
    const r = got.value;
    if ("error" in r) return { state: "error", text: r.error };
    return r.met ? { state: "met", text: `met: ${r.text}` } : { state: "unmet", text: `not met: ${r.text}` };
  }

  async function runExpect(c: C, index: number): Promise<Ran<ExpectResult>> {
    const got = await evaluate(c);
    return { result: { index, expect: c.kind, ok: got.state === "met", text: stepText(got.text) }, halt: got.state === "halt" };
  }

  const runOne = (step: CallStep | ExpectStep<C>, index: number) =>
    "call" in step ? runCall(step, index) : runExpect(step.expect, index);

  async function runRepeat(step: RepeatStep<C>, index: number): Promise<Ran<RepeatResult>> {
    let body: Array<CallResult | ExpectResult> = [];
    const done = (iterations: number, ok: boolean, text: string, halt = false): Ran<RepeatResult> => ({
      result: { index, repeat: body, iterations, ok, text: stepText(text) },
      halt,
    });
    let unmet = "";
    for (let i = 1; i <= step.maxIterations; i++) {
      body = [];
      for (const [j, inner] of step.repeat.entries()) {
        const ran = await runOne(inner, j);
        body.push(ran.result);
        if (!ran.result.ok) return done(i, false, `iteration ${i}: step ${j} failed`, ran.halt);
      }
      if (step.until === undefined) continue;
      const until = await evaluate(step.until);
      if (until.state === "met") return done(i, true, `until ${until.text}, after ${i} iteration(s)`);
      if (until.state !== "unmet") return done(i, false, `until: ${until.text}`, until.state === "halt");
      unmet = until.text;
    }
    const n = step.maxIterations;
    return step.until === undefined ? done(n, true, `${n} iteration(s)`) : done(n, false, `until ${unmet}, within ${n} iteration(s)`);
  }

  const maptimeStart = await port.maptime();
  const steps: StepResult[] = [];
  let size = 0;
  let fullFrom: number | undefined;
  let failedAt: number | undefined;
  let halted = false;
  for (const [index, step] of s.steps.entries()) {
    const ran = "repeat" in step ? await runRepeat(step, index) : await runOne(step, index);
    const length = JSON.stringify(ran.result).length;
    if (fullFrom === undefined && size + length <= REPLY_CHARS) {
      size += length;
      steps.push(ran.result);
    } else {
      fullFrom ??= index;
      steps.push(bare(ran.result));
    }
    if (ran.result.ok) continue;
    failedAt ??= index;
    if (ran.halt || s.onFail === "stop") {
      halted = true;
      break;
    }
  }
  // A cancelled run's reply goes nowhere, so it sends the engine nothing more.
  const maptimeEnd = port.signal.aborted ? undefined : await port.maptime();
  const backwards = maptimeStart !== undefined && maptimeEnd !== undefined && maptimeEnd < maptimeStart;
  const notes = [
    ...(fullFrom === undefined
      ? []
      : [`reply full (${REPLY_CHARS} chars): steps from ${fullFrom} on keep only their kind and ok, a failed one also its summary line; run them in a smaller scenario for the rest`]),
    ...(backwards ? [`maptime went backwards (${maptimeStart} -> ${maptimeEnd}): a map change restarted the tic counter, so the two don't count the run's tics`] : []),
  ];
  const result: ScenarioResult = {
    ok: failedAt === undefined,
    ...(failedAt !== undefined && { failedAt }),
    calls,
    ...(maptimeStart !== undefined && { maptimeStart }),
    ...(maptimeEnd !== undefined && { maptimeEnd }),
    steps,
    ...(notes.length > 0 && { notes }),
  };
  return { result, halted };
}

/** The reply's text half: a head line, then one line per step. */
export function describeScenario(r: ScenarioResult): string {
  const span = r.maptimeStart !== undefined && r.maptimeEnd !== undefined ? `, maptime ${r.maptimeStart} -> ${r.maptimeEnd}` : "";
  const head = `${r.ok ? "scenario ok" : `scenario failed at step ${r.failedAt}`}: ${r.steps.length} step(s) ran, ${r.calls} call(s)${span}`;
  const lines = r.steps.map((st) => {
    const label = "call" in st ? st.call : "expect" in st ? `expect ${st.expect}` : `repeat x${st.iterations}`;
    const why = st.text && summaryText(st.text);
    return `${st.index} ${label}: ${st.ok ? "ok" : "FAILED"}${why ? ` - ${why}` : ""}`;
  });
  return [head, ...lines, ...(r.notes ?? [])].join("\n");
}
