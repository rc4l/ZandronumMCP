import { describe, it, expect } from "vitest";
import {
  matchLines,
  kvPairs,
  parseKv,
  parseKvLines,
  statusRow,
  kvNumbers,
  firstError,
  hasHeader,
  failureText,
  outputText,
  stripColor,
  cleanConsoleLines,
} from "../src/parsers/lines.js";
import { joinedBots, allHaveTid, addBotReport } from "../src/parsers/players.js";
import { parseFindActors } from "../src/parsers/actorstate.js";

describe("matchLines", () => {
  it("splits multi-line chunks, trims, and maps only matching lines", () => {
    const got = matchLines(["  a 1\r\nb 2", "a 3"], /^a (\d)$/, (m) => Number(m[1]));
    expect(got).toEqual([1, 3]);
  });
});

describe("kvPairs", () => {
  it("splits each token at its first '=' and skips tokens with no key", () => {
    expect(kvPairs(["a=1", "b=c=d", "bare", "=x", "e="])).toEqual([
      ["a", "1"],
      ["b", "c=d"],
      ["e", ""],
    ]);
  });
});

describe("parseKv", () => {
  it("coerces numbers, keeps strings, and skips bare tokens", () => {
    expect(parseKv("slot=0 x=-1.5 weapon=Pistol junk =bad")).toEqual({ slot: 0, x: -1.5, weapon: "Pistol" });
  });

  it("takes name= as the rest of the line, even with spaces or '='", () => {
    expect(parseKv("slot=1 name=Big Bot a=b")).toEqual({ slot: 1, name: "Big Bot a=b" });
  });

  it("handles a leading name= and keeps a numeric name a string", () => {
    expect(parseKv("name=123")).toEqual({ name: "123" });
  });

  it("keeps the values of the named string keys uncoerced", () => {
    expect(parseKv("sprite=0000 tics=5", ["sprite"])).toEqual({ sprite: "0000", tics: 5 });
  });

  it("takes another rest-of-line key when asked, leaving name= an ordinary key", () => {
    expect(parseKv("n=1 name=x note=a b name=c", [], "note")).toEqual({ n: 1, name: "x", note: "a b name=c" });
    expect(parseKv("note=7", [], "note")).toEqual({ note: "7" });
  });
});

describe("parseKvLines / firstError", () => {
  it("parses only lines with the given tag", () => {
    expect(parseKvLines(["MCP_X", "view angle=90 pitch=-10", "viewer a=1"], "view")).toEqual([
      { angle: 90, pitch: -10 },
    ]);
  });

  it("finds the first error line, or none", () => {
    expect(firstError(["ok", "error no actor with tid 5", "error later"])).toBe("no actor with tid 5");
    expect(firstError(["ok"])).toBeUndefined();
  });
});

describe("statusRow / kvNumbers", () => {
  it("picks the first tagged line carrying the key, past the replies around it", () => {
    const lines = ["MCP_X active=1 armed=1", "MCP_X active=1 steps=3 total=7", "MCP_X active=0 steps=4"];
    expect(statusRow(lines, "MCP_X", "steps")).toEqual({ active: 1, steps: 3, total: 7 });
    expect(statusRow(lines, "MCP_X", "shots")).toBeUndefined();
  });

  it("reads the asked keys as numbers, a missing one as NaN", () => {
    expect(kvNumbers({ a: 1, b: "2", c: "x" }, ["a", "b", "d"])).toEqual({ a: 1, b: 2, d: NaN });
  });
});

describe("hasHeader / failureText", () => {
  it("finds a header only as a whole line", () => {
    expect(hasHeader(["x", " MCP_FOUND ", "found a=1"], "MCP_FOUND")).toBe(true);
    expect(hasHeader(["MCP_FOUNDX", "Unknown command"], "MCP_FOUND")).toBe(false);
  });

  it("prefers the error line, then the raw output, then a placeholder", () => {
    expect(failureText(["noise", "error no player"])).toBe("no player");
    expect(failureText(["Unknown command \"findactors\""])).toBe('Unknown command "findactors"');
    expect(failureText([" ", ""])).toBe("(no output)");
  });
});

describe("outputText", () => {
  it("joins what was printed, or says nothing was", () => {
    expect(outputText(["a", "b\n"])).toBe("a\nb");
    expect(outputText([" ", ""])).toBe("(no output)");
  });
});

