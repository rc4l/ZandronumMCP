import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lf } from "./fakes/paths.js";

const overlay = join(dirname(fileURLToPath(import.meta.url)), "..", "engine-bridge", "overlay");
const cases = [
  {
    name: "rebases a direct thaw on the first refreshed tic-ms read",
    body: `
      freeze(true);
      equal(ticMS(), 1000, "first held read");
      step(8);
      equal(ticMS(), 1228, "held steps");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1228, "first refreshed read");
      wallMS += 28;
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1256, "subsequent live advance");`,
  },
  {
    name: "does not consume the thaw rebase permanently on a stale render",
    body: `
      freeze(true);
      ticMS();
      step(8);
      equal(ticMS(), 1228, "held steps");
      wallMS += 10000;
      MCP_Clock_Thaw();
      equal(ticMS(), 1228, "render before timer refresh");
      MCP_Clock_GetTime(false);
      equal(ticMS(), 1228, "unsaved timer read");
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1228, "first refreshed read");`,
  },
  {
    name: "rebases after frame time was toggled off and read while raw time was stationary",
    body: `
      freeze(true);
      ticMS();
      step(8);
      equal(ticMS(), 1228, "held steps");
      wallMS += 10000;
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 1228, "release against stationary raw time");
      step(4);
      equal(ticMS(), 1228, "unheld frozen steps keep stock tic-ms behavior");
      MCP_Clock_Thaw();
      equal(ticMS(), 1228, "thaw before refresh");
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1228, "refresh after off-before-thaw");
      wallMS += 29;
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1257, "live time is not repeatedly rebased");`,
  },
  {
    name: "preserves continuity through repeated toggles and held versus unheld steps",
    body: `
      freeze(true);
      ticMS();
      step(8);
      equal(ticMS(), 1228, "first held steps");
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 1228, "first release");
      step(4);
      MCP_Clock_SetFrameTime(true);
      equal(ticMS(), 1228, "second anchor");
      step(7);
      equal(ticMS(), 1428, "second held steps");
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 1428, "second release");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1428, "refresh after repeated toggles");`,
  },
  {
    name: "retains the pending refresh across an unread re-hold",
    body: `
      freeze(true);
      ticMS();
      step(8);
      equal(ticMS(), 1228, "last rendered held value");
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 1228, "release");
      MCP_Clock_SetFrameTime(true);
      step(3);
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1228, "no new source read must not erase pending refresh");`,
  },
  {
    name: "rebases only tic-ms when its cached source resumes",
    body: `
      freeze(true);
      MCP_Clock_FrameTime(MCP_FRAME_FPS, 5000);
      MCP_Clock_FrameTime(MCP_FRAME_GLMS, 500);
      ticMS();
      step(8);
      equal(MCP_Clock_FrameTime(MCP_FRAME_FPS, 15000), 5228, "held FPS");
      equal(MCP_Clock_FrameTime(MCP_FRAME_GLMS, 10500), 728, "held GL-ms");
      equal(ticMS(), 1228, "held tic-ms");
      MCP_Clock_SetFrameTime(false);
      equal(MCP_Clock_FrameTime(MCP_FRAME_FPS, 15000), 5228, "released FPS");
      equal(MCP_Clock_FrameTime(MCP_FRAME_GLMS, 10500), 728, "released GL-ms");
      equal(ticMS(), 1228, "released tic-ms");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(MCP_Clock_FrameTime(MCP_FRAME_FPS, 15007), 5235, "live FPS");
      equal(MCP_Clock_FrameTime(MCP_FRAME_GLMS, 10511), 739, "live GL-ms");
      equal(ticMS(), 1228, "resumed tic-ms");`,
  },
  {
    name: "leaves never-held frame clocks on the stock raw source",
    body: `
      freeze(false);
      equal(MCP_ClockFrameUsed, false, "never-held guard");
      equal(ticMS(), 1000, "frozen raw time");
      step(8);
      equal(ticMS(), 1000, "stock stationary raw time");
      wallMS += 10000;
      MCP_Clock_Thaw();
      equal(ticMS(), 1000, "raw time before refresh");
      MCP_Clock_GetTime(true);
      equal(ticMS(), 11000, "stock raw refresh");
      equal(MCP_Clock_WaitForTic(12), 13, "live wait offset");`,
  },
  {
    name: "does not rebase a tic-ms slot that was never sampled while held",
    body: `
      freeze(true);
      MCP_Clock_FrameTime(MCP_FRAME_FPS, 5000);
      step(8);
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 1000, "unheld tic-ms slot");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 11000, "unheld slot follows raw refresh");`,
  },
  {
    name: "does not keep rebasing a later freeze without a frame-time hold",
    body: `
      freeze(true);
      ticMS();
      step(8);
      equal(ticMS(), 1228, "held steps");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1228, "held thaw");
      wallMS += 28;
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1256, "live advance");
      freeze(false);
      step(5);
      wallMS += 1000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 2256, "later unheld thaw retains stock advance");`,
  },
  {
    name: "uses unsigned offset arithmetic across a raw timestamp wrap",
    body: `
      rawTicMS = wallMS = 0xfffffff0u;
      freeze(true);
      equal(ticMS(), 0xfffffff0u, "wrapped anchor");
      step(8);
      equal(ticMS(), 212, "wrapped held steps");
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 212, "wrapped release");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 212, "wrapped refresh");
      wallMS += 28;
      MCP_Clock_GetTime(true);
      equal(ticMS(), 240, "wrapped live advance");`,
  },
  {
    name: "supports frozen steps ahead of wall time with a negative release offset",
    body: `
      freeze(true);
      ticMS();
      step(70);
      equal(ticMS(), 3000, "fast held steps");
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 3000, "negative offset release");
      wallMS += 28;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 3000, "refresh behind virtual time");
      wallMS += 29;
      MCP_Clock_GetTime(true);
      equal(ticMS(), 3029, "live advance behind virtual time");`,
  },
  {
    name: "preserves a rebase if frozen again before the refreshed source is rendered",
    body: `
      freeze(true);
      ticMS();
      step(8);
      equal(ticMS(), 1228, "held steps");
      MCP_Clock_SetFrameTime(false);
      equal(ticMS(), 1228, "release");
      wallMS += 10000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      freeze(true);
      equal(ticMS(), 1228, "new anchor before released render");
      step(7);
      equal(ticMS(), 1428, "new held steps");
      wallMS += 5000;
      MCP_Clock_Thaw();
      MCP_Clock_GetTime(true);
      equal(ticMS(), 1428, "second resumed source");`,
  },
];

