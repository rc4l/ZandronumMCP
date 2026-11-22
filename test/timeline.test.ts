import { describe, it, expect } from "vitest";
import {
  segmentArg,
  planTimeline,
  scheduleCommand,
  walkCommand,
  splitLog,
  summarizeSegments,
  describeTimeline,
  MAX_TICS,
  type Segment,
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
    for (const to of [{ x: 0, y: 1 }, { tid: 5 }, { class: "DoomImp" }]) {
      expect(segmentArg.safeParse({ to, radius: 0, speed: 0.5, pass: true, buttons: ["use"] }).success).toBe(true);
    }
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
      { to: { x: 0, y: 0, z: 1 } },
      { to: { x: 32768, y: 0 } },
      { to: { tid: 0 } },
      { to: { class: "bad class" } },
      { to: { x: 0, y: 0 }, radius: -1 },
      { to: { x: 0, y: 0 }, radius: 32768 },
      { to: { x: 0, y: 0 }, speed: 0 },
      { to: { x: 0, y: 0 }, speed: 1.1 },
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
      segTics: 6,
      walks: 0,
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
    expect(planTimeline([{ tics: 2000 }, { tics: 100 }])).toMatchObject({ segTics: MAX_TICS });
  });

  it("mixes walks and timed entries, holding buttons and setting the whole-run limits", () => {
    expect(planTimeline([
      { to: { x: 64, y: 0 }, buttons: ["use", "attack"] },
      { tics: 5 },
      { to: { tid: 7 }, radius: 2, speed: 0.5, pass: true },
    ], 100, 10)).toEqual({
      segTics: 5, walks: 2, limits: { maxTics: 100, stuckTics: 10 },
      commands: ["mcp_input walk pt:64,0 0 0 1 use,attack", "mcp_input seg 5 - 0 0 0 - 0 -", "mcp_input walk tid:7 2 1 0.5 -"],
    });
    expect(planTimeline([{ to: { class: "Imp" } }])).toMatchObject({ segTics: 0, walks: 1, limits: { maxTics: MAX_TICS, stuckTics: 35 } });
    expect(planTimeline([{ tics: 5 }], 10)).toMatchObject({ limits: { maxTics: 10, stuckTics: 35 } });
    expect(planTimeline([{ tics: 5 }], 5)).toMatchObject({ limits: { maxTics: 5 } });
    expect(planTimeline([{ tics: 5 }], 4)).toEqual({ error: "maxTics 4 is below the timed total 5" });
    expect(planTimeline([{ tics: 5 }])).not.toHaveProperty("limits");
  });

  it("names each refused segment form and every walk-owned field", () => {
    for (const segment of [{}, { tics: 1, to: { tid: 1 } }]) {
      expect(planTimeline([{ tics: 1 }, segment])).toEqual({ error: "segment 2: give tics or to, not both" });
    }
    for (const to of [{}, { x: 1 }, { y: 1 }, { tid: 1, class: "Imp" }, { x: 1, y: 2, tid: 1 }]) {
      expect(planTimeline([{ to }])).toEqual({ error: "segment 1: give exactly one of x and y, tid or class in to" });
    }
    for (const field of ["forward", "side", "up", "angle", "turn", "pitch"]) {
      expect(planTimeline([{ to: { tid: 1 }, [field]: 0 }])).toEqual({ error: "segment 1: a walk takes no forward, side, up, angle, turn or pitch" });
    }
    for (const field of [{ radius: 0 }, { speed: 1 }, { pass: false }]) {
      expect(planTimeline([{ tics: 1, ...field }])).toEqual({ error: "segment 1: radius, speed and pass are walk-only" });
    }
  });
});

describe("scheduleCommand", () => {
  it("stops and clears first, then arms with the pause to restore", () => {
    expect(scheduleCommand(["mcp_input seg 1 - 0 0 0 - 0 -"], true)).toBe(
      "mcp_input stop; mcp_input clear; mcp_input seg 1 - 0 0 0 - 0 -; mcp_input go 1",
    );
    expect(scheduleCommand([], false)).toBe("mcp_input stop; mcp_input clear; mcp_input go 0");
  });

  it("passes go a tic limit and stuck window when given", () => {
    expect(scheduleCommand([], true, { maxTics: 350, stuckTics: 35 })).toBe(
      "mcp_input stop; mcp_input clear; mcp_input go 1 350 35",
    );
  });
});

