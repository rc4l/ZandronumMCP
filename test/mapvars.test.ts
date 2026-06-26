import { describe, it, expect } from "vitest";
import { parseMapVar, parseMapArray, parseModules } from "../src/parsers/mapvars.js";

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
