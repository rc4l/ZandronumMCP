/** run_scenario's input schema and limits. */
import { z } from "zod";

export const MAX_STEPS = 64;
export const MAX_CALLS = 256;
export const MAX_ITERATIONS = 200;
export const MAX_SECONDS = 300;

/** Why run_scenario refuses a tool, named in that tool's registration: each stays a call of its own. */
export const SCENARIO_REFUSALS = {
  lifecycle: "process lifecycle",
  image: "replies with an inline image; use screenshot_file",
  nested: "scenarios don't nest",
} as const;

/** run_scenario's inputs besides instance; `condition` is step_until's condition schema. */
export function scenarioShape<C extends z.ZodTypeAny>(condition: C) {
  const call = z
    .object({
      call: z.string().min(1).describe("A tool name."),
      args: z.record(z.unknown()).default({}).describe("That tool's own args, without instance."),
    })
    .strict();
  const expect = z.object({ expect: condition }).strict();
  const repeat = z
    .object({
      repeat: z.array(z.union([call, expect])).min(1).max(MAX_STEPS),
      until: condition.optional(),
      maxIterations: z.number().int().min(1).max(MAX_ITERATIONS),
    })
    .strict();
  return {
    steps: z.array(z.union([call, expect, repeat])).min(1).max(MAX_STEPS),
    onFail: z.enum(["stop", "continue"]).default("stop"),
    maxSeconds: z.number().positive().max(MAX_SECONDS).default(60),
  };
}