describe("walkCommand", () => {
  it("writes each target form, stand-off, pass and speed", () => {
    expect(walkCommand({ target: { x: 512, y: -64.25 }, standoff: 0, pass: false, speed: 1 })).toBe(
      "mcp_input walk pt:512,-64.25 0 0 1 -",
    );
    expect(walkCommand({ target: { tid: 7 }, standoff: 64, pass: true, speed: 0.5 })).toBe("mcp_input walk tid:7 64 1 0.5 -");
    expect(walkCommand({ target: { class: "HealthBonus" }, standoff: 1 / 3, pass: false, speed: 1 })).toBe(
      "mcp_input walk class:HealthBonus 0.3333 0 1 -",
    );
    expect(walkCommand({ target: { tid: 1 }, standoff: 0, pass: false, speed: 1, buttons: [] })).toBe("mcp_input walk tid:1 0 0 1 -");
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

  it("summarizes zero-tic walks at the start, middle and end without consuming time", () => {
    const entries: Segment[] = [{ to: { x: 0, y: 0 } }, { tics: 1 }, { to: { tid: 1 } }, { tics: 1 }, { to: { class: "Imp" } }];
    const summaries = summarizeSegments(start, [row(100, 2, 5), row(101, 4, 6)], new Map(), {
      entries, done: 5, reason: "done", dist: 2, target: { x: 8, y: 0 },
    });
    expect(summaries.map((s) => [s.seg, s.start, s.end, s.tics])).toEqual([[1, 100, 100, 0], [2, 100, 100, 1], [3, 101, 101, 0], [4, 101, 101, 1], [5, 102, 102, 0]]);
    expect(summaries[0].walk).toEqual({ target: entries[0].to, outcome: "arrived", distance: 0 });
    expect(summaries[2]).toMatchObject({ from: { x: 5 }, to: { x: 5 }, walk: { target: { tid: 1 }, outcome: "arrived" } });
    expect(summaries[2].walk).not.toHaveProperty("distance");
    expect(summaries[4].walk).toEqual({ target: { class: "Imp" }, outcome: "arrived", distance: 2, at: { x: 8, y: 0 } });
  });

  it.each(["stuck", "timeout", "target_gone", "died", "stopped", "level_change"])("summarizes the failed walk without a trail row: %s", (reason) => {
    const entries: Segment[] = [{ tics: 1 }, { to: { tid: 9 } }, { tics: 1 }];
    const summaries = summarizeSegments(start, [row(100, 1, 5)], new Map(), { entries, done: 1, reason });
    expect(summaries).toHaveLength(2);
    expect(summaries[1]).toMatchObject({ seg: 2, start: 101, end: 101, tics: 0, from: { x: 5 }, to: { x: 5 }, walk: { outcome: reason } });
    expect(summaries[1].walk).not.toHaveProperty("distance");
  });

  it("keeps completed and failed walks with rows, computes earlier point distances, and omits unreached timed entries", () => {
    const entries: Segment[] = [{ to: { x: 10, y: 0 } }, { to: { tid: 2 } }, { tics: 1 }];
    const summaries = summarizeSegments(start, [row(101, 1, 9), row(103, 2, 20)], new Map(), { entries, done: 1, reason: "stuck", dist: 37.2 });
    expect(summaries.map((s) => s.walk)).toEqual([
      { target: { x: 10, y: 0 }, outcome: "arrived", distance: 1 },
      { target: { tid: 2 }, outcome: "stuck", distance: 37.2 },
    ]);
    expect(summarizeSegments(start, [row(100, 1, 5)], new Map(), { entries: [{ to: { tid: 1 } }, { tics: 1 }], done: 1, reason: "timeout" })).toHaveLength(1);
    expect(summarizeSegments(start, [], new Map(), { entries: [{ tics: 1 }], done: 0, reason: "done" })).toEqual([]);
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

  it("names walk targets and outcomes and closes mixed runs with the entry and optional limit", () => {
    const entries: Segment[] = [{ to: { tid: 5 } }, { to: { class: "Imp" } }, { to: { x: 100, y: 0 } }];
    const summaries = summarizeSegments(row(100, 0, 0), [row(100, 1, 10), row(101, 2, 20), row(102, 3, 30)], new Map(), { entries, done: 2, reason: "stuck", dist: 70 });
    const planned = { segments: 3, tics: 0, walks: 3, done: 2, limit: 350 };
    const text = describeTimeline("stuck", summaries, planned, 3);
    expect(text).toContain("seg 1/3 walk to tid 5 maptime");
    expect(text).toContain("seg 2/3 walk to class Imp maptime");
    expect(text).toContain("seg 3/3 walk to (100, 0) maptime");
    expect(text).toContain("health 100: arrived");
    expect(text).toContain("health 100: stuck, 70.0 from target");
    expect(text).toMatch(/stuck in seg 3\/3 after 3 tic\(s\)$/);
    expect(describeTimeline("timeout", summaries, planned, 350)).toMatch(/timeout in seg 3\/3 after 350 tic\(s\) \(limit 350\)$/);
    expect(describeTimeline("done", summaries, { ...planned, done: 3 }, 3)).toMatch(/done in seg 3\/3 after 3 tic\(s\)$/);
  });
});
