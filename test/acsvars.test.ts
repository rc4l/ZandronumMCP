import { describe, it, expect } from "vitest";
import { parseAcsVars } from "../src/parsers/acsvars.js";

describe("parseAcsVars", () => {
  it("parses a single get result", () => {
    expect(parseAcsVars(["acsvar world 5 = 42"])).toEqual([{ scope: "world", index: 5, value: 42 }]);
  });

  it("parses a dump of several vars including negatives", () => {
    const out = [
      "MCP_ACSVARS",
      "acsvar world 0 = 1",
      "acsvar world 5 = -7",
      "acsvar global 2 = 100",
    ];
    expect(parseAcsVars(out)).toEqual([
      { scope: "world", index: 0, value: 1 },
      { scope: "world", index: 5, value: -7 },
      { scope: "global", index: 2, value: 100 },
    ]);
  });

  it("ignores usage/error lines and the header", () => {
    expect(parseAcsVars(["index out of range (0-255)", "MCP_ACSVARS"])).toEqual([]);
  });

  it("handles multiple lines in one chunk", () => {
    expect(parseAcsVars(["acsvar world 1 = 1\nacsvar global 0 = 9"])).toHaveLength(2);
  });
});
