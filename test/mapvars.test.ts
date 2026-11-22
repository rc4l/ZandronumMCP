import { describe, it, expect } from "vitest";
import { parseMapVar, parseMapArray, parseMapSlot, parseModules } from "../src/parsers/mapvars.js";

describe("parseMapVar", () => {
  it("returns the value", () => {
    expect(parseMapVar(["mapvar deathtoll = 42"])).toBe(42);
    expect(parseMapVar(["mapvar score = -3"])).toBe(-3);
  });
  it("returns null when not found", () => {
    expect(parseMapVar(["mapvar Credits not found"])).toBeNull();
  });
});

describe("parseMapArray", () => {
  it("returns the element value", () => {
    expect(parseMapArray(["maparray Credits[2] = 500"])).toBe(500);
  });
  it("returns null when not found", () => {
    expect(parseMapArray(["maparray Nope not found"])).toBeNull();
  });
});

describe("parseMapSlot", () => {
  it("parses the scalar and element forms, name last with the rest of the line", () => {
    expect(parseMapSlot(["MCP_MAPSLOT module=1 slot=4 value=-7 name=MAPSLOT"])).toEqual({ module: 1, slot: 4, value: -7, name: "MAPSLOT" });
    expect(parseMapSlot(["noise\nMCP_MAPSLOT module=0 slot=6 index=5 value=104 name=MY LIB"])).toEqual({
      module: 0,
      slot: 6,
      index: 5,
      value: 104,
      name: "MY LIB",
    });
  });

  it("returns undefined without a reply line", () => {
    expect(parseMapSlot(["error no module matches map=MAP01 modules=2"])).toBeUndefined();
    expect(parseMapSlot(["MCP_MAPSLOT module=0 slot=x value=1 name=A"])).toBeUndefined();
  });
});

describe("parseModules", () => {
  it("parses loaded modules", () => {
    const out = ["MCP_MODULES", "module 0 ACSLEVEL", "module 1 AOWLIB"];
    expect(parseModules(out)).toEqual([
      { id: 0, name: "ACSLEVEL" },
      { id: 1, name: "AOWLIB" },
    ]);
  });
  it("handles a chunked stream and ignores the header", () => {
    expect(parseModules(["MCP_MODULES\nmodule 3 X"])).toEqual([{ id: 3, name: "X" }]);
  });
});
