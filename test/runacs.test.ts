import { describe, it, expect } from "vitest";
import { parseRunAcs, parseRunScript, runAcsCaveats, runAcsText, scriptOutput } from "../src/parsers/runacs.js";

describe("parseRunAcs", () => {
  it("parses the reply line among the script's own output", () => {
    expect(parseRunAcs(["runacs ok", "MCP_RUNACS module=3 scripts=2 started=named deferred=1"])).toEqual({
      module: 3,
      scripts: 2,
      started: "named",
      deferred: true,
    });
    expect(parseRunAcs(["MCP_RUNACS module=0 scripts=1 started=none deferred=0"])?.deferred).toBe(false);
  });

  it("isn't fooled by a snippet print that starts with the reply's tag", () => {
    expect(parseRunAcs(["MCP_RUNACS hello from my script", "MCP_RUNACS module=2 scripts=1 started=1 deferred=1"])).toMatchObject({
      module: 2,
      started: "1",
    });
  });

  it("returns undefined without a well-formed reply line", () => {
    expect(parseRunAcs(["error netgame"])).toBeUndefined();
    expect(parseRunAcs(["MCP_RUNACS oops"])).toBeUndefined();
  });
});

describe("parseRunScript", () => {
  it("parses the reply line among the script's own output", () => {
    expect(parseRunScript(["hi", "", "MCP_RUNSCRIPT script=Answer started=1 result=42 finished=1 module=2"])).toEqual({
      script: "Answer",
      started: true,
      result: 42,
      finished: true,
      module: 2,
    });
    expect(parseRunScript(["MCP_RUNSCRIPT script=901 started=0 result=0 finished=0 module=0"])).toEqual({
      script: "901",
      started: false,
      result: 0,
      finished: false,
      module: 0,
    });
  });

  it("keeps a name with spaces whole and reads a negative result", () => {
    expect(parseRunScript(["MCP_RUNSCRIPT script=Open Door started=1 result=-3 finished=0 module=11"])).toMatchObject({
      script: "Open Door",
      result: -3,
      module: 11,
    });
  });

  it("returns undefined without a reply line", () => {
    expect(parseRunScript(["error no script Nope"])).toBeUndefined();
  });
});

describe("scriptOutput", () => {
  it("splits, right-trims and drops blank lines, and separates the reply line", () => {
    expect(scriptOutput(["one  \n\n  two", "", "MCP_X a=1", "MCP_XY kept"], "MCP_X")).toEqual({
      lines: ["one", "  two", "MCP_X a=1", "MCP_XY kept"],
      printed: ["one", "  two", "MCP_XY kept"],
    });
  });
});

describe("runAcsText", () => {
  const reply = { module: 2, scripts: 3, started: "1", deferred: false };
  const SAVE = /^save_game refuses until the map changes/;

  it("leads with the load line and the body, and ends on the save warning", () => {
    const lines = runAcsText(reply, ["profile: p.json", "hi"]).split("\n");
    expect(lines.slice(0, 3)).toEqual(["loaded snippet as module 2 (3 script(s)), started 1", "profile: p.json", "hi"]);
    expect(lines).toHaveLength(4);
    expect(lines[3]).toMatch(SAVE);
  });

  it("flags scripts that fire later, ahead of the save warning", () => {
    const caveats = runAcsCaveats({ ...reply, deferred: true });
    expect(caveats[0]).toMatch(/^The snippet has DEATH\/ENTER\/RESPAWN/);
    expect(caveats[1]).toMatch(SAVE);
    expect(runAcsText({ ...reply, deferred: true }, []).split("\n").slice(1)).toEqual(caveats);
  });
});
