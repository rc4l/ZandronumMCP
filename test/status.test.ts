import { describe, it, expect } from "vitest";
import { parseStatus, describeStatus, footerNote, isPaused, statusBlockers, requireField } from "../src/parsers/status.js";

const SENTINEL = "__MCPDONE_a1__";

describe("parseStatus", () => {
  it("returns undefined for the legacy bare-echo form (just the sentinel)", () => {
    expect(parseStatus(SENTINEL, SENTINEL)).toBeUndefined();
  });

  it("returns undefined for a line that isn't the status line at all", () => {
    expect(parseStatus("Unknown actor 'DoomImp'", SENTINEL)).toBeUndefined();
  });

  it("parses every key=value field off the status line", () => {
    const line = `${SENTINEL} paused=0 menu=off console=up gamestate=level player=alive spectating=0 demo=0 automap=0 chat=0 demorec=0 health=100 armor=0`;
    expect(parseStatus(line, SENTINEL)).toEqual({
      paused: "0",
      menu: "off",
      console: "up",
      gamestate: "level",
      player: "alive",
      spectating: "0",
      demo: "0",
      automap: "0",
      chat: "0",
      demorec: "0",
      health: "100",
      armor: "0",
    });
  });

  it("skips a token with no (or leading) '=' and keeps the rest", () => {
    const line = `${SENTINEL} paused=0 garbage menu=on`;
    expect(parseStatus(line, SENTINEL)).toEqual({ paused: "0", menu: "on" });
  });
});

describe("describeStatus", () => {
  it("returns undefined when nothing is unusual", () => {
    const status = {
      paused: "0",
      menu: "off",
      console: "up",
      gamestate: "level",
      player: "alive",
      spectating: "0",
      demo: "0",
      automap: "0",
      chat: "0",
      demorec: "0",
    };
    expect(describeStatus(status)).toBeUndefined();
  });

  it("names an open menu by class and reports every other unusual condition", () => {
    const status = {
      paused: "1",
      pauseext: "1",
      menu: "on",
      menuclass: "DOptionMenu",
      console: "down",
      gamestate: "intermission",
      player: "dead",
      spectating: "1",
      demo: "1",
      automap: "1",
      chat: "1",
      demorec: "1",
      pending: "1",
      acstemp: "2",
    };
    expect(describeStatus(status)).toBe(
      "Engine state: paused, paused by focus loss (pauseext), a menu is open (DOptionMenu), console is down, " +
        "not in a level (intermission), player is dead, spectating, " +
        "playing back a demo, automap is open, chat input is open, " +
        "recording a demo, a map/save/demo load is pending, " +
        "2 run_acs snippet module(s) loaded (saves refused until the map changes).",
    );
  });

  it("reports a frozen clock as a blocker", () => {
    const status = { paused: "0", frozen: "1" };
    expect(describeStatus(status)).toBe("Engine state: time is frozen (freeze_time off resumes).");
    expect(statusBlockers(status)).toEqual(["time is frozen (freeze_time off resumes)"]);
    expect(statusBlockers({ frozen: "0" })).toEqual([]);
  });

  it("reports an open menu with no class, and no player as distinct from a dead one", () => {
    const status = {
      paused: "0",
      menu: "on",
      console: "up",
      gamestate: "level",
      player: "none",
      spectating: "0",
      demo: "0",
      automap: "0",
    };
    expect(describeStatus(status)).toBe("Engine state: a menu is open, no player.");
  });

  it("treats a field the connected bridge never sent as normal, not unusual", () => {
    const status = {
      paused: "0",
      menu: "off",
      console: "up",
      gamestate: "level",
      player: "alive",
      spectating: "0",
      // demo omitted entirely -- an older bridge that predates a field
      automap: "0",
    };
    expect(describeStatus(status)).toBeUndefined();
  });
});

describe("footerNote", () => {
  const PAUSED = "Engine state: paused.";
  const MENU = "Engine state: paused, a menu is open.";
  const NORMAL = "Engine state: back to normal.";

  it.each<[string, string | undefined, string | undefined, boolean, string | undefined]>([
    ["prints the first unusual note", undefined, PAUSED, false, PAUSED],
    ["suppresses a repeat", PAUSED, PAUSED, false, undefined],
    ["prints the whole note when it changed", PAUSED, MENU, false, MENU],
    ["says back to normal when the note cleared", PAUSED, undefined, false, NORMAL],
    ["stays silent while normal", undefined, undefined, false, undefined],
    ["repeats an unchanged note on an error", PAUSED, PAUSED, true, PAUSED],
    ["says back to normal on an error too", PAUSED, undefined, true, NORMAL],
    ["adds nothing to an error while normal", undefined, undefined, true, undefined],
  ])("%s", (_name, prev, note, isError, expected) => {
    expect(footerNote(prev, note, isError)).toBe(expected);
  });
});

describe("statusBlockers / requireField", () => {
  it("has no blockers to list without a snapshot", () => {
    expect(statusBlockers(undefined)).toEqual([]);
  });

  it("hands back the snapshot when it carries the field", () => {
    const status = { maptime: "7" };
    expect(requireField(status, true, "maptime")).toEqual({ status });
  });

  it("names a bridge without the status cap, a missing field (with the hint) and a timed-out read", () => {
    expect(requireField(undefined, false, "maptime")).toEqual({
      error: "this engine bridge has no status support (rebuild with the latest bridge)",
    });
    expect(requireField({ paused: "0" }, true, "cheats", ", or there is no player")).toEqual({
      error:
        "the engine's status snapshot has no cheats= field (rebuild the engine with the latest overlay), or there is no player",
    });
    expect(requireField(undefined, true, "maptime")).toEqual({
      error: "status read timed out (engine busy, e.g. loading a map); retry",
    });
  });
});

describe("isPaused", () => {
  it("reads any non-zero pause, a focus pause's -1 included, and no snapshot as paused", () => {
    expect([{ paused: "0" }, { paused: "1" }, { paused: "-1" }, {}, undefined].map(isPaused)).toEqual([false, true, true, true, true]);
  });
});
