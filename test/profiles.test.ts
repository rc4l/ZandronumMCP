import { describe, it, expect } from "vitest";
import { buildPrelude, harvestDefines, importsOf, parseProfile, profilesFor, type RunAcsProfile } from "../src/acs/profiles.js";
import { abs } from "./fakes/paths.js";

const PROFILE = abs("/mods/orc/scripts/mcp-run-acs.json");

function profile(over: Partial<RunAcsProfile> = {}): RunAcsProfile {
  return { file: PROFILE, imports: ["osacs.acs"], includeDirs: [], rawDefines: false, defineFiles: [], defines: {}, ...over };
}

describe("parseProfile", () => {
  it("resolves relative includeDirs and defineFiles against the profile's own dir, and fills defaults", () => {
    const p = parseProfile(
      JSON.stringify({ imports: ["osacs.acs"], includeDirs: [".", "/abs/lib"], rawDefines: true, defineFiles: ["osdefs.acs"], defines: { MCP_PROBE: "1" } }),
      PROFILE,
    );
    expect(p).toEqual({
      file: PROFILE,
      imports: ["osacs.acs"],
      includeDirs: [abs("/mods/orc/scripts"), abs("/abs/lib")],
      rawDefines: true,
      defineFiles: [abs("/mods/orc/scripts/osdefs.acs")],
      defines: { MCP_PROBE: "1" },
    });
    expect(parseProfile('{"imports":["a.acs"]}', PROFILE)).toEqual(profile({ imports: ["a.acs"] }));
  });

  it("names the file and the field for bad JSON, a missing or empty imports, an unknown key and a bad define", () => {
    expect(() => parseProfile("{", PROFILE)).toThrow(new RegExp(`run_acs profile ${PROFILE.replaceAll("\\", "\\\\")}: not JSON`));
    expect(() => parseProfile("{}", PROFILE)).toThrow(/imports: Required/);
    expect(() => parseProfile('{"imports":[]}', PROFILE)).toThrow(/imports: Array must contain at least 1/);
    expect(() => parseProfile('{"imports":["a"],"includeDir":["."]}', PROFILE)).toThrow(/\(top\): Unrecognized key\(s\) in object: 'includeDir'/);
    expect(() => parseProfile("[]", PROFILE)).toThrow(/\(top\): Expected object/);
  });

  it("refuses an empty, blank or multi-line define value and a define name that isn't an identifier", () => {
    const bad = (defines: unknown) => () => parseProfile(JSON.stringify({ imports: ["a"], defines }), PROFILE);
    expect(bad({ X: "" })).toThrow(/defines\.X: a non-blank single line/);
    expect(bad({ X: "  " })).toThrow(/defines\.X: a non-blank single line/);
    expect(bad({ X: "1\n#define Y 2" })).toThrow(/defines\.X: a non-blank single line/);
    expect(bad({ X: "1 \\ " })).toThrow(/defines\.X: a non-blank single line not ending in \\/);
    expect(bad({ "X Y": "1" })).toThrow(/an identifier/);
  });
});

describe("profilesFor", () => {
  const os = profile();
  const other = profile({ file: abs("/mods/b/p.json"), imports: ["libs/OTHER.ACS", "osacs.acs"] });
  const none = profile({ file: abs("/mods/c/p.json"), imports: ["third.acs"] });

  it("matches an #import by basename in any case, returning every profile that lists it", () => {
    expect(profilesFor('  #import "scripts/OSACS.acs"\nscript 1 (void) {}', [os, other, none])).toEqual([os, other]);
    expect(profilesFor('#IMPORT "other.acs"', [os, other, none])).toEqual([other]);
  });

  it("matches nothing for a snippet without a listed #import, or with only an #include", () => {
    expect(profilesFor('#import "zcommon.acs"', [os, other, none])).toEqual([]);
    expect(profilesFor('#include "osacs.acs"', [os])).toEqual([]);
    expect(importsOf('#import "a\\b.acs"\n#import "C.acs"')).toEqual(["b.acs", "c.acs"]);
  });
});

