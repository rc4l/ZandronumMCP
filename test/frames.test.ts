import { describe, it, expect } from "vitest";
import {
  clockEndText,
  describeTicRun,
  frameName,
  planSweep,
  MAX_SWEEP_FRAMES,
  MAX_SWEEP_IMAGES,
  SHOT_FRAMES,
} from "../src/clock/frames.js";
import { CAPTURE_TAG } from "../src/screenshot/tag.js";

describe("end reasons", () => {
  it("words every engine reason and passes a refusal through", () => {
    for (const r of ["paused", "level_change", "stalled", "stopped", "nointerp", "not in a level", "demo_end"]) expect(clockEndText(r)).not.toBe(r);
    expect(clockEndText("menu or console open")).toBe("menu or console open");
  });

  it("describes a full and a short frozen step", () => {
    expect(describeTicRun({ ran: 35, end: "done" })).toBe("advanced 35 tic(s) (frozen clock)");
    expect(describeTicRun({ ran: 2, end: "stalled" })).toBe(`advanced 2 tic(s) (frozen clock); stopped: ${clockEndText("stalled")}`);
  });
});

describe("frameName", () => {
  it("namespaces by the server's capture tag", () => {
    expect(frameName(3, 1, "4242_ab12cd")).toBe("mcp_frame_4242_ab12cd_3_1");
    expect(frameName(3, 1)).toBe(`mcp_frame_${CAPTURE_TAG}_3_1`);
  });
});

describe("planSweep", () => {
  const name = (i: number) => `f${i}`;

  it("sweeps 0..of-1 of the last tic by default", () => {
    const plan = planSweep({ of: 4, tics: 0, output: "image" }, name);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.jobs).toEqual(["mcp_clock shot f0 0 4", "mcp_clock shot f1 1 4", "mcp_clock shot f2 2 4", "mcp_clock shot f3 3 4"]);
    expect(plan.frames.map((f) => [f.tic, f.k, f.frac])).toEqual([[0, 0, 0], [0, 1, 0.25], [0, 2, 0.5], [0, 3, 0.75]]);
    expect(plan.units).toBe(4 * SHOT_FRAMES);
  });

  it("steps one tic before each pass, numbering frames across passes", () => {
    const plan = planSweep({ of: 2, frames: [2, 0], tics: 2, output: "file" }, name);
    if ("error" in plan) throw new Error(plan.error);
    expect(plan.jobs).toEqual([
      "mcp_clock step 1",
      "mcp_clock shot f0 2 2",
      "mcp_clock shot f1 0 2",
      "mcp_clock step 1",
      "mcp_clock shot f2 2 2",
      "mcp_clock shot f3 0 2",
    ]);
    expect(plan.frames.map((f) => f.tic)).toEqual([1, 1, 2, 2]);
    expect(plan.units).toBe(2 + 4 * SHOT_FRAMES);
  });

  it("refuses a frame past of, too many frames, and too many inline images", () => {
    expect(planSweep({ of: 4, frames: [0, 5], tics: 0, output: "file" }, name)).toEqual({
      error: "frame 5 is past of (4): frames lie in 0..4",
    });
    expect(planSweep({ of: 40, frames: [0, 1, 2, 3, 4], tics: 13, output: "file" }, name)).toEqual({
      error: `65 frames (frames x tics) is over ${MAX_SWEEP_FRAMES}: sweep fewer frames or tics`,
    });
    expect(planSweep({ of: 64, tics: 1, output: "file" }, name)).not.toHaveProperty("error");
    expect(planSweep({ of: 3, tics: 3, output: "image" }, name)).toEqual({
      error: `9 images is over ${MAX_SWEEP_IMAGES} inline: use output "file", or fewer frames or tics`,
    });
    expect(planSweep({ of: 8, tics: 0, output: "image" }, name)).not.toHaveProperty("error");
  });
});
