import { describe, it, expect } from "vitest";
import { formatMark, parseMarks, resolveGamelog } from "../src/parsers/marks.js";
import { norm } from "./fakes/paths.js";

const numbered = (texts: string[]) => texts.map((text, i) => ({ line: i + 1, text }));

describe("parseMarks", () => {
  it("parses a full mark, gamelog timestamp included", () => {
    const [m] = parseMarks(
      numbered([
        "[12:01:02] MCP_MARK n=3 tic=4500 maptime=4200 map=MAP01 x=-800.0 y=700.5 z=8.0 angle=90.0 round=4 wave=2 " +
          "shot=mcp_mark_7777_20261011-120102_3 note=door stuck  at the=gate",
      ]),
    );
    expect(m).toEqual({
      n: 3, tic: 4500, maptime: 4200, map: "MAP01", x: -800, y: 700.5, z: 8, angle: 90, round: 4, wave: 2,
      shot: "mcp_mark_7777_20261011-120102_3", note: "door stuck  at the=gate", time: "12:01:02", line: 1,
    });
  });

  it("parses a minimal mark: no position, round, wave, shot or note", () => {
    expect(parseMarks(numbered(["MCP_MARK n=1 tic=10 maptime=0 map=MAP01 shot=none note="]))).toEqual([
      { n: 1, tic: 10, maptime: 0, map: "MAP01", note: "", line: 1 },
    ]);
  });

  it("skips a mark line with no n, and reads a mark with no map or note as empty strings", () => {
    expect(parseMarks(numbered(["MCP_MARK tic=1 maptime=1 map=MAP01", "MCP_MARK n=4 tic=1 maptime=1"]))).toEqual([
      { n: 4, tic: 1, maptime: 1, map: "", note: "", line: 2 },
    ]);
  });

  it("keeps round=none, a dated timestamp, and a numeric map name as a string", () => {
    const [m] = parseMarks(
      numbered(["\x1cG[26:10:11;12:00:00] MCP_MARK n=2 tic=5 maptime=5 map=01 round=none shot=none note=x"]),
    );
    expect(m).toMatchObject({ map: "01", round: "none", time: "26:10:11;12:00:00", note: "x" });
    expect(m.shot).toBeUndefined();
  });

  it("ignores other lines and keeps each mark's log line", () => {
    const marks = parseMarks(
      numbered(["God ON", "MCP_MARK n=1 tic=1 maptime=1 map=MAP01 shot=a note=a", "say MCP_MARK n=9", "MCP_MARK n=2 tic=2 maptime=2 map=MAP01 shot=b"]),
    );
    expect(marks.map((m) => [m.n, m.line, m.note])).toEqual([[1, 2, "a"], [2, 4, ""]]);
  });
});

describe("formatMark", () => {
  it("prints every field present", () => {
    expect(
      formatMark({
        n: 3, tic: 4500, maptime: 4200, map: "MAP01", x: -800, y: 700, z: 8, angle: 90, round: 4, wave: 2,
        shot: "s", note: "door", time: "12:01:02", line: 7,
      }),
    ).toBe("#3 MAP01 tic=4500 maptime=4200 at -800,700,8 angle=90 round=4 wave=2 time=12:01:02 shot=s (log line 7): door");
  });

  it("prints a minimal mark", () => {
    expect(formatMark({ n: 1, tic: 1, maptime: 0, map: "MAP01", note: "", line: 2 })).toBe(
      "#1 MAP01 tic=1 maptime=0 no shot (log line 2): ",
    );
  });
});

describe("resolveGamelog", () => {
  it("takes an absolute path as given, a bare name in the dir, and refuses the rest", () => {
    expect(resolveGamelog("/logs/a.log", "/g", "X_EXE")).toEqual({ file: "/logs/a.log" });
    expect(resolveGamelog("a.log", "/g", "X_EXE")).toEqual({ file: norm("/g/a.log") });
    expect(resolveGamelog("sub/a.log", "/g", "X_EXE")).toEqual({ error: "gamelog wants an absolute path or a bare file name: sub/a.log" });
    expect(resolveGamelog("a.log", undefined, "X_EXE")).toEqual({ error: "gamelog wants an absolute path (no gamelog dir: X_EXE is unset): a.log" });
  });
});
