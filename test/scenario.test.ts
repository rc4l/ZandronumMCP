import { describe, it, expect } from "vitest";
import { z, type ZodRawShape } from "zod";
import type { ToolArgs, ToolReply } from "../src/scenario/dispatch.js";
import {
  runScenario as run,
  scenarioRefusal,
  describeScenario,
  capStructured,
  REPLY_CHARS,
  STEP_JSON_CHARS,
  type ConditionRead,
  type Scenario,
  type ScenarioPort,
  type Step,
} from "../src/scenario/run.js";
import { scenarioShape, MAX_CALLS, SCENARIO_REFUSALS } from "../src/scenario/schema.js";

const instance = z.number().int().positive().default(1);
const SHAPES: Record<string, ZodRawShape> = {
  run_command: { instance, text: z.string().min(1) },
  step: { instance, tics: z.number().int().positive().default(35) },
  read_log: { instance, sinceLine: z.number().int().nonnegative().optional() },
  wait_for_log: { instance, pattern: z.string(), sinceLine: z.number().int().nonnegative().default(0) },
  find_actors: { instance, to: z.object({ x: z.number() }).optional() },
  kill_instance: { instance },
  screenshot: { instance },
  run_scenario: { instance },
  map_info: { map: z.string() },
  frame_sweep: { instance, output: z.enum(["image", "file"]).default("image") },
};
const REFUSALS: Record<string, string> = {
  kill_instance: SCENARIO_REFUSALS.lifecycle,
  screenshot: SCENARIO_REFUSALS.image,
  run_scenario: SCENARIO_REFUSALS.nested,
};

/** A condition the fake reads from its queue; a condition carries only its kind. */
type Cond = { kind: string };
type Read = ConditionRead | { error: string } | Error;

interface FakeOptions {
  reply?: (call: string, args: ToolArgs) => ToolReply | Promise<ToolReply>;
  /** Condition reads in turn; the last repeats. */
  reads?: Read[];
  maptimes?: Array<number | undefined>;
  logStart?: number;
  now?: () => number;
  signal?: AbortSignal;
}