describe("stripColor / cleanConsoleLines", () => {
  it("drops letter and named colour escapes", () => {
    expect(stripColor("\x1cGred \x1c[Gold]gold \x1c-plain")).toBe("red gold plain");
  });

  it("splits, strips bars and colours, and drops blank lines", () => {
    const bar = "\x1d" + "\x1e".repeat(5) + "\x1f";
    expect(cleanConsoleLines([`\n${bar}\n\n\x1c+MAP01 - entryway  \r\n`, "next\n"])).toEqual([
      "MAP01 - entryway",
      "next",
    ]);
  });

  it("drops the engine's bar line, whole lines only, and keeps it when the engine has none", () => {
    const lines = ["\x1c-" + "-".repeat(40), "-- not a bar", "-".repeat(41)];
    expect(cleanConsoleLines(lines, /^-{40}$/)).toEqual(["-- not a bar", "-".repeat(41)]);
    expect(cleanConsoleLines(lines)).toEqual(["-".repeat(40), "-- not a bar", "-".repeat(41)]);
  });

  it("returns nothing for empty output", () => {
    expect(cleanConsoleLines([])).toEqual([]);
    expect(cleanConsoleLines(["\n", " "])).toEqual([]);
  });
});

describe("joinedBots", () => {
  const read = parseKvLines([
    "player slot=0 bot=0 spec=0 tid=0 name=Player",
    "player slot=1 bot=1 spec=0 tid=3 name=Old",
    "player slot=2 bot=1 spec=0 x=0.0 tid=0 name=\x1cGNew",
    "player slot=3 bot=1 state=enter name=Bodiless",
    "player slot=4 bot=1 spec=1 deadspec=0",
    "player slot=5 bot=0 spec=0 tid=9 name=Human",
  ], "player");

  it("keeps only bots at a new slot that have a body or a spectator seat", () => {
    expect(joinedBots(new Set([0, 1]), read)).toEqual([
      { slot: 2, name: "New", tid: 0, spectator: false },
      { slot: 4, name: "", tid: 0, spectator: true },
    ]);
  });

  it("calls the TID wait done once every playing bot has one; spectators don't count", () => {
    const bot = (tid: number, spectator = false) => ({ slot: 1, name: "B", tid, spectator });
    expect(allHaveTid([bot(3), bot(0, true)])).toBe(true);
    expect(allHaveTid([bot(3), bot(0)])).toBe(false);
    expect(allHaveTid([])).toBe(true);
  });
});

describe("addBotReport", () => {
  const bot = (slot: number, tid: number, spectator = false) => ({ slot, name: `B${slot}`, tid, spectator });
  const run = { levelChanges: 1, count: 3, tidTics: 35, tics: 40, said: "said", capped: ["cap"] };

  it("lists the bots, notes a missing TID and a short count, and names the bots a level change removed", () => {
    const seen = [{ bot: bot(1, 5), changes: 1 }, { bot: bot(2, 0), changes: 1 }, { bot: bot(3, 7), changes: 0 }];
    const r = addBotReport({ ...run, bots: [bot(1, 5), bot(2, 0)], seen });
    expect(r).toEqual({
      lines: [
        "B1 joined at slot 1, tid 5",
        "B2 joined at slot 2, tid 0: none assigned within 35 tic(s)",
        "B3 joined at slot 3, then a level change removed it (level_change)",
        "cap",
      ],
      notes: ["B2 joined at slot 2, tid 0: none assigned within 35 tic(s)", "cap"],
      lost: [{ slot: 3, name: "B3", reason: "level_change" }],
    });
    const short = addBotReport({ ...run, bots: [bot(1, 0, true)], seen: [], tidTics: 0 });
    expect("lines" in short && short.lines).toEqual(["B1 joined at slot 1 as a spectator (join queue)", "only 1 of 3 joined; addbot said: said", "cap"]);
  });

  it("fails with what addbot said when none joined or none is left", () => {
    expect(addBotReport({ ...run, bots: [], seen: [] })).toEqual({ error: "no bot joined within 40 tic(s); addbot said: said\ncap" });
    const gone = addBotReport({ ...run, bots: [], seen: [{ bot: bot(1, 5), changes: 0 }] });
    expect("error" in gone && gone.error).toMatch(/^B1 joined at slot 1, then a level change removed it .*\nnone left in the game after 40 tic\(s\)/);
  });
});

describe("parseFindActors", () => {
  it("expands flag letters, ignoring unknown and '-' ones", () => {
    const found = parseFindActors([
      "MCP_FOUND",
      "found class=DoomImp tid=5 hp=60 flags=msoz target=player0",
      "found class=Column tid=0 hp=1000 flags=-",
      "found class=Odd tid=0",
    ]);
    expect(found.actors[0]).toMatchObject({ class: "DoomImp", flags: "monster,shootable,solid", target: "player0" });
    expect(found.actors[1].flags).toBe("");
    expect(found.actors[2].flags).toBeUndefined();
    expect(found.truncated).toBeUndefined();
  });

  it("passes a TID result's walk index through, for actor_state(tid, index)", () => {
    const found = parseFindActors(["MCP_FOUND", "found class=DoomImp tid=7 dist=48.0 index=2 flags=m"]);
    expect(found.actors[0]).toMatchObject({ tid: 7, index: 2 });
  });

  it("reports truncation", () => {
    const found = parseFindActors(["found class=A tid=0", "truncated shown=1 total=9"]);
    expect(found.truncated).toEqual({ shown: 1, total: 9 });
  });
});
