import { describe, it, expect } from "vitest";
import { parseClockStatus } from "../src/parsers/clock.js";

const STATUS = "MCP_CLOCK frozen=1 gametic=120 maptime=88 frac=1/1 interp=1 jobs=0 steps=3 shots=2 reason=done";

describe("parseClockStatus", () => {
  it("reads the status line, skipping the freeze and queue replies around it", () => {
    const lines = ["MCP_CLOCK frozen=1 gametic=119 maptime=87 restore=1 jobs=1", STATUS, "MCP_CLOCK queued jobs=2"];
    expect(parseClockStatus(lines)).toEqual({
      frozen: true,
      gametic: 120,
      maptime: 88,
      interp: true,
      jobs: 0,
      steps: 3,
      shots: 2,
      reason: "done",
      armedDemo: false,
    });
  });

  it("reads a demo-armed clock", () => {
    const line = "MCP_CLOCK frozen=0 gametic=5 maptime=4 frac=1/1 interp=1 jobs=0 steps=0 shots=0 reason=- frametime=0 framems=0 armed=demo";
    expect(parseClockStatus([line])).toMatchObject({ frozen: false, armedDemo: true });
  });

  it("carries why interpolation is off, and reads a thawed clock", () => {
    const line = "MCP_CLOCK frozen=0 gametic=5 maptime=4 frac=1/1 interp=0 nointerp=cl_capfps jobs=0 steps=0 shots=0 reason=-";
    expect(parseClockStatus([line])).toMatchObject({ frozen: false, interp: false, nointerp: "cl_capfps", reason: "-" });
  });

  it("is undefined without a status line", () => {
    expect(parseClockStatus(["MCP_CLOCK queued jobs=1", "error not frozen"])).toBeUndefined();
  });
});
