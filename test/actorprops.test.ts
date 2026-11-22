import { describe, it, expect } from "vitest";
import { PROPS, PROP_NAMES, FORCEABLE_PROPS, isFlagProp, encodePropValue, PropValueError } from "../src/actorprops.js";

describe("actor prop table", () => {
  it("names every prop with a type, size props forceable", () => {
    expect(PROP_NAMES).toContain("speed");
    expect(PROPS.nametag).toBe("t");
    expect([...FORCEABLE_PROPS]).toEqual(["height", "radius"]);
  });

  it("recognises flag: props by shape only", () => {
    expect(isFlagProp("flag:NOGRAVITY")).toBe(true);
    expect(isFlagProp("flag:ACTOR.FRIENDLY")).toBe(true);
    expect(isFlagProp("flag:")).toBe(false);
    expect(isFlagProp("flag:A B")).toBe(false);
    expect(isFlagProp("speed")).toBe(false);
  });
});

describe("encodePropValue", () => {
  it("sends nothing for the read form", () => {
    expect(encodePropValue("speed", undefined)).toEqual([]);
  });

  it("encodes each type as string tokens", () => {
    expect(encodePropValue("speed", 0.5)).toEqual(["0.5"]);
    expect(encodePropValue("alpha", -2)).toEqual(["-2"]);
    expect(encodePropValue("mass", 100)).toEqual(["100"]);
    expect(encodePropValue("friendly", true)).toEqual(["1"]);
    expect(encodePropValue("dormant", false)).toEqual(["0"]);
    expect(encodePropValue("flag:NOGRAVITY", 1)).toEqual(["1"]);
    expect(encodePropValue("flag:NOGRAVITY", 0)).toEqual(["0"]);
    expect(encodePropValue("renderstyle", " Translucent ")).toEqual(["Translucent"]);
    expect(encodePropValue("nametag", "  Imp   Lord ")).toEqual(["Imp", "Lord"]);
  });

  it.each([
    ["speed", "fast"],
    ["speed", Number.POSITIVE_INFINITY],
    ["speed", Number.NaN],
    ["speed", true],
    ["mass", 1.5],
    ["mass", "100"],
    ["friendly", 2],
    ["friendly", "yes"],
    ["flag:NOGRAVITY", "1"],
    ["species", 3],
    ["species", ""],
    ["nametag", "   "],
    ["species", "Two Words"],
    ["species", "$sv_cheats"],
    ["nametag", "Lord $name"],
    ["nametag", "Caf\u00e9 Lord"],
  ] as const)("rejects %s = %j", (prop, value) => {
    expect(() => encodePropValue(prop, value)).toThrow(PropValueError);
    expect(() => encodePropValue(prop, value)).toThrow(`bad value ${JSON.stringify(value)} for ${prop}`);
  });
});
