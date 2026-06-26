import { describe, it, expect } from "vitest";
import {
  parseDefines,
  parseDeclarations,
  buildIndex,
  findSymbol,
} from "../src/acs/symbols.js";

describe("parseDefines", () => {
  it("parses #define and #libdefine with tabs and trailing comments", () => {
    const text = [
      "#define SC_FOO 1017",
      "#libdefine SC_BAR\t\t979",
      "#define SC_BAZ 5 // a comment",
      "#define NOT_NUMERIC SOMETHING",
    ].join("\n");
    expect(parseDefines(text)).toEqual({ SC_FOO: 1017, SC_BAR: 979, SC_BAZ: 5 });
  });
});

describe("parseDeclarations", () => {
  it("parses numbered, named, quoted scripts and functions (case-insensitive)", () => {
    const text = [
      "script 6603 open",
      "SCRIPT SC_FOO OPEN",
      'script "OpenDoor" ENTER',
      "function int getThing (void)",
    ].join("\n");
    expect(parseDeclarations(text)).toEqual([
      { kind: "script", ref: "6603", type: "open", line: 1 },
      { kind: "script", ref: "SC_FOO", type: "OPEN", line: 2 },
      { kind: "script", ref: '"OpenDoor"', type: "ENTER", line: 3 },
      { kind: "function", ref: "getThing", type: null, line: 4 },
    ]);
  });
});

describe("buildIndex / findSymbol", () => {
  const files = [
    { path: "a/defs.acs", text: "#define SC_FOO 1017\n#libdefine SC_BAR 979" },
    {
      path: "x/y/server.acs",
      text: ["SCRIPT SC_FOO OPEN", "script 6603 open", 'script "OpenDoor" ENTER'].join("\n"),
    },
    { path: "client.acs", text: "function int helper (void)" },
  ];

  it("resolves names to numbers and numbers to names, with basename + line", () => {
    const idx = buildIndex(files);
    // named-via-define script: SC_FOO -> 1017
    expect(findSymbol(idx, "1017")).toEqual([
      { kind: "script", name: "SC_FOO", number: 1017, file: "server.acs", line: 1, type: "OPEN" },
    ]);
    // by name resolves the same symbol
    expect(findSymbol(idx, "sc_foo")[0].number).toBe(1017); // case-insensitive
    // raw numbered script with no define -> name null
    expect(findSymbol(idx, "6603")[0]).toMatchObject({ number: 6603, name: null });
    // quoted (named) script -> number null
    expect(findSymbol(idx, "OpenDoor")[0]).toMatchObject({ name: "OpenDoor", number: null });
    // function
    expect(findSymbol(idx, "helper")[0]).toMatchObject({ kind: "function", file: "client.acs" });
  });

  it("returns no matches for unknown refs", () => {
    expect(findSymbol(buildIndex(files), "nope")).toEqual([]);
    expect(findSymbol(buildIndex(files), "424242")).toEqual([]);
  });

  it("resolves define references case-insensitively (ACS identifiers are)", () => {
    const idx = buildIndex([
      { path: "d.acs", text: "#libdefine SC_CL_Effects 979" },
      { path: "c.acs", text: "script SC_CL_EFFECTS (void) NET CLIENTSIDE {" },
    ]);
    expect(findSymbol(idx, "979")[0]).toMatchObject({ number: 979, name: "SC_CL_EFFECTS" });
  });

  it("covers numbered-with-define, unknown-name, and typeless scripts", () => {
    const idx = buildIndex([
      { path: "d.acs", text: "#define KNOWN 500" },
      { path: "s.acs", text: "script 500 open\nscript Unknown OPEN\nscript 7" },
    ]);
    expect(findSymbol(idx, "500")[0]).toMatchObject({ number: 500, name: "KNOWN" });
    expect(findSymbol(idx, "Unknown")[0]).toMatchObject({ name: "Unknown", number: null });
    expect(findSymbol(idx, "7")[0]).toMatchObject({ number: 7, name: null, type: null });
  });
});