describe("native Zandronum frame clock", () => {
  let work: string;
  let executable: string;
  afterAll(() => { if (work) rmSync(work, { recursive: true, force: true }); });

  beforeAll(() => {
    const source = lf(readFileSync(join(overlay, "mcp_clock.cpp"), "utf8"));
    const declarations = source.slice(source.indexOf("bool MCP_ClockFrozen ="), source.indexOf("static void MCP_Clock_Install()"));
    const slotEnum = lf(readFileSync(join(overlay, "mcp_bridge.h"), "utf8")).match(/^enum MCPFrameSlot \{.*\};$/m)?.[0];
    const functions = ["MCP_Clock_SetFrac", "MCP_Clock_Abort", "MCP_Clock_Thaw", "MCP_Clock_Hold"].map((name) => {
      const match = source.match(new RegExp(`^(?:static )?\\w+ ${name}\\([^\\n]*\\)\\n\\{[\\s\\S]*?^\\}`, "m"));
      if (!match) throw new Error(`missing native function ${name}`);
      return match[0];
    }).join("\n");
    expect(declarations).toContain("unsigned int MCP_Clock_FrameTime(");
    expect(slotEnum).toBeDefined();
    work = mkdtempSync(join(tmpdir(), "frame-clock-"));
    executable = join(work, "frame-clock");
    const snippet = join(work, "frame-clock.cpp");
    // Compile the actual overlay state and functions; only engine inputs are stubbed.
    writeFileSync(snippet, `
      #include <cstdio>
      #include <cstdlib>
      #include <deque>
      #include <string>
      #define FRACUNIT 65536
      #define TICRATE 35
      ${slotEnum}
      ${declarations}
      static unsigned int wallMS = 1000, rawTicMS = 1000;
      static int gametic = 0, paused = 0;
      static struct { int maptime; } level = {};
      static unsigned int I_MSTime() { return wallMS; }
      static bool MCP_Clock_LoadPending() { return false; }
      static bool demorecording = false, demoplayback = false;
      // Never armed here: the demo arm needs a playing demo.
      static void MCP_Clock_CheckArmed() {}
      ${functions}
      static void equal(unsigned int actual, unsigned int expected, const char *where) {
        if (actual != expected) {
          std::fprintf(stderr, "%s: expected %u, got %u\\n", where, expected, actual);
          std::exit(1);
        }
      }
      static int rawGetTime(bool saveMS) {
        if (saveMS) rawTicMS = wallMS;
        return (unsigned long long)wallMS * TICRATE / 1000;
      }
      static int rawWaitForTic(int prevtic) { return prevtic + 1; }
      static unsigned int ticMS() { return MCP_Clock_FrameTime(MCP_FRAME_TICMS, rawTicMS); }
      static void freeze(bool frameTime) {
        g_origGetTime = rawGetTime;
        g_origWaitForTic = rawWaitForTic;
        g_vtic = MCP_Clock_GetTime(false);
        MCP_ClockFrozen = true;
        MCP_Clock_SetFrameTime(frameTime);
      }
      static void step(int tics) {
        g_jobs.push_back({false, tics, 1, 1, ""});
        for (int i = 0; i < tics; ++i) {
          equal(MCP_Clock_Hold(), false, "step lets one tic through");
          MCP_Clock_GetTime(true);
        }
        g_jobs.clear();
        g_pending = false;
      }
      int main(int argc, char **argv) {
        if (argc != 2) return 2;
        const std::string scenario = argv[1];
        ${cases.map(({ body }, i) => `if (scenario == "${i}") { ${body} std::puts("passed"); return 0; }`).join("\n")}
        return 2;
      }
    `);
    execFileSync("g++", ["-std=c++14", "-O2", "-Wall", "-Wextra", "-Werror", "-Wno-unused-function", "-Wno-unused-variable", "-o", executable, snippet]);
  }, 60_000);

  it.each(cases.map((scenario, i) => ({ ...scenario, id: String(i) })))("$name", ({ id }) => {
    const run = spawnSync(executable, [id], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    expect(lf(run.stdout)).toBe("passed\n");
  });
});
