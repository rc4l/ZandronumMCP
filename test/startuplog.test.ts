import { describe, it, expect } from "vitest";
import { parseStartupErrors, tailLines } from "../src/process/startuplog.js";

const SAMPLE = [
  "Resolving GL extensions",
  "adding doom2.wad, 2919 lumps",
  'Script error, "DECORATE" line 12:',
  "Expected '}' but got 'Foo'",
  "Execution could not continue.",
  "2 errors while parsing DECORATE scripts",
  "Init game engine.",
].join("\n");

describe("parseStartupErrors", () => {
  it("extracts compile/fatal error lines and ignores normal startup chatter", () => {
    const errs = parseStartupErrors(SAMPLE);
    expect(errs).toEqual([
      'Script error, "DECORATE" line 12:',
      "Expected '}' but got 'Foo'",
      "Execution could not continue.",
      "2 errors while parsing DECORATE scripts",
    ]);
    expect(errs).not.toContain("adding doom2.wad, 2919 lumps");
  });

  it("returns nothing for a clean log", () => {
    expect(parseStartupErrors("adding doom2.wad\nInit game engine.\nplaying")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(parseStartupErrors("ok\r\nScript error, foo\r\nok")).toEqual(["Script error, foo"]);
  });
});

describe("tailLines", () => {
  it("returns the last n non-empty lines", () => {
    expect(tailLines("a\n\nb\nc\n\n", 2)).toEqual(["b", "c"]);
  });

  it("defaults to 40 lines and skips blanks", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n");
    const out = tailLines(log);
    expect(out).toHaveLength(40);
    expect(out[out.length - 1]).toBe("line 99");
  });
});