describe("harvestDefines", () => {
  it("keeps #define and #libdefine lines, continuations included, and drops empty-body object defines", () => {
    const text = [
      "// header",
      "#ifndef HDR_INCLUDE",
      "#define HDR_INCLUDE // guard",
      "#define A 1",
      "  #libdefine B (A + 1)",
      "#define LONG(x) \\",
      "  ((x) * 2)",
      "#define EMPTY /* nothing */",
      "#define NOOP(x)",
      "#Define UPPER 3",
      "script 1 (void) {}",
      "#endif // HDR_INCLUDE",
    ].join("\n");
    expect(harvestDefines(text, "hdr.acs")).toEqual([
      { name: "A", lines: ["#define A 1"], line: 4 },
      { name: "B", lines: ["  #libdefine B (A + 1)"], line: 5 },
      { name: "LONG", lines: ["#define LONG(x) \\", "  ((x) * 2)"], line: 6 },
      { name: "NOOP", lines: ["#define NOOP(x)"], line: 9 },
      { name: "UPPER", lines: ["#Define UPPER 3"], line: 10 },
    ]);
  });

  it("harvests a file with no guard, and refuses a continuation past the end of the file", () => {
    expect(harvestDefines("#define A 1\r\n#define B 2", "h.acs")).toEqual([
      { name: "A", lines: ["#define A 1"], line: 1 },
      { name: "B", lines: ["#define B 2"], line: 2 },
    ]);
    expect(() => harvestDefines("#define A 1\r\n#define B 2 \\", "h.acs")).toThrow(
      "h.acs:2: #define B continues past the end of the file",
    );
  });

  it("accepts conditionals with no defines in them, as osfuncs.acs's #ifdef UZDOOM blocks", () => {
    const text = "#ifndef G\n#define G\n#ifdef UZDOOM\nint x;\n#else\nint y;\n#endif\n#define A 1\n#endif\n#else\n";
    expect(harvestDefines(text, "h.acs").map((d) => d.name)).toEqual(["A"]);
  });

  it("refuses a define in a nested #if, in a non-guard #if or #ifndef, or in the guard's #else, naming the file and line", () => {
    const refused = (text: string, line: number, name = "A") =>
      expect(() => harvestDefines(text, "h.acs")).toThrow(`h.acs:${line}: #define ${name} sits inside an #if block`);
    refused("#ifndef G\n#define G\n#ifdef UZDOOM\n#define A 1\n#endif\n#endif", 4);
    refused("#ifdef UZDOOM\n#define A 1\n#endif", 2);
    refused("#if 1\n#define A 1\n#endif", 2);
    // An #ifndef whose next directive defines another name, or gives the name a body, is no guard.
    refused("#ifndef G\n#define A 1\n#endif", 2);
    refused("#ifndef G\n#define G 1\n#define A 1\n#endif", 2, "G");
    refused("#ifndef G\n#include \"x.acs\"\n#define A 1\n#endif", 3);
    refused("#ifndef G\n#define G\n#else\n#define A 1\n#endif", 4);
    refused("#ifndef\n#define A 1\n#endif", 2);
  });

  it("ignores directives inside block comments, whatever they are", () => {
    const text = [
      "#ifndef G",
      "#define G",
      "/* #define ONE 1 */",
      "/*",
      "#define TWO 2",
      " * #ifdef UZDOOM",
      "#endif",
      "*/",
      "#define A 1 /* a * b */",
      "#endif",
    ].join("\n");
    expect(harvestDefines(text, "h.acs")).toEqual([{ name: "A", lines: ["#define A 1 /* a * b */"], line: 9 }]);
    // A commented #endif no longer pops the real #ifdef, so the define after it stays refused.
    expect(() => harvestDefines("#ifdef UZDOOM\n/*\n#endif\n*/\n#define A 1\n#endif", "h.acs")).toThrow(
      "h.acs:5: #define A sits inside an #if block",
    );
  });

  it("reads a directive after a comment that closes at the start of its line, as zt-bcc does", () => {
    const text = ["/* note */ #define A 1", "/*", "*/  #define B 2", "int x; /*", "*/ #define C 3"].join("\n");
    expect(harvestDefines(text, "h.acs")).toEqual([
      { name: "A", lines: [" #define A 1"], line: 1 },
      { name: "B", lines: ["  #define B 2"], line: 3 },
    ]);
  });

  it("doesn't open a comment from inside a string, a char literal or a line comment", () => {
    const text = [
      '#define S "/*"',
      "#define Q '/*'",
      '#define E "\\"/*"',
      "#define D (4 / 2) // /*",
      "#define T \"it's\"",
      "#define U 1",
    ].join("\n");
    expect(harvestDefines(text, "h.acs").map((d) => d.name)).toEqual(["S", "Q", "E", "D", "T", "U"]);
  });

  it("keeps a block comment that spans a define's continuation lines, and refuses one that runs past the define", () => {
    expect(harvestDefines("#define A 1 /* x \\\n y */ + 2", "h.acs")).toEqual([
      { name: "A", lines: ["#define A 1 /* x \\", " y */ + 2"], line: 1 },
    ]);
    expect(() => harvestDefines("#define A /*\n*/ 5", "h.acs")).toThrow(
      "h.acs:1: #define A opens a /* comment that runs past its line",
    );
  });
});

