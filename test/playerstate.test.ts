import { describe, it, expect } from "vitest";
import { parsePlayerState, parseTarget } from "../src/parsers/playerstate.js";

describe("parsePlayerState", () => {
  it("parses currentpos including negative coordinates", () => {
    const line =
      "Current player position: (128.500,-64.000,0.000), angle: 270.000, floorheight: -8.000, sector:12, lightlevel: 144";
    expect(parsePlayerState([line])).toEqual({
      x: 128.5,
      y: -64,
      z: 0,
      angle: 270,
      floorHeight: -8,
      sector: 12,
      light: 144,
    });
  });
  it("returns null when there is no position line", () => {
    expect(parsePlayerState(["nothing here"])).toBeNull();
  });
});

describe("parseTarget", () => {
  it("parses a linetarget result", () => {
    expect(parseTarget(["Target=DoomImp, Health=60, Spawnhealth=60"])).toEqual({
      target: "DoomImp",
      health: 60,
      spawnHealth: 60,
    });
  });
  it("returns null when nothing is aimed at", () => {
    expect(parseTarget(["(no target)"])).toBeNull();
  });
});