function fake(o: FakeOptions = {}) {
  const calls: Array<{ call: string; args: ToolArgs }> = [];
  const reads = o.reads ?? [{ met: true, text: "1 == 1" }];
  let r = 0;
  let maptimes = 0;
  const port: ScenarioPort<Cond> = {
    shape: (call) => SHAPES[call],
    refusal: (call) => REFUSALS[call],
    invoke: async (call, args) => {
      calls.push({ call, args });
      return o.reply ? o.reply(call, args) : { content: [{ type: "text", text: `${call} done` }] };
    },
    evalCondition: async () => {
      const next = reads[Math.min(r++, reads.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
    maptime: async () => (o.maptimes ?? [100, 140])[maptimes++],
    logStart: o.logStart,
    signal: o.signal ?? new AbortController().signal,
    now: o.now ?? (() => 0),
  };
  return { port, calls, maptimeReads: () => maptimes };
}

const scenario = (steps: Step<Cond>[], more: Partial<Scenario<Cond>> = {}): Scenario<Cond> => ({
  instance: 3,
  steps,
  onFail: "stop",
  maxSeconds: 60,
  ...more,
});

const text = (t: string): ToolReply => ({ content: [{ type: "text", text: t }] });
const call = (name: string, args: ToolArgs = {}) => ({ call: name, args });

describe("run_scenario validation", () => {
  it("refuses every bad call step up front, naming its index, tool and zod path", () => {
    const { port } = fake();
    const out = scenarioRefusal(
      port,
      scenario([
        call("run_command", { text: "god" }),
        call("kill_instance"),
        call("screenshot"),
        call("run_scenario"),
        call("nope"),
        call("map_info", { map: "MAP01" }),
        call("step", { instance: 2 }),
        { repeat: [{ expect: { kind: "log" } }, call("step", { tics: "x" }), call("find_actors", { to: { x: "a" } })], maxIterations: 2 },
        call("step", { tic: 5 }),
        call("frame_sweep"),
        call("frame_sweep", { output: "file" }),
      ]),
    );
    expect(out).toBe(
      [
        "refused, nothing ran:",
        "step 1 (kill_instance): not callable in a scenario (process lifecycle)",
        "step 2 (screenshot): not callable in a scenario (replies with an inline image; use screenshot_file)",
        "step 3 (run_scenario): not callable in a scenario (scenarios don't nest)",
        "step 4 (nope): no such tool",
        "step 5 (map_info): takes no instance; call it on its own",
        "step 6 (step): instance is the scenario's; drop it from args",
        "step 7.1 (step): tics: Expected number, received string",
        "step 7.2 (find_actors): to.x: Expected number, received string",
        "step 8 (step): args: Unrecognized key(s) in object: 'tic'",
        'step 9 (frame_sweep): output "image" replies with inline images; pass output: "file"',
      ].join("\n"),
    );
    expect(scenarioRefusal(port, scenario([call("step", { tics: 1 })]))).toBeUndefined();
  });
});

describe("runScenario", () => {
  it("runs call steps in order on the scenario's instance, keeping each one's text and structured result", async () => {
    const { port, calls } = fake({
      reply: (name) => (name === "step" ? { content: [{ type: "text", text: "advanced ~5 tic(s)" }], structuredContent: { log: ["a"] } } : text("god mode ON")),
    });
    const { result, halted } = await run(port, scenario([call("run_command", { text: "god" }), call("step", { tics: 5 })]));
    expect(calls).toEqual([
      { call: "run_command", args: { text: "god", instance: 3 } },
      { call: "step", args: { tics: 5, instance: 3 } },
    ]);
    expect(halted).toBe(false);
    expect(result).toEqual({
      ok: true,
      calls: 2,
      maptimeStart: 100,
      maptimeEnd: 140,
      steps: [
        { index: 0, call: "run_command", ok: true, text: "god mode ON" },
        { index: 1, call: "step", ok: true, text: "advanced ~5 tic(s)", structured: { log: ["a"] } },
      ],
    });
    expect(describeScenario(result)).toBe(
      "scenario ok: 2 step(s) ran, 2 call(s), maptime 100 -> 140\n0 run_command: ok - god mode ON\n1 step: ok - advanced ~5 tic(s)",
    );
  });

  it("leaves out a maptime it couldn't read", async () => {
    const { port } = fake({ maptimes: [undefined, 7] });
    const { result } = await run(port, scenario([call("step")]));
    expect(result).not.toHaveProperty("maptimeStart");
    expect(result.maptimeEnd).toBe(7);
    expect(describeScenario(result)).toBe("scenario ok: 1 step(s) ran, 1 call(s)\n0 step: ok - step done");
  });

  it("stops at an error reply under onFail stop, leaving later steps out", async () => {
    const { port, calls } = fake({ reply: (name) => (name === "step" ? { isError: true, content: [{ type: "text", text: "no time-control" }] } : text("ok")) });
    const { result, halted } = await run(port, scenario([call("run_command", { text: "a" }), call("step"), call("run_command", { text: "b" })]));
    expect(halted).toBe(true);
    expect(result).toMatchObject({ ok: false, failedAt: 1, calls: 2 });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]).toEqual({ index: 1, call: "step", ok: false, text: "no time-control" });
    expect(calls).toHaveLength(2);
    expect(describeScenario(result)).toBe(
      "scenario failed at step 1: 2 step(s) ran, 2 call(s), maptime 100 -> 140\n0 run_command: ok - ok\n1 step: FAILED - no time-control",
    );
  });

  it("runs on past failures under onFail continue, failedAt naming the first", async () => {
    const { port } = fake({ reply: (name) => (name === "step" ? { isError: true, content: [] } : text("ok")), reads: [{ met: false, text: "0 == 1" }] });
    const { result, halted } = await run(
      port,
      scenario([call("step"), { expect: { kind: "mapvar" } }, call("run_command", { text: "a" })], { onFail: "continue" }),
    );
    expect(halted).toBe(false);
    expect(result).toMatchObject({ ok: false, failedAt: 0, calls: 2 });
    expect(result.steps.map((st) => st.ok)).toEqual([false, false, true]);
    expect(result.steps[0].text).toBe("");
    expect(describeScenario(result).split("\n")[1]).toBe("0 step: FAILED");
  });

  it("ends the run at a thrown error even under onFail continue, the message as the step's text", async () => {
    const { port, calls } = fake({
      reply: (name) => {
        if (name === "step") throw new Error("bridge closed");
        return text("ok");
      },
    });
    const thrown = await run(port, scenario([call("step"), call("run_command", { text: "a" })], { onFail: "continue" }));
    expect(thrown.halted).toBe(true);
    expect(thrown.result.steps).toEqual([{ index: 0, call: "step", ok: false, text: "bridge closed" }]);
    expect(calls).toHaveLength(1);
    const odd = await run(fake({ reply: () => Promise.reject("not an Error") }).port, scenario([call("find_actors")]));
    expect(odd.result.steps[0].text).toBe("not an Error");
  });

  it("checks an expect: met passes, not met or unreadable fails, a throw ends the run", async () => {
    const reads: Read[] = [{ met: true, text: "1 line(s) matching /died/" }, { met: false, text: "0 == 1" }, { error: "map var 'hp' not found" }, new Error("timed out")];
    const { port } = fake({ reads });
    const steps: Step<Cond>[] = [0, 1, 2, 3, 4].map(() => ({ expect: { kind: "log" } }));
    const { result, halted } = await run(port, scenario(steps, { onFail: "continue" }));
    expect(halted).toBe(true);
    expect(result.steps).toEqual([
      { index: 0, expect: "log", ok: true, text: "met: 1 line(s) matching /died/" },
      { index: 1, expect: "log", ok: false, text: "not met: 0 == 1" },
      { index: 2, expect: "log", ok: false, text: "map var 'hp' not found" },
      { index: 3, expect: "log", ok: false, text: "timed out" },
    ]);
    expect(result.calls).toBe(0);
    expect(describeScenario(result).split("\n")[1]).toBe("0 expect log: ok - met: 1 line(s) matching /died/");
  });

  it("repeats until the condition holds after a pass, keeping the last pass's results and the count", async () => {
    let n = 0;
    const { port, calls } = fake({
      reply: () => text(`pass ${++n}`),
      reads: [{ met: false, text: "2 == 0" }, { met: false, text: "1 == 0" }, { met: true, text: "0 == 0" }],
    });
    const { result } = await run(port, scenario([{ repeat: [call("step", { tics: 5 })], until: { kind: "actors" }, maxIterations: 40 }]));
    expect(calls).toHaveLength(3);
    expect(result.steps).toEqual([
      {
        index: 0,
        repeat: [{ index: 0, call: "step", ok: true, text: "pass 3" }],
        iterations: 3,
        ok: true,
        text: "until met: 0 == 0, after 3 iteration(s)",
      },
    ]);
    expect(describeScenario(result).split("\n")[1]).toBe("0 repeat x3: ok - until met: 0 == 0, after 3 iteration(s)");
  });

  it("fails a repeat whose until never holds, after exactly maxIterations passes", async () => {
    const { port, calls } = fake({ reads: [{ met: false, text: "1 == 0" }] });
    const { result, halted } = await run(port, scenario([{ repeat: [call("step")], until: { kind: "actors" }, maxIterations: 4 }]));
    expect(calls).toHaveLength(4);
    expect(halted).toBe(true);
    expect(result.steps[0]).toMatchObject({ ok: false, iterations: 4, text: "until not met: 1 == 0, within 4 iteration(s)" });
  });

  it("runs a repeat without until exactly maxIterations times", async () => {
    const { port, calls } = fake();
    const { result } = await run(port, scenario([{ repeat: [call("step"), { expect: { kind: "log" } }], maxIterations: 3 }]));
    expect(calls).toHaveLength(3);
    expect(result.steps[0]).toMatchObject({ ok: true, iterations: 3, text: "3 iteration(s)" });
    expect((result.steps[0] as { repeat: unknown[] }).repeat).toHaveLength(2);
  });

  it("stops a repeat at a failed body step, and ends the run when that step threw", async () => {
    const failing = fake({ reads: [{ met: true, text: "a" }, { met: false, text: "b" }] });
    const { result } = await run(
      failing.port,
      scenario([{ repeat: [{ expect: { kind: "log" } }, call("step")], maxIterations: 5 }, call("step")], { onFail: "continue" }),
    );
    expect(result.steps[0]).toMatchObject({ ok: false, iterations: 2, text: "iteration 2: step 0 failed" });
    expect(result.steps).toHaveLength(2);
    const throwing = fake({ reply: () => Promise.reject(new Error("gone")) });
    const out = await run(throwing.port, scenario([{ repeat: [call("step")], maxIterations: 5 }, call("step")], { onFail: "continue" }));
    expect(out.halted).toBe(true);
    expect(out.result.steps).toEqual([
      { index: 0, repeat: [{ index: 0, call: "step", ok: false, text: "gone" }], iterations: 1, ok: false, text: "iteration 1: step 0 failed" },
    ]);
  });

  it("fails a repeat whose until can't be read, and ends the run when reading it threw", async () => {
    const unreadable = fake({ reads: [{ error: "no player" }] });
    const a = await run(unreadable.port, scenario([{ repeat: [call("step")], until: { kind: "player" }, maxIterations: 5 }], { onFail: "continue" }));
    expect(a.halted).toBe(false);
    expect(a.result.steps[0]).toMatchObject({ ok: false, iterations: 1, text: "until: no player" });
    const thrown = fake({ reads: [new Error("bridge closed")] });
    const b = await run(thrown.port, scenario([{ repeat: [call("step")], until: { kind: "player" }, maxIterations: 5 }], { onFail: "continue" }));
    expect(b.halted).toBe(true);
    expect(b.result.steps[0]).toMatchObject({ ok: false, text: "until: bridge closed" });
  });

  it(`stops before call ${MAX_CALLS + 1}, conditions not counted`, async () => {
    const { port, calls } = fake();
    const loop = (): Step<Cond> => ({ repeat: [call("step"), { expect: { kind: "log" } }], maxIterations: 200 });
    const { result, halted } = await run(port, scenario([loop(), loop()], { onFail: "continue" }));
    expect(calls).toHaveLength(MAX_CALLS);
    expect(halted).toBe(true);
    expect(result.calls).toBe(MAX_CALLS);
    expect(result.steps[1]).toMatchObject({ ok: false, iterations: 57, text: "iteration 57: step 0 failed" });
    expect((result.steps[1] as { repeat: Array<{ text: string }> }).repeat[0].text).toBe(`stopped: ${MAX_CALLS} calls ran (the cap)`);
  });

  it("stops once maxSeconds of wall clock passed, checked before each call and condition read", async () => {
    let t = 0;
    const ticking = fake({ now: () => t, reply: () => ((t += 30_000), text("slow")) });
    const { result, halted } = await run(ticking.port, scenario([call("step"), call("step"), call("step")], { maxSeconds: 60, onFail: "continue" }));
    expect(ticking.calls).toHaveLength(2);
    expect(halted).toBe(true);
    expect(result.steps[2]).toEqual({ index: 2, call: "step", ok: false, text: "stopped: maxSeconds (60) passed" });
    let u = 0;
    const late = fake({ now: () => (u += 40_000) });
    const r2 = await run(late.port, scenario([{ expect: { kind: "log" } }], { maxSeconds: 30 }));
    expect(r2.result.steps[0]).toEqual({ index: 0, expect: "log", ok: false, text: "stopped: maxSeconds (30) passed" });
  });

  it("stops once the client cancels, before the next call or condition read, and reads no end maptime", async () => {
    const cancel = new AbortController();
    const { port, calls, maptimeReads } = fake({ signal: cancel.signal, reply: () => (cancel.abort(), text("ok")) });
    const steps: Step<Cond>[] = [call("run_command", { text: "a" }), { expect: { kind: "log" } }, call("run_command", { text: "b" })];
    const { result, halted } = await run(port, scenario(steps, { onFail: "continue" }));
    expect(calls.map((c) => c.args.text)).toEqual(["a"]);
    expect(halted).toBe(true);
    expect(result).toEqual({
      ok: false,
      failedAt: 1,
      calls: 1,
      maptimeStart: 100,
      steps: [
        { index: 0, call: "run_command", ok: true, text: "ok" },
        { index: 1, expect: "log", ok: false, text: "stopped: the client cancelled the run" },
      ],
    });
    expect(maptimeReads()).toBe(1);
  });

  it("cuts a thrown error's message and a condition's text at the step text cap", async () => {
    const long = "e".repeat(600);
    const capped = /^[^]{500}\.\.\. \(\d+ more chars\)$/;
    const thrown = await run(fake({ reply: () => Promise.reject(new Error(long)) }).port, scenario([call("step")]));
    expect(thrown.result.steps[0].text).toBe(`${long.slice(0, 500)}... (100 more chars)`);
    const reads: Read[] = [{ met: false, text: long }, { error: long }, { met: false, text: long }, new Error(long)];
    const { result } = await run(
      fake({ reads }).port,
      scenario([{ expect: { kind: "log" } }, { expect: { kind: "log" } }, { repeat: [call("step")], until: { kind: "log" }, maxIterations: 1 }, { expect: { kind: "log" } }], {
        onFail: "continue",
      }),
    );
    expect(result.steps).toHaveLength(4);
    for (const st of result.steps) expect(st.text).toMatch(capped);
  });

  it("gives a read_log without sinceLine the scenario's cursor: from where it began, then each read's nextLine", async () => {
    const next = [14, 20, undefined];
    let i = 0;
    const { port, calls } = fake({
      logStart: 10,
      reply: (name) => {
        const n = name === "read_log" ? next[i++] : 99;
        return { content: [], structuredContent: n === undefined ? {} : { nextLine: n } };
      },
    });
    await run(
      port,
      scenario([
        call("read_log"),
        call("read_log", { sinceLine: 3 }),
        call("step"),
        call("read_log"),
        call("read_log"),
      ]),
    );
    expect(calls.filter((c) => c.call === "read_log").map((c) => c.args.sinceLine)).toEqual([10, 3, 20, 20]);
    const unlogged = fake();
    await run(unlogged.port, scenario([call("read_log")]));
    expect(unlogged.calls[0].args).toEqual({ instance: 3 });
  });

  it("gives a wait_for_log without sinceLine the line the scenario began at, leaving read_log's cursor alone", async () => {
    const { port, calls } = fake({ logStart: 10, reply: () => ({ content: [], structuredContent: { nextLine: 50 } }) });
    await run(
      port,
      scenario([
        call("wait_for_log", { pattern: "a" }),
        call("wait_for_log", { pattern: "b", sinceLine: 2 }),
        call("wait_for_log", { pattern: "c" }),
        call("read_log"),
      ]),
    );
    expect(calls.map((c) => c.args.sinceLine)).toEqual([10, 2, 10, 10]);
    const unlogged = fake();
    await run(unlogged.port, scenario([call("wait_for_log", { pattern: "a" })]));
    expect(unlogged.calls[0].args).toEqual({ pattern: "a", instance: 3 });
  });

  it("caps a step's text and names its non-text blocks", async () => {
    const long = "x".repeat(600);
    const { port } = fake({ reply: () => ({ content: [{ type: "text", text: long }, { type: "image" }] }) });
    const { result } = await run(port, scenario([call("step")]));
    expect(result.steps[0].text).toBe(`${"x".repeat(500)}... (116 more chars)`);
    const img = await run(fake({ reply: () => ({ content: [{ type: "text", text: "mark 1" }, { type: "image" }] }) }).port, scenario([call("step")]));
    expect(img.result.steps[0].text).toBe("mark 1\n[image omitted]");
  });

  it("cuts a large structured result and says how to get all of it", async () => {
    const actors = Array.from({ length: 30 }, (_, i) => ({ tid: i }));
    const { port } = fake({ reply: () => ({ content: [], structuredContent: { actors } }) });
    const { result } = await run(port, scenario([call("find_actors")]));
    expect(result.steps[0]).toEqual({
      index: 0,
      call: "find_actors",
      ok: true,
      text: "",
      structured: { actors: actors.slice(0, 20) },
      omitted: { rows: 10 },
      hint: "cut to fit; call find_actors on its own for all of it",
    });
  });

  it("leaves out a reply's cut once the reply is full, keeping each later step's kind and ok", async () => {
    const big = "y".repeat(STEP_JSON_CHARS - 100);
    const { port } = fake({ reply: () => ({ content: [{ type: "text", text: "z".repeat(400) }], structuredContent: { big } }) });
    const per = Math.ceil(REPLY_CHARS / (STEP_JSON_CHARS + 400));
    const steps: Step<Cond>[] = [
      ...Array.from({ length: per + 2 }, () => call("step")),
      { expect: { kind: "log" } },
      { repeat: [call("step")], maxIterations: 2 },
    ];
    const { result } = await run(port, scenario(steps));
    const full = result.steps.filter((st) => st.text !== undefined).length;
    expect(full).toBeLessThan(per + 2);
    expect(JSON.stringify(result.steps).length).toBeLessThanOrEqual(REPLY_CHARS + 2000);
    expect(result.steps[full]).toEqual({ index: full, call: "step", ok: true });
    expect(result.steps.at(-2)).toEqual({ index: per + 2, expect: "log", ok: true });
    expect(result.steps.at(-1)).toEqual({ index: per + 3, repeat: [], iterations: 2, ok: true });
    expect(result.notes).toEqual([
      `reply full (${REPLY_CHARS} chars): steps from ${full} on keep only their kind and ok, a failed one also its summary line; run them in a smaller scenario for the rest`,
    ]);
    const summary = describeScenario(result).split("\n");
    expect(summary[1 + full]).toBe(`${full} step: ok`);
    expect(summary.at(-1)).toBe(result.notes![0]);
  });

  it("keeps a failed step's summary line once the reply is full, so a late failure still says why", async () => {
    const big = "y".repeat(STEP_JSON_CHARS - 100);
    const why = `${"r".repeat(150)}\nsecond line`;
    const { port } = fake({
      reply: (name) => (name === "run_command" ? { isError: true, content: [{ type: "text", text: why }] } : { content: [], structuredContent: { big } }),
      reads: [{ met: false, text: "0 == 1" }],
    });
    const per = Math.ceil(REPLY_CHARS / (STEP_JSON_CHARS - 100)) + 1;
    const steps: Step<Cond>[] = [
      ...Array.from({ length: per }, () => call("step")),
      call("run_command", { text: "a" }),
      { expect: { kind: "log" } },
      { repeat: [call("run_command", { text: "b" })], maxIterations: 2 },
    ];
    const { result } = await run(port, scenario(steps, { onFail: "continue" }));
    expect(result.notes).toHaveLength(1);
    const cut = `${"r".repeat(100)}...`;
    expect(result.steps.slice(-3)).toEqual([
      { index: per, call: "run_command", ok: false, text: cut },
      { index: per + 1, expect: "log", ok: false, text: "not met: 0 == 1" },
      { index: per + 2, repeat: [], iterations: 1, ok: false, text: "iteration 1: step 0 failed" },
    ]);
    expect(describeScenario(result).split("\n").slice(-4, -1)).toEqual([
      `${per} run_command: FAILED - ${cut}`,
      `${per + 1} expect log: FAILED - not met: 0 == 1`,
      `${per + 2} repeat x1: FAILED - iteration 1: step 0 failed`,
    ]);
  });

  it("notes a maptime that went backwards (a map change mid-run), and only then", async () => {
    const note = "maptime went backwards (900 -> 12): a map change restarted the tic counter, so the two don't count the run's tics";
    const back = await run(fake({ maptimes: [900, 12] }).port, scenario([call("run_command", { text: "map MAP02" })]));
    expect(back.result.notes).toEqual([note]);
    expect(describeScenario(back.result).split("\n").at(-1)).toBe(note);
    for (const maptimes of [[100, 100], [100, 140], [undefined, 12], [900, undefined]]) {
      const { result } = await run(fake({ maptimes }).port, scenario([call("step")]));
      expect(result).not.toHaveProperty("notes");
    }
  });
});

describe("capStructured", () => {
  it("keeps a result that fits as it is", () => {
    expect(capStructured({ a: [1, 2], b: { c: "d" } })).toEqual({ structured: { a: [1, 2], b: { c: "d" } } });
  });

  it("cuts every array to 20 rows at any depth, counting the rows dropped", () => {
    const rows = Array.from({ length: 25 }, (_, i) => i);
    expect(capStructured({ table: { columns: ["a"], rows: [rows] }, n: null })).toEqual({
      structured: { table: { columns: ["a"], rows: [rows.slice(0, 20)] }, n: null },
      omitted: { rows: 5 },
    });
  });

  it("halves the rows until the result fits", () => {
    const actors = Array.from({ length: 20 }, (_, i) => ({ tid: i, pad: "p".repeat(150) }));
    const got = capStructured({ actors });
    expect(got.structured).toEqual({ actors: actors.slice(0, 10) });
    expect(got.omitted).toEqual({ rows: 10 });
  });

  it("cuts the JSON itself when even no rows don't fit", () => {
    const got = capStructured({ report: "r".repeat(3000), rows: [1] });
    expect(got.structured).toBe(JSON.stringify({ report: "r".repeat(3000), rows: [1] }).slice(0, STEP_JSON_CHARS));
    expect(got.omitted).toEqual({ chars: JSON.stringify({ report: "r".repeat(3000), rows: [1] }).length - STEP_JSON_CHARS });
  });
});

describe("scenarioShape", () => {
  const cond = z.object({ kind: z.literal("log"), pattern: z.string() });
  const schema = z.object(scenarioShape(cond));

  it("parses call, expect and repeat steps, with the defaults", () => {
    const got = schema.parse({
      steps: [{ call: "step" }, { expect: { kind: "log", pattern: "x" } }, { repeat: [{ call: "step", args: { tics: 5 } }], maxIterations: 3 }],
    });
    expect(got).toEqual({
      steps: [
        { call: "step", args: {} },
        { expect: { kind: "log", pattern: "x" } },
        { repeat: [{ call: "step", args: { tics: 5 } }], maxIterations: 3 },
      ],
      onFail: "stop",
      maxSeconds: 60,
    });
  });

  it("refuses a nested repeat, a step mixing kinds, and values past the caps", () => {
    const bad = [
      { steps: [{ repeat: [{ repeat: [{ call: "step" }], maxIterations: 2 }], maxIterations: 2 }] },
      { steps: [{ call: "step", expect: { kind: "log", pattern: "x" } }] },
      { steps: [{ repeat: [{ call: "step" }] }] },
      { steps: [{ repeat: [{ call: "step" }], maxIterations: 201 }] },
      { steps: Array.from({ length: 65 }, () => ({ call: "step" })) },
      { steps: [] },
      { steps: [{ call: "step" }], maxSeconds: 301 },
      { steps: [{ call: "step" }], onFail: "retry" },
    ];
    for (const input of bad) expect(schema.safeParse(input).success).toBe(false);
  });
});
