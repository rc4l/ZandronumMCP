import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// move_to's steering law (mcp_steer.h) against fixed-point and floating-point simulated kinematics, needing only the
// C++ compiler any engine build already has.
const bridgeDir = join(dirname(fileURLToPath(import.meta.url)), "..", "engine-bridge");
const header = join(bridgeDir, "overlay", "mcp_steer.h");
const sim = join(dirname(fileURLToPath(import.meta.url)), "steer-sim.cpp");
const compiler = spawnSync("g++", ["--version"]).status === 0 ? "g++" : undefined;
const work = mkdtempSync(join(tmpdir(), "steer-sim-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("steering simulator", () => {
  it("has its sources", () => {
    expect(existsSync(header)).toBe(true);
    expect(existsSync(sim)).toBe(true);
  });

  if (!compiler) console.warn("steer.test.ts: no g++ on PATH, simulator skipped");

  it.skipIf(!compiler)(
    "lands every scenario on both kinematics flavours",
    () => {
      const exe = join(work, "steer-sim");
      execFileSync(compiler!, ["-std=c++14", "-O2", "-Wall", "-Wextra", "-Werror", "-o", exe, sim]);
      const run = spawnSync(exe, { encoding: "utf8" });
      expect(run.stdout.split("\n").filter((l) => l.startsWith("MISS"))).toEqual([]);
      expect(run.stdout.match(/^ok\s+[ZU]\s+slow oblique wall slide\s+stuck/gm)).toHaveLength(2);
      expect(run.stdout).toContain("all scenarios passed");
      expect(run.status).toBe(0);
    },
    60_000,
  );

  it.skipIf(!compiler)(
    "the header also compiles as C++20",
    () => {
      const tu = join(work, "c20.cpp");
      writeFileSync(tu, `#include "${header}"\nint main() { MCPSteerState s; MCP_SteerReset( s ); return s.kf == 1 ? 0 : 1; }\n`);
      execFileSync(compiler!, ["-std=c++20", "-Wall", "-Wextra", "-Werror", "-fsyntax-only", tu]);
    },
    60_000,
  );
});
