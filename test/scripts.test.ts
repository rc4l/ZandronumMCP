import { describe, it, expect } from "vitest";
import { parseScripts, parseFunctions } from "../src/parsers/scripts.js";

describe("parseScripts", () => {
  const out = [
    "MCP_SCRIPTS",
    "script 0 1 - 1 0",
    "script 1 -5 OpenDoor 4 2",
  ];
  it("parses numbered and named scripts", () => {
    expect(parseScripts(out)).toEqual([
      { module: 0, number: 1, name: null, type: 1, args: 0 },
      { module: 1, number: -5, name: "OpenDoor", type: 4, args: 2 },
    ]);
  });
  it("ignores the header and other noise", () => {
    expect(parseScripts(["MCP_SCRIPTS", "blah"])).toEqual([]);
  });
});

describe("parseFunctions", () => {
  it("parses function names (which may contain spaces? names are identifiers)", () => {
    const out = ["MCP_FUNCTIONS", "function 0 0 GiveCredits", "function 1 3 ResetTeam"];
    expect(parseFunctions(out)).toEqual([
      { module: 0, index: 0, name: "GiveCredits" },
      { module: 1, index: 3, name: "ResetTeam" },
    ]);
  });
  it("handles a chunked stream", () => {
    expect(parseFunctions(["function 2 1 Foo\nfunction 2 2 Bar"])).toHaveLength(2);
  });
});
