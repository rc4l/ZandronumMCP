import { describe, it, expect } from "vitest";
import { parseScriptStat } from "../src/parsers/scriptstat.js";

describe("parseScriptStat", () => {
  it("returns nothing when idle", () => {
    expect(parseScriptStat(["No scripts are running."])).toEqual([]);
  });

  it("ignores UZDoom's per-level header", () => {
    expect(parseScriptStat(["Script status for MAP01", "No scripts are running."])).toEqual([]);
    expect(parseScriptStat(["Script status for MAP01", "script 5: Running"])).toEqual([
      { number: 5, name: null, state: "Running" },
    ]);
  });

  it("parses numbered scripts", () => {
    const scripts = parseScriptStat(["script 5: Running", "script 12: Delayed"]);
    expect(scripts).toEqual([
      { number: 5, name: null, state: "Running" },
      { number: 12, name: null, state: "Delayed" },
    ]);
  });

  it("parses named scripts", () => {
    expect(parseScriptStat(['script "OpenDoor": Suspended'])).toEqual([
      { number: null, name: "OpenDoor", state: "Suspended" },
    ]);
  });

  it("handles several lines arriving in one chunk", () => {
    const scripts = parseScriptStat(["script 1: Running\nscript 2: ScriptWait"]);
    expect(scripts).toHaveLength(2);
  });

  it("ignores lines that aren't a script presentation", () => {
    expect(parseScriptStat(["script weird: Running", "unrelated text"])).toEqual([]);
  });
});
