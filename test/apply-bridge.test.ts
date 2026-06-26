import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OVERLAY_FILES,
  detectEol,
  parseArgs,
  findAnchorIndex,
  appendBlock,
  applyBridge,
} from "../engine-bridge/apply-bridge.core.mjs";

const overlayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "engine-bridge", "overlay");

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "applybridge-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Build a minimal Zandronum source tree carrying every anchor the applier needs. */
function buildFixture(): string {
  const root = freshDir();
  const src = join(root, "src");
  mkdirSync(join(src, "g_shared"), { recursive: true });

  // First include is Windows-only and guarded (mirrors the real d_main.cpp). The
  // bridge include must skip it and land on the first UNCONDITIONAL include, else
  // non-Windows builds compile the bridge header out and its symbols go undeclared.
  writeFileSync(join(src, "d_main.cpp"),
    '#ifdef _WIN32\n#include <direct.h>\n#else\n#include <sys/stat.h>\n#endif\n#include "doomdef.h"\n#include "d_main.h"\n\nvoid D_DoomLoop ()\n{\n\tswitch ( NETWORK_GetState( ))\n\t{\n\t}\n}\n');
  writeFileSync(join(src, "c_console.cpp"),
    '#include "templates.h"\n\nvoid C_Foo()\n{\n\tI_PrintStr (outlinecopy);\n}\n');
  writeFileSync(join(src, "v_text.cpp"),
    '#include "v_text.h"\n\nvoid DCanvas::DrawTextV (int normalcolor)\n{\n\tif (normalcolor >= NumTextColors)\n\t\tnormalcolor = 0;\n}\n');
  writeFileSync(join(src, "v_draw.cpp"),
    '#include "v_video.h"\n\nvoid STACK_ARGS DCanvas::DrawTexture (FTexture *img, double x, double y, int tags_first, ...)\n{\n\tva_start(tags, tags_first);\n}\n');
  writeFileSync(join(src, "g_shared", "sbar.h"),
    "class DBaseStatusBar\n{\n\tvoid DetachAllMessages ();\n};\n");
  writeFileSync(join(src, "p_acs.cpp"), "// p_acs.cpp\n");
  writeFileSync(join(src, "CMakeLists.txt"), "add_executable( zdoom WIN32 )\n");
  return root;
}

const linesOf = (file: string) => readFileSync(file, "utf8").split("\n");
/** Assert `inserted` sits immediately after the first line matching `anchor`. */
function assertAfter(file: string, anchor: RegExp, inserted: string) {
  const lines = linesOf(file);
  const i = lines.findIndex((l) => anchor.test(l));
  expect(i).toBeGreaterThanOrEqual(0);
  expect(lines[i + 1]).toBe(inserted);
}
/** Assert `inserted` sits immediately before the first line matching `anchor`. */
function assertBefore(file: string, anchor: RegExp, inserted: string) {
  const lines = linesOf(file);
  const i = lines.findIndex((l) => anchor.test(l));
  expect(i).toBeGreaterThan(0);
  expect(lines[i - 1]).toBe(inserted);
}

describe("parseArgs", () => {
  it("reads --src/-Src/-src and --src=", () => {
    expect(parseArgs(["--src", "a"])).toEqual({ src: "a", revert: false });
    expect(parseArgs(["-Src", "b"])).toEqual({ src: "b", revert: false });
    expect(parseArgs(["-src", "c"])).toEqual({ src: "c", revert: false });
    expect(parseArgs(["--src=d"])).toEqual({ src: "d", revert: false });
  });
  it("reads the revert flag in every spelling", () => {
    expect(parseArgs(["--src", "a", "--revert"]).revert).toBe(true);
    expect(parseArgs(["--src", "a", "-Revert"]).revert).toBe(true);
    expect(parseArgs(["--src", "a", "-revert"]).revert).toBe(true);
  });
  it("defaults to no src and ignores unknown args", () => {
    expect(parseArgs([])).toEqual({ src: null, revert: false });
    expect(parseArgs(["--bogus"])).toEqual({ src: null, revert: false });
  });
});

describe("detectEol", () => {
  it("detects CRLF and falls back to LF", () => {
    expect(detectEol("a\r\nb")).toBe("\r\n");
    expect(detectEol("a\nb")).toBe("\n");
    expect(detectEol("nolines")).toBe("\n");
  });
});

