import { describe, it, expect } from "vitest";
import {
  segmentArg,
  planTimeline,
  scheduleCommand,
  splitLog,
  summarizeSegments,
  describeTimeline,
  MAX_TICS,
} from "../src/input/timeline.js";
import type { InputRow } from "../src/parsers/input.js";

const row = (maptime: number, seg: number, x: number, over: Partial<InputRow> = {}): InputRow => ({
  maptime, seg, x, y: 0, z: 8, angle: 0, pitch: 0, momx: 0, momy: 0, momz: 0, health: 100, buttons: [], ...over,
});

describe("segmentArg", () => {
  it("accepts a full segment and a bare tic count", () => {
    expect(segmentArg.safeParse({ tics: 1 }).success).toBe(true);
    const full = { tics: 35, buttons: ["attack", "user1"], forward: 1, side: -0.5, up: 0, angle: 90, pitch: -30 };
    expect(segmentArg.safeParse(full).success).toBe(true);
  });

  it("rejects unknown fields, bad tics, out-of-range axes and unsafe button names", () => {
    const bad = [
      { tics: 1, button: ["attack"] },
      { tics: 0 },
      { tics: 1.5 },
      { tics: MAX_TICS + 1 },
      { tics: 1, forward: 1.5 },
      { tics: 1, side: -2 },
      { tics: 1, turn: 181 },
      { tics: 1, pitch: 91 },
      { tics: 1, angle: Infinity },
      { tics: 1, buttons: ["attack;quit"] },
      { tics: 1, buttons: [""] },
    ];
    for (const s of bad) expect(segmentArg.safeParse(s).success, JSON.stringify(s)).toBe(false);
  });
});

describe("planTimeline", () => {
  it("converts axes to ticcmd units and builds one seg command per segment", () => {
    const plan = planTimeline([
      { tics: 2, buttons: ["attack", "use"], forward: 1, side: -1, up: 1 },
      { tics: 3, buttons: [], forward: 0.5, side: 0.6, up: -0.5, angle: 90, pitch: -12.34567 },
      { tics: 1, turn: -1.5 },
    ]);
    expect(plan).toEqual({
      total: 6,
      commands: [
        "mcp_input seg 2 attack,use 12800 -10240 768 - 0 -",
        "mcp_input seg 3 - 6400 6144 -384 90 0 -12.3457",
        "mcp_input seg 1 - 0 0 0 - -1.5 -",
      ],
    });
  });

  it("wraps an absolute angle into [0, 360) and never sends exponent form", () => {
    const angles = [450, -90, 360, 1e-9, -1e-9].map((angle) => {
      const plan = planTimeline([{ tics: 1, angle }]);
      return "commands" in plan ? plan.commands[0].split(" ")[7] : plan.error;
    });
    expect(angles).toEqual(["90", "270", "0", "0", "360"]);
  });

  it("refuses angle with turn, naming the segment, and a total over the cap", () => {
    expect(planTimeline([{ tics: 1 }, { tics: 1, angle: 0, turn: 0 }])).toEqual({
      error: "segment 2: give angle or turn, not both",
    });
    expect(planTimeline([{ tics: 2000 }, { tics: 101 }])).toEqual({
      error: "2101 tics in all; the limit is 2100 (60 s)",
    });
    expect(planTimeline([{ tics: 2000 }, { tics: 100 }])).toMatchObject({ total: MAX_TICS });
  });
});

describe("scheduleCommand", () => {
  it("stops and clears first, then arms with the pause to restore", () => {
    expect(scheduleCommand(["mcp_input seg 1 - 0 0 0 - 0 -"], true)).toBe(
      "mcp_input stop; mcp_input clear; mcp_input seg 1 - 0 0 0 - 0 -; mcp_input go 1",
    );
    expect(scheduleCommand([], false)).toBe("mcp_input stop; mcp_input clear; mcp_input go 0");
  });
});

describe("splitLog", () => {
  it("splits on segment markers, dropping bridge replies and anything outside the run", () => {
    const logs = splitLog([
      "before the run",
      "MCP_INPUT cleared",
      "MCP_INPUT_SEG 1 maptime=100",
      "bang",
      "MCP_INPUT active=1 consumed=1 total=3 seg=1 maptime=101 reason=-",
      "bang again",
      "MCP_INPUT_SEG 2 maptime=102",
      "MCP_INPUT_SEG 3 maptime=103",
      "door opens",
      "MCP_INPUT_END reason=done consumed=3 maptime=104",
      "after the run",
      "MCP_INPUT_SEG 9 maptime=999",
    ]);
    expect([...logs]).toEqual([
      [1, ["bang", "bang again"]],
      [2, []],
      [3, ["door opens"]],
    ]);
  });

  it("is empty without a marker", () => {
    expect(splitLog(["noise"]).size).toBe(0);
  });
});

describe("summarizeSegments", () => {
  const start = row(100, 0, 0);

  it("summarizes from the full trail or from each segment's last row alike", () => {
    const full = [row(100, 1, 5), row(101, 1, 12), row(102, 2, 12, { angle: 90, health: 80 })];
    const logs = new Map([[1, ["bang"]]]);
    const expected = [
      { seg: 1, start: 100, end: 101, tics: 2, from: { x: 0, y: 0, z: 8 }, to: { x: 12, y: 0, z: 8 }, angle: 0, health: 100, log: ["bang"] },
      { seg: 2, start: 102, end: 102, tics: 1, from: { x: 12, y: 0, z: 8 }, to: { x: 12, y: 0, z: 8 }, angle: 90, health: 80, log: [] },
    ];
    expect(summarizeSegments(start, full, logs)).toEqual(expected);
    expect(summarizeSegments(start, [full[1], full[2]], logs)).toEqual(expected);
  });

  it("has no segments when no tic ran", () => {
    expect(summarizeSegments(start, [], new Map())).toEqual([]);
  });
});

describe("describeTimeline", () => {
  const segments = summarizeSegments(row(100, 0, 0), [row(101, 1, 12.34), row(102, 2, 12.34, { angle: 90 })], new Map([[2, ["a", "b"]]]));

  it("prints one line per segment with its log indented", () => {
    expect(describeTimeline("done", segments, { segments: 2, tics: 3 }, 3)).toBe(
      [
        "seg 1/2 maptime 100-101 (2 tic(s)): (0.0, 0.0, 8.0) -> (12.3, 0.0, 8.0) angle 0.0, health 100",
        "seg 2/2 maptime 102-102 (1 tic(s)): (12.3, 0.0, 8.0) -> (12.3, 0.0, 8.0) angle 90.0, health 100",
        "  a",
        "  b",
      ].join("\n"),
    );
  });

  it("ends with the reason and tic count when the run ended early", () => {
    expect(describeTimeline("level_change", segments.slice(0, 1), { segments: 3, tics: 40 }, 2)).toBe(
      "seg 1/3 maptime 100-101 (2 tic(s)): (0.0, 0.0, 8.0) -> (12.3, 0.0, 8.0) angle 0.0, health 100\nlevel_change after 2 of 40 tic(s)",
    );
    expect(describeTimeline("stopped", [], { segments: 1, tics: 5 }, 0)).toBe("stopped after 0 of 5 tic(s)");
  });
});
