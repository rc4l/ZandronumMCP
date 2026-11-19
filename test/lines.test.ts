import { describe, it, expect } from "vitest";
import {
  matchLines,
  kvPairs,
  parseKv,
  parseKvLines,
  firstError,
  hasHeader,
  outputText,
  failureText,
  stripColor,
  cleanConsoleLines,
} from "../src/parsers/lines.js";

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
});

describe("parseKvLines / firstError", () => {
  it("parses only lines with the given tag", () => {
    expect(parseKvLines(["MCP_X", "view angle=90 pitch=-10", "viewer a=1"], "view")).toEqual([
      { angle: 90, pitch: -10 },
    ]);
  });

  it("returns one record per `dumpplayers` line, with only the fields the engine printed", () => {
    const players = parseKvLines(
      [
        "MCP_PLAYERS",
        "player slot=0 bot=0 spec=0 deadspec=0 state=live hp=100 cheats=2 ping=0 name=Player",
        "player slot=1 bot=1 spec=0 deadspec=0 state=live cheats=0 ping=0 name=Doom Guy",
      ],
      "player",
    );
    expect(players).toHaveLength(2);
    expect(players[1]).toMatchObject({ slot: 1, bot: 1, name: "Doom Guy" });
    expect(players[1].hp).toBeUndefined();
  });

  it("finds the first error line, or none", () => {
    expect(firstError(["ok", "error no actor with tid 5", "error later"])).toBe("no actor with tid 5");
    expect(firstError(["ok"])).toBeUndefined();
  });
});

describe("hasHeader", () => {
  it("needs the header on a line of its own", () => {
    expect(hasHeader(["noise\nMCP_FOUND", "found class=A"], "MCP_FOUND")).toBe(true);
    expect(hasHeader(["MCP_FOUND extra", "xMCP_FOUND"], "MCP_FOUND")).toBe(false);
  });
});

describe("outputText / failureText", () => {
  it("joins what was printed, or says nothing was", () => {
    expect(outputText(["a", "b\n"])).toBe("a\nb");
    expect(outputText([" ", ""])).toBe("(no output)");
  });

  it("prefers the CCMD's error line over the rest of its output", () => {
    expect(failureText(["noise", "error unknown class Imp"])).toBe("unknown class Imp");
    expect(failureText(["Unknown command"])).toBe("Unknown command");
    expect(failureText([])).toBe("(no output)");
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