describe("findAnchorIndex", () => {
  const lines = ["aaa", "void D_DoomLoop", "switch x", "switch y"];
  it("finds the first match (no scope)", () => {
    expect(findAnchorIndex(lines, "switch", undefined)).toBe(2);
  });
  it("honours scopeAfter", () => {
    expect(findAnchorIndex(lines, "switch", "void D_DoomLoop")).toBe(2);
  });
  it("throws when the scope anchor is missing", () => {
    expect(() => findAnchorIndex(lines, "switch", "NoSuchScope")).toThrow(/Scope anchor/);
  });
  it("throws when the anchor is missing", () => {
    expect(() => findAnchorIndex(lines, "nope", undefined)).toThrow(/Anchor .* not found/);
  });
  it("requireTopLevel skips matches inside #if/#endif blocks", () => {
    const guarded = [
      "#ifdef _WIN32",
      "#include <direct.h>",   // guarded — must be skipped
      "#else",
      "#include <sys/stat.h>", // guarded — must be skipped
      "#endif",
      '#include "doomdef.h"',  // first top-level include
    ];
    // Without the flag it grabs the first match (the guarded one)...
    expect(findAnchorIndex(guarded, "^\\s*#include", undefined)).toBe(1);
    // ...with it, the first unconditional include wins.
    expect(findAnchorIndex(guarded, "^\\s*#include", undefined, true)).toBe(5);
  });
  it("requireTopLevel handles nested conditionals", () => {
    const nested = ["#if A", "#ifdef B", "#include <x>", "#endif", "#endif", "#include <y>"];
    expect(findAnchorIndex(nested, "^\\s*#include", undefined, true)).toBe(5);
  });
});

describe("appendBlock", () => {
  it("separates with one EOL and keeps a trailing newline body as-is", () => {
    const f = join(freshDir(), "f.txt");
    writeFileSync(f, "line1"); // no trailing newline
    appendBlock(f, "BODY\n");
    expect(readFileSync(f, "utf8")).toBe("line1\nBODY\n");
  });
  it("adds an EOL when the body lacks a trailing newline", () => {
    const f = join(freshDir(), "f.txt");
    writeFileSync(f, "a\n");
    appendBlock(f, "BODY");
    expect(readFileSync(f, "utf8")).toBe("a\n\nBODY\n");
  });
});

describe("applyBridge", () => {
  it("throws when the source tree is missing", () => {
    expect(() => applyBridge({ src: join(freshDir(), "nope"), overlayDir })).toThrow(/Source tree not found/);
  });

  it("applies every hook, copies overlays, and appends CCMD blocks", () => {
    const root = buildFixture();
    const src = join(root, "src");
    applyBridge({ src: root, overlayDir });

    // overlay files copied in
    for (const f of OVERLAY_FILES) expect(existsSync(join(src, f))).toBe(true);

    // anchored one-line hooks
    assertAfter(join(src, "d_main.cpp"), /#include "doomdef.h"/, '#include "mcp_bridge.h"');
    assertBefore(join(src, "d_main.cpp"), /switch \( NETWORK_GetState/, "\t\t\tMCP_Bridge_Poll();");
    assertAfter(join(src, "c_console.cpp"), /I_PrintStr \(outlinecopy\)/, "\t\tMCP_Bridge_TeeOutput( outlinecopy );");
    assertBefore(join(src, "v_text.cpp"), /normalcolor >= NumTextColors/, "\tMCP_HUD_TeeText( x, y, string );");
    assertBefore(join(src, "v_draw.cpp"), /va_start\(tags, tags_first\)/, "\tMCP_HUD_TeeTexture( x, y, img );");
    assertAfter(join(src, "g_shared", "sbar.h"), /DetachAllMessages/, "\tvoid MCP_DumpMessages();");

    // appended CCMD blocks + CMake target
    const pacs = readFileSync(join(src, "p_acs.cpp"), "utf8");
    expect(pacs).toContain("MCP_ACSVARS");
    expect(pacs).toContain("MCP_MAPVARS");
    expect(pacs).toContain("MCP_SCRIPTS");
    expect(readFileSync(join(src, "CMakeLists.txt"), "utf8")).toContain("target_sources( zdoom PRIVATE mcp_bridge.cpp");
  });

  it("is idempotent — a second run changes nothing and reports 'already patched'", () => {
    const root = buildFixture();
    const src = join(root, "src");
    applyBridge({ src: root, overlayDir });
    const before = linesOf(join(src, "d_main.cpp")).join("\n");

    const log: string[] = [];
    applyBridge({ src: root, overlayDir, log: (m) => log.push(m) });
    expect(linesOf(join(src, "d_main.cpp")).join("\n")).toBe(before);
    expect(log.some((l) => l.includes("already patched"))).toBe(true);
  });

  it("revert removes the overlay files", () => {
    const root = buildFixture();
    const src = join(root, "src");
    applyBridge({ src: root, overlayDir });
    for (const f of OVERLAY_FILES) expect(existsSync(join(src, f))).toBe(true);

    const log: string[] = [];
    applyBridge({ src: root, revert: true, overlayDir, log: (m) => log.push(m) });
    for (const f of OVERLAY_FILES) expect(existsSync(join(src, f))).toBe(false);
    expect(log.some((l) => l.includes("Removed overlay files"))).toBe(true);
  });
});
