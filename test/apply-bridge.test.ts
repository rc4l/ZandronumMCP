import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import {
  OVERLAY_FILES,
  detectEol,
  parseArgs,
  findAnchorIndex,
  appendBlock,
  applyBridge,
  syncBlock,
  ACS_BLOCKS,
  HOST_TEE,
} from "../engine-bridge/apply-bridge.core.mjs";

const overlayDir = join(dirname(fileURLToPath(import.meta.url)), "..", "engine-bridge", "overlay");

it("keeps synchronous marker-script output outside the bridge reply guard", () => {
  const actor = readFileSync(join(overlayDir, "mcp_actorstate.cpp"), "utf8");
  const round = actor.slice(actor.indexOf("static void MCP_AppendRound"), actor.indexOf("CCMD( mcp_mark )"));
  expect(round).toMatch(/MCPBridgeReplySuspendGuard gameOutput;\s+line\.AppendFormat\( " round=%d", P_StartScript/);
});

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "applybridge-"));
  tmpDirs.push(d);
  return d;
}

it("railings take precedence over two-sided blocking flags in the real probe predicate", () => {
  if (spawnSync("g++", ["--version"]).status !== 0) throw new Error("probe regression needs g++");
  const actor = readFileSync(join(overlayDir, "mcp_actorstate.cpp"), "utf8");
  const predicate = actor.slice(actor.indexOf("static bool MCP_LineBlocks"), actor.indexOf("static line_t *MCP_BlockingLine"));
  const work = freshDir(), source = join(work, "probe.cpp"), exe = join(work, "probe");
  writeFileSync(source, `
#include <cassert>
#include <cstddef>
#include <initializer_list>
enum { ML_BLOCKING=1, ML_BLOCKEVERYTHING=2, ML_RAILING=4, ML_BLOCKMONSTERS=8,
  ML_BLOCK_PLAYERS=16, ML_BLOCK_FLOATERS=32, MF3_NOBLOCKMONST=64, MF_FRIENDLY=128,
  MF_FLOAT=256, COMPATF_NOBLOCKFRIENDS=512 };
static int i_compatflags = 0;
struct AActor { int flags=0, flags3=0; };
struct line_t { void *backsector; int flags; };
${predicate}
int main() {
  AActor probe;
  for (bool player : {false, true}) {
    for (int flag : {ML_BLOCKING, ML_BLOCKEVERYTHING, ML_BLOCK_PLAYERS}) {
      line_t line = { &probe, ML_RAILING | flag };
      assert(!MCP_LineBlocks(&probe, &line, player));
      line.backsector = NULL;
      assert(MCP_LineBlocks(&probe, &line, player));
    }
  }
  line_t line = { &probe, ML_BLOCKING };
  assert(MCP_LineBlocks(&probe, &line, true));
  line.flags = ML_BLOCK_PLAYERS;
  assert(MCP_LineBlocks(&probe, &line, true));
  assert(!MCP_LineBlocks(&probe, &line, false));
}
`);
  execFileSync("g++", ["-std=c++14", "-Wall", "-Wextra", "-Werror", source, "-o", exe]);
  execFileSync(exe);
});
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
    '#ifdef _WIN32\n#include <direct.h>\n#else\n#include <sys/stat.h>\n#endif\n#include "doomdef.h"\n#include "d_main.h"\n\nvoid D_DoomLoop ();\n\nvoid D_Decoy ()\n{\n\tswitch ( NETWORK_GetState( ))\n}\n\nvoid D_DoomLoop ()\n{\n\tswitch ( NETWORK_GetState( ))\n\t{\n\t}\n}\n');
  writeFileSync(join(src, "c_console.cpp"),
    '#include "templates.h"\n\nvoid C_Decoy()\n{\n\t\tconst int length = static_cast<int>(strlen (outlinecopy));\n}\n\nvoid C_Foo()\n{\n\t// For servers, dump message to console window.\n\tif ( Args && Args->CheckParm( "-host" ))\n\t{\n\t\tconst int length = static_cast<int>(strlen (outlinecopy));\n\t\treturn length;\n\t}\n\tI_PrintStr (outlinecopy);\n\tif (printlevel != PRINT_LOG)\n\t{\n\t\t\tC_AddNotifyString (printlevel, outlinecopy);\n\t}\n\tLogOutput();\n}\n');
  writeFileSync(join(src, "v_text.cpp"),
    '#include "v_text.h"\n\nvoid DCanvas::DrawTextV (int normalcolor)\n{\n\tif (normalcolor >= NumTextColors)\n\t\tnormalcolor = 0;\n}\n');
  writeFileSync(join(src, "v_draw.cpp"),
    '#include "v_video.h"\n\nvoid STACK_ARGS DCanvas::DrawTexture (FTexture *img, double x, double y, int tags_first, ...)\n{\n\tva_start(tags, tags_first);\n}\n');
  writeFileSync(join(src, "g_shared", "sbar.h"),
    "class DBaseStatusBar\n{\n\tvoid DetachAllMessages ();\n};\n");
  // A decoy turbo comment before G_Ticker: the override must land inside it.
  writeFileSync(join(src, "g_game.cpp"),
    '#include <string.h>\n\n// check for turbo cheats\nvoid G_Ticker ()\n{\n\t\t\t\tmemcpy (cmd, newcmd, sizeof(ticcmd_t));\n\n\t\t\t\t// check for turbo cheats\n}\n');
  writeFileSync(join(src, "p_acs.cpp"), "// p_acs.cpp\n#include <assert.h>\n");
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

