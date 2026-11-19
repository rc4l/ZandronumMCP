import { describe, it, expect } from "vitest";
import { splitCaptures } from "../scripts/split-captures.core.mjs";
import { categorize, renderToolsDoc, staleOutputs } from "../scripts/gen-tools-doc.core.mjs";

describe("splitCaptures", () => {
  it("gives each marker the lines after its correlator, and a status marker its correlator", () => {
    const log = [
      "before any marker",
      "CAPTURE first",
      "__MCPDONE_1__",
      "reply a",
      "__MCPDONE_x__ paused=0",
      "reply b",
      "",
      "",
      "CAPTURE status_x",
      "__MCPDONE_2__ paused=1",
      "ignored",
      "CAPTURE uncorrelated",
      "no correlator yet",
      "CAPTURE end",
      "__MCPDONE_3__",
      "tail",
    ];
    expect(splitCaptures(log)).toEqual([
      { name: "first", lines: ["reply a", "reply b"] },
      { name: "status_x", lines: ["__MCPDONE_2__ paused=1"] },
      { name: "uncorrelated", lines: [] },
    ]);
  });

  it("writes an empty line for a status marker that never got its correlator", () => {
    expect(splitCaptures(["CAPTURE status"])).toEqual([{ name: "status", lines: [""] }]);
  });
});

describe("categorize", () => {
  const source = [
    'register("early", {});',
    "  // --- level & maps (stock) ----",
    'register("load_map", {});',
    "  // --- actors ---",
    'registerLive(\n    "find_actors", {});',
    'server.registerTool(\n    "screenshot", {});',
  ].join("\n");

  it("takes the last section comment above each tool's literal, General before the first", () => {
    const tools = [{ name: "early" }, { name: "load_map" }, { name: "find_actors" }, { name: "screenshot" }];
    expect(categorize(source, tools).map((t: { category: string }) => t.category)).toEqual(["General", "level & maps", "actors", "actors"]);
  });

  it("refuses a tool with no register literal", () => {
    expect(() => categorize(source, [{ name: "ghost" }])).toThrow(/No register\("ghost"/);
  });
});

describe("renderToolsDoc", () => {
  it("lists categories in first-seen order with the tool count", () => {
    const md = renderToolsDoc([
      { name: "b", description: "B.", category: "actors" },
      { name: "a", description: "A.", category: "general" },
      { name: "c", description: "C.", category: "actors" },
    ]);
    expect(md).toContain("**3 tools**");
    expect(md.indexOf("## Actors")).toBeLessThan(md.indexOf("## General"));
    expect(md).toMatch(/## Actors\n\n- \*\*`b`\*\* — B\.\n- \*\*`c`\*\* — C\.\n/);
  });
});

describe("staleOutputs", () => {
  it("flags missing and changed files, not a CRLF copy of the same text", () => {
    const disk: Record<string, string> = { "/fresh": "a\r\nb\n", "/changed": "old\n" };
    const outputs: [string, string][] = [["/fresh", "a\nb\n"], ["/changed", "new\n"], ["/missing", "x\n"]];
    expect(staleOutputs(outputs, (p: string) => disk[p]).map(([p]: [string, string]) => p)).toEqual(["/changed", "/missing"]);
  });
});