describe("buildPrelude", () => {
  const files: Record<string, string> = {
    [abs("/mods/orc/scripts/osdefs.acs")]: "#ifndef OSDEFS\n#define OSDEFS\n#define TID_PLAYER_BASE 1000\n#define HAZARD_MAX 64\n#endif",
    [abs("/mods/orc/scripts/more.acs")]: "\n\n#define EXTRA \\\n  2\n",
  };
  const read = (p: string) => {
    const text = files[p];
    if (text === undefined) throw new Error(`ENOENT: ${p}`);
    return text;
  };
  const OSDEFS = abs("/mods/orc/scripts/osdefs.acs");
  const MORE = abs("/mods/orc/scripts/more.acs");

  it("orders the raw pragma, the profile defines, then the harvested lines, tracking each line's origin", () => {
    const a = profile({ rawDefines: true, defineFiles: [OSDEFS], defines: { MCP_PROBE: "1" } });
    const b = profile({ file: abs("/mods/b/p.json"), defineFiles: [OSDEFS, MORE], defines: { MCP_PROBE: "1", OTHER: "x" } });
    expect(buildPrelude([a, b], read)).toEqual({
      text: [
        "#pragma raw define on",
        "#define MCP_PROBE 1",
        "#define OTHER x",
        "#define TID_PLAYER_BASE 1000",
        "#define HAZARD_MAX 64",
        "#define EXTRA \\",
        "  2",
        "",
      ].join("\n"),
      origin: [
        `${PROFILE} (rawDefines)`,
        `${PROFILE} (defines.MCP_PROBE)`,
        `${abs("/mods/b/p.json")} (defines.OTHER)`,
        `${OSDEFS}:3`,
        `${OSDEFS}:4`,
        `${MORE}:3`,
        `${MORE}:4`,
      ],
    });
  });

  it("adds nothing for profiles with only imports and dirs, and no pragma when none is raw", () => {
    expect(buildPrelude([profile({ includeDirs: ["/x"] })], read)).toBeUndefined();
    expect(buildPrelude([profile({ defineFiles: [MORE] })], read)?.text).toBe("#define EXTRA \\\n  2\n");
  });

  it("refuses the same define with two values across profiles, naming both files", () => {
    const b = profile({ file: abs("/mods/b/p.json"), defines: { X: "2" } });
    expect(() => buildPrelude([profile({ defines: { X: "1" } }), b], read)).toThrow(
      `run_acs profiles ${PROFILE} and ${abs("/mods/b/p.json")} define X differently`,
    );
  });

  it("refuses a profile define that collides with a harvested one", () => {
    expect(() => buildPrelude([profile({ defineFiles: [OSDEFS], defines: { HAZARD_MAX: "8" } })], read)).toThrow(
      `run_acs profile ${PROFILE}: defines.HAZARD_MAX can't override the #define at ${OSDEFS}:4`,
    );
  });

  it("names the profile and the file for an unreadable defineFile, and passes a harvest refusal through", () => {
    const gone = abs("/mods/orc/scripts/gone.acs");
    expect(() => buildPrelude([profile({ defineFiles: [gone] })], read)).toThrow(
      `run_acs profile ${PROFILE}: can't read defineFile ${gone} (ENOENT: ${gone})`,
    );
    const cond = abs("/c.acs");
    expect(() => buildPrelude([profile({ defineFiles: [cond] })], () => "#ifdef X\n#define A 1\n#endif")).toThrow(
      `${cond}:2: #define A sits inside an #if block`,
    );
  });
});