describe("syncBlock", () => {
  const BODY = "// ==== MCP_X (overlay) ====\nnew();\n// ==== end MCP_X ====\n";
  const run = (initial: string) => {
    const f = join(freshDir(), "p_acs.cpp");
    writeFileSync(f, initial);
    const log: string[] = [];
    syncBlock(f, "MCP_X", BODY, "x CCMDs", (m: string) => log.push(m));
    return { text: readFileSync(f, "utf8"), log };
  };

  it("appends the block when the file has none", () => {
    const { text, log } = run("// p_acs.cpp\n");
    expect(text).toBe(`// p_acs.cpp\n\n${BODY}`);
    expect(log).toEqual(["  + patched: p_acs.cpp (x CCMDs)"]);
  });

  it("replaces a stale block in place and leaves its neighbours alone", () => {
    const stale = "// ==== MCP_X (overlay) ====\nold();\nolder();\n// ==== end MCP_X ====";
    const { text, log } = run(`head\n\n${stale}\n\n// ==== MCP_Y (overlay) ====\ny();\n// ==== end MCP_Y ====\n`);
    expect(text).toBe(`head\n\n${BODY}\n// ==== MCP_Y (overlay) ====\ny();\n// ==== end MCP_Y ====\n`);
    expect(log).toEqual(["  ~ updated: p_acs.cpp (x CCMDs)"]);
  });

  it("leaves an up-to-date block untouched", () => {
    const { text, log } = run(`head\n\n${BODY}`);
    expect(text).toBe(`head\n\n${BODY}`);
    expect(log).toEqual(["  = already patched: p_acs.cpp (x CCMDs)"]);
  });

  it("throws rather than guess where a block without its end line stops", () => {
    expect(() => run("// ==== MCP_X (overlay) ====\nold();\n")).toThrow(/MCP_X block has no "\/\/ ==== end MCP_X ====" line/);
  });

  it("every overlay block starts and ends with the marker lines it is found by", () => {
    for (const [name, inc] of ACS_BLOCKS) {
      const body = readFileSync(join(overlayDir, inc), "utf8");
      expect(body.startsWith(`// ==== ${name} `)).toBe(true);
      expect(body.trimEnd().endsWith(`// ==== end ${name} ====`)).toBe(true);
    }
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
    // Past the prototype and the decoy, inside the loop's definition.
    const dmain = linesOf(join(src, "d_main.cpp"));
    expect(dmain[dmain.lastIndexOf("\tswitch ( NETWORK_GetState( ))") - 1]).toBe("\t\t\tMCP_Bridge_Poll();");
    expect(dmain.filter((l) => l.includes("MCP_Bridge_Poll"))).toHaveLength(1);
    assertAfter(join(src, "c_console.cpp"), /I_PrintStr \(outlinecopy\)/, "\t\tMCP_Bridge_TeeOutput( outlinecopy );");
    assertBefore(join(src, "v_text.cpp"), /normalcolor >= NumTextColors/, "\tMCP_HUD_TeeText( x, y, string );");
    assertBefore(join(src, "v_draw.cpp"), /va_start\(tags, tags_first\)/, "\tMCP_HUD_TeeTexture( x, y, img );");
    assertAfter(join(src, "g_shared", "sbar.h"), /DetachAllMessages/, "\tvoid MCP_DumpMessages();");
    assertAfter(join(src, "g_game.cpp"), /#include <string.h>/, '#include "mcp_bridge.h"');
    const ggame = linesOf(join(src, "g_game.cpp"));
    expect(ggame.indexOf("\t\t\t\tMCP_Input_Override( i, cmd );")).toBe(ggame.lastIndexOf("\t\t\t\t// check for turbo cheats") - 1);
    expect(ggame.filter((l) => l.includes("MCP_Input_Override"))).toHaveLength(1);

    // appended CCMD blocks + CMake target
    const pacs = readFileSync(join(src, "p_acs.cpp"), "utf8");
    expect(pacs).toContain('#include "mcp_bridge.h"');
    expect(pacs).toContain("MCP_ACSVARS");
    expect(pacs).toContain("MCP_MAPVARS");
    expect(pacs).toContain("CCMD( mcp_mapslot )");
    expect(pacs).toContain("MCP_SCRIPTS");
    expect(pacs).toContain("MCP_RUNACS");
    // Every overlay translation unit is compiled in.
    const target = readFileSync(join(src, "CMakeLists.txt"), "utf8").match(/target_sources\( zdoom PRIVATE (.*) \)/);
    expect(target?.[1].split(" ").sort()).toEqual(OVERLAY_FILES.filter((f) => f.endsWith(".cpp")).sort());
  });

  it("keeps bridge replies out of notify without suppressing the console, tee or logfile", () => {
    const root = buildFixture();
    const consoleFile = join(root, "src", "c_console.cpp");
    applyBridge({ src: root, overlayDir });
    const before = readFileSync(consoleFile, "utf8");
    assertBefore(consoleFile, /C_AddNotifyString \(printlevel, outlinecopy\);/,
      "\t\t\tif ( MCP_Bridge_ShowInNotify( outlinecopy ) )");
    expect(before).toContain("\tI_PrintStr (outlinecopy);\n\t\tMCP_Bridge_TeeOutput( outlinecopy );");
    expect(before).toContain("\t}\n\tLogOutput();");
    expect(before.match(/MCP_Bridge_ShowInNotify/g)).toHaveLength(1);
    applyBridge({ src: root, overlayDir });
    expect(readFileSync(consoleFile, "utf8")).toBe(before);
  });

  it("tees a -host server's lines before its early return, once", () => {
    const root = buildFixture();
    const file = join(root, "src", "c_console.cpp");
    applyBridge({ src: root, overlayDir });
    const con = linesOf(file);
    const hostTee = `\t\tMCP_Bridge_TeeOutput( outlinecopy ); // ${HOST_TEE}`;
    expect(con[con.lastIndexOf("\t\tconst int length = static_cast<int>(strlen (outlinecopy));") - 1]).toBe(hostTee);
    expect(con.filter((l) => l.includes("MCP_Bridge_TeeOutput"))).toHaveLength(2);
    const before = readFileSync(file, "utf8");
    applyBridge({ src: root, overlayDir });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("is idempotent — a second run changes nothing and reports 'already patched'", () => {
    const root = buildFixture();
    const src = join(root, "src");
    applyBridge({ src: root, overlayDir });
    const patched = ["d_main.cpp", "c_console.cpp", "g_game.cpp"].map((f) => join(src, f));
    const before = patched.map((f) => readFileSync(f, "utf8"));

    const log: string[] = [];
    applyBridge({ src: root, overlayDir, log: (m) => log.push(m) });
    expect(patched.map((f) => readFileSync(f, "utf8"))).toEqual(before);
    expect(log.some((l) => l.includes("already patched"))).toBe(true);
  });

  it("a re-apply delivers an edited ACS block (a marker check alone would skip it)", () => {
    const root = buildFixture();
    const pacs = join(root, "src", "p_acs.cpp");
    applyBridge({ src: root, overlayDir });
    const applied = readFileSync(pacs, "utf8");
    // The tree as an older overlay left it: the run_acs block without one of its lines (CRLF from a Windows checkout).
    const stale = applied.replace(/^CCMD\( mcp_runacs \)\r?\n/m, "");
    expect(stale).not.toBe(applied);
    writeFileSync(pacs, stale);

    const log: string[] = [];
    applyBridge({ src: root, overlayDir, log: (m) => log.push(m) });
    expect(readFileSync(pacs, "utf8")).toBe(applied);
    expect(log.filter((l) => l.includes("updated"))).toEqual(["  ~ updated: p_acs.cpp (run_acs and run_script CCMDs)"]);
  });

  it("a re-apply adds a new overlay .cpp to the target_sources line, in place", () => {
    const root = buildFixture();
    const cmake = join(root, "src", "CMakeLists.txt");
    applyBridge({ src: root, overlayDir });
    const applied = readFileSync(cmake, "utf8");
    // The line as an overlay from before mcp_input.cpp left it.
    const stale = applied.replace(" mcp_input.cpp )", " )");
    expect(stale).not.toBe(applied);
    writeFileSync(cmake, stale);

    const log: string[] = [];
    applyBridge({ src: root, overlayDir, log: (m) => log.push(m) });
    expect(readFileSync(cmake, "utf8")).toBe(applied);
    expect(log).toContain("  ~ updated: CMakeLists.txt (target_sources zdoom)");
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
