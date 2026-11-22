import { describe, it, expect } from "vitest";
import { parseInputStatus, parseInputArmed, parseInputTrail } from "../src/parsers/input.js";

describe("parseInputStatus", () => {
  it("reads the status line among other MCP_INPUT replies", () => {
    const out = ["MCP_INPUT cleared", "MCP_INPUT active=1 consumed=3 total=10 seg=2 maptime=412 reason=-"];
    expect(parseInputStatus(out)).toEqual({ active: true, consumed: 3, total: 10, seg: 2, maptime: 412, reason: "-" });
    expect(parseInputStatus(["MCP_INPUT active=0 consumed=10 total=10 seg=2 maptime=419 reason=done"])).toMatchObject({
      active: false,
      reason: "done",
    });
  });

  it("is undefined when no status line came back", () => {
    expect(parseInputStatus(["MCP_INPUT idle", "Unknown command"])).toBeUndefined();
  });
});

describe("parseInputArmed", () => {
  it("reads the armed line, and is undefined when go refused", () => {
    expect(parseInputArmed(["MCP_INPUT seg 1 total=5", "MCP_INPUT armed segs=1 tics=5 maptime=77"])).toEqual({
      segs: 1,
      tics: 5,
      maptime: 77,
    });
    expect(parseInputArmed(["MCP_INPUT cleared", "error empty timeline"])).toBeUndefined();
  });
});

describe("parseInputTrail", () => {
  const START = "start maptime=412 seg=0 x=200.000 y=100.000 z=-32.000 angle=0.000 pitch=0.000 momx=0.0000 momy=0.0000 momz=0.0000 health=100 buttons=-";
  const TIC = "tic maptime=412 seg=1 x=201.563 y=100.000 z=-32.000 angle=90.000 pitch=-5.500 momx=1.4160 momy=-0.0001 momz=0.0000 health=97 buttons=attack,use";

  it("reads the start row and one row per tic", () => {
    // Game output before the header that happens to start with a row tag is not a row.
    const trail = parseInputTrail(["tic 412", "start wave 2", "MCP_INPUT_TRAIL", START, TIC]);
    expect(trail?.start).toMatchObject({ maptime: 412, seg: 0, x: 200, z: -32, buttons: [] });
    expect(trail?.rows).toEqual([
      {
        maptime: 412, seg: 1, x: 201.563, y: 100, z: -32, angle: 90, pitch: -5.5,
        momx: 1.416, momy: -0.0001, momz: 0, health: 97, buttons: ["attack", "use"],
      },
    ]);
  });

  it("has no start row when the trail was read from a later index", () => {
    expect(parseInputTrail(["MCP_INPUT_TRAIL", TIC])).toMatchObject({ start: undefined, rows: [{ seg: 1 }] });
  });

  it("is undefined without the header", () => {
    expect(parseInputTrail(["Unknown command mcp_input", TIC])).toBeUndefined();
  });
});
