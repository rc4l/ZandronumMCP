import { describe, it, expect } from "vitest";
import { parseAcsProfile } from "../src/parsers/acsprofile.js";

describe("parseAcsProfile", () => {
  // Mirrors the engine's ShowProfileData layout (script section then functions).
  const out = [
    "Top 2 scripts:",
    "Module       script                    Total    Runs     Avg     Min     Max",
    "------------ -------------------- ---------- ------- ------- ------- -------",
    "AOW2SCRP     1                          5000     100      50      10     200",
    'AOW2SCRP     "OpenDoor"                  300       3     100      80     140',
    "All functions:",
    "Module       function                  Total    Runs     Avg     Min     Max",
    "------------ -------------------- ---------- ------- ------- ------- -------",
    "AOW2SCRP     Function 7                  120       4      30      20      45",
  ];

  it("parses script and function rows into sections", () => {
    const entries = parseAcsProfile(out);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      section: "script", module: "AOW2SCRP", name: "1", total: 5000, runs: 100, avg: 50, min: 10, max: 200,
    });
    expect(entries[1]).toMatchObject({ section: "script", name: '"OpenDoor"', total: 300, runs: 3 });
    expect(entries[2]).toEqual({
      section: "function", module: "AOW2SCRP", name: "Function 7", total: 120, runs: 4, avg: 30, min: 20, max: 45,
    });
  });

  it("strips colour codes and ignores headers/separators", () => {
    const colored = ["\x1c[Gold]Top 1 scripts:", "Module x", "----- -----", "MOD a 1 2 3 4 5"];
    const entries = parseAcsProfile(colored);
    expect(entries).toEqual([
      { section: "script", module: "MOD", name: "a", total: 1, runs: 2, avg: 3, min: 4, max: 5 },
    ]);
  });

  it("handles a row whose prefix is only a module (no name)", () => {
    expect(parseAcsProfile(["SOLO 10 2 5 4 6"])).toEqual([
      { section: "script", module: "SOLO", name: "", total: 10, runs: 2, avg: 5, min: 4, max: 6 },
    ]);
  });

  it("skips lines that aren't data rows", () => {
    expect(parseAcsProfile(["just some text", "partial 1 2 3"])).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseAcsProfile([])).toEqual([]);
  });
});
