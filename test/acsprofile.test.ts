import { describe, it, expect } from "vitest";
import {
  isTruncated,
  parseAcsProfile,
  rankProfile,
  resolveProfileNames,
  type ProfileEntry,
  type ProfileSort,
} from "../src/parsers/acsprofile.js";
import type { ScriptInfo } from "../src/parsers/scripts.js";

const row = (section: ProfileEntry["section"], name: string, over: Partial<ProfileEntry> = {}): ProfileEntry => ({
  section, module: "BEHAVIOR", name, total: 10, runs: 1, avg: 10, min: 10, max: 10, ...over,
});

describe("isTruncated", () => {
  it("flags a quoted script name missing its closing quote and a function name filling the 20-character column", () => {
    const cases: [ProfileEntry, boolean][] = [
      [row("script", '"OpenDoor"'), false],
      [row("script", '"MarkUnreachableSpot'), true],
      [row("script", "901"), false],
      [row("function", "a".repeat(19)), false],
      [row("function", "a".repeat(20)), true],
      [row("function", "Function 7"), false],
    ];
    expect(cases.filter(([e, want]) => isTruncated(e) !== want)).toEqual([]);
  });
});

describe("resolveProfileNames", () => {
  const modules = [
    { id: 0, name: "BEHAVIOR" },
    { id: 1, name: "BEHAVIOR2" },
  ];
  const script = (module: number, name: string | null): ScriptInfo => ({ module, number: 1, name, type: 0, args: 0 });
  const scripts = [
    script(0, "MarkUnreachableSpots"),
    script(0, null),
    script(1, "MarkUnreachableSpotsToo"),
    script(0, "OS_SCRIPT_OPEN_CLIENT"),
    script(0, "OS_SCRIPT_OPEN_CLIENT2"),
  ];
  const functions = [{ module: 0, index: 0, name: "spinfunctionthatislong" }];
  const resolve = (e: ProfileEntry) => resolveProfileNames([e], modules, scripts, functions)[0];

  it("replaces a truncated name with the one full name in its module, case-insensitively, re-quoting a script", () => {
    expect(resolve(row("script", '"markunreachablespot'))).toEqual(row("script", '"MarkUnreachableSpots"'));
    expect(resolve(row("function", "SPINFUNCTIONTHATISLO"))).toEqual(row("function", "spinfunctionthatislong"));
  });

  it("matches a module by its whole name, case-insensitively", () => {
    expect(resolve(row("script", '"MarkUnreachableSpot', { module: "behavior" })).name).toBe('"MarkUnreachableSpots"');
    // BEHAVIOR doesn't stand for BEHAVIOR2, so its script isn't a second candidate.
    expect(resolve(row("script", '"MarkUnreachableSpot')).truncated).toBeUndefined();
  });

  it("keeps the printed prefix and sets truncated when several names or none fit", () => {
    expect(resolve(row("script", '"OS_SCRIPT_OPEN_CLIE'))).toEqual(row("script", '"OS_SCRIPT_OPEN_CLIE', { truncated: true }));
    expect(resolve(row("script", '"NoSuchScriptAtAllXY'))).toMatchObject({ name: '"NoSuchScriptAtAllXY', truncated: true });
    expect(resolve(row("script", '"MarkUnreachableSpot', { module: "OTHER" }))).toMatchObject({ truncated: true });
  });

  it("counts one name once when two candidate modules both have it", () => {
    const twin = [{ id: 3, name: "TWINLIB" }, { id: 4, name: "twinlib" }];
    const both = [script(3, "TwinScriptNameIsLong"), script(4, "TwinScriptNameIsLong")];
    const e = row("script", '"TwinScriptNameIsLon', { module: "TWINLIB" });
    expect(resolveProfileNames([e], twin, both, [])[0].name).toBe('"TwinScriptNameIsLong"');
  });

  it("leaves rows that weren't cut untouched", () => {
    const rows = [row("script", "901"), row("script", '"OpenDoor"'), row("function", "fn")];
    expect(resolveProfileNames(rows, [], [], [])).toEqual(rows);
  });
});

describe("rankProfile", () => {
  const rows = [
    row("script", "a", { total: 10, runs: 5, avg: 2, min: 1, max: 3 }),
    row("script", "b", { total: 30, runs: 1, avg: 30, min: 30, max: 30 }),
    row("script", "c", { total: 20, runs: 2, avg: 10, min: 9, max: 11 }),
    row("function", "f", { total: 5, runs: 1, avg: 5, min: 5, max: 5 }),
  ];
  const names = (sort?: ProfileSort, limit?: number) => rankProfile(rows, sort, limit).entries.map((e) => e.name);

  it("sorts each section descending by the key, total by default", () => {
    const want: [ProfileSort | undefined, string[]][] = [
      [undefined, ["b", "c", "a", "f"]],
      ["total", ["b", "c", "a", "f"]],
      ["runs", ["a", "c", "b", "f"]],
      ["avg", ["b", "c", "a", "f"]],
      ["min", ["b", "c", "a", "f"]],
      ["max", ["b", "c", "a", "f"]],
    ];
    expect(want.filter(([sort, order]) => names(sort).join() !== order.join())).toEqual([]);
  });

  it("keeps the engine's order on ties", () => {
    const tied = [row("script", "x"), row("script", "y"), row("script", "z")];
    expect(rankProfile(tied).entries.map((e) => e.name)).toEqual(["x", "y", "z"]);
  });

  it("limits each section separately (10 by default) and counts every row that ran", () => {
    expect(names("total", 1)).toEqual(["b", "f"]);
    const many = Array.from({ length: 12 }, (_, i) => row("script", String(i)));
    const ranked = rankProfile([...many, ...rows.slice(3)]);
    expect(ranked.entries).toHaveLength(11);
    expect(ranked.profiled).toEqual({ scripts: 12, functions: 1 });
  });

  it("drops never-run rows before limiting, so they neither show nor take a slot", () => {
    const ranked = rankProfile([row("script", "idle", { runs: 0, total: 99 }), ...rows], "total", 1);
    expect(ranked.entries.map((e) => e.name)).toEqual(["b", "f"]);
    expect(ranked.profiled).toEqual({ scripts: 3, functions: 1 });
  });
});

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
