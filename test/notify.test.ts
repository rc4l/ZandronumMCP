import { afterAll, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lf } from "./fakes/paths.js";

const overlay = join(dirname(fileURLToPath(import.meta.url)), "..", "engine-bridge", "overlay");
const work = mkdtempSync(join(tmpdir(), "bridge-notify-"));
const compiler = spawnSync("g++", ["--version"]).status === 0 ? "g++" : undefined;
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runNative(name: string, callbacks: string, body: string) {
  const bridge = readFileSync(join(overlay, "mcp_bridge.cpp"), "utf8");
  const guards = bridge.slice(bridge.indexOf("void MCP_Bridge_ReplyBegin()"), bridge.indexOf("void MCP_Bridge_Poll()"));
  const source = join(work, `${name}.cpp`), exe = join(work, name);
  writeFileSync(source, `
#include <cassert>
#include <cstddef>
#include <cstdio>
#include <stdexcept>
#include "${join(overlay, "mcp_bridge.h")}"
static int g_replyDepth = 0;
${guards}
${callbacks}
int main() {
${body}
}
`);
  execFileSync(compiler!, ["-std=c++14", "-Wall", "-Wextra", "-Werror", source, "-o", exe]);
  return lf(execFileSync(exe, { encoding: "utf8" }));
}

it.skipIf(!compiler)("synchronous flag-change output is visible, but its reply remains filtered", () => {
  const actor = readFileSync(join(overlay, "mcp_actorstate.cpp"), "utf8");
  const setprop = actor.slice(actor.indexOf("CCMD( mcp_setprop )"));
  const call = setprop.match(/^\t+if \( isFlag \) MCP_GameCall\( .*MCP_ChangeFlag\( a, fd, v\.num != 0 \).*;$/m)?.[0];
  expect(call).toBeDefined();
  runNative("setflag", 'static void MCP_ChangeFlag(int, int, bool) { assert(MCP_Bridge_ShowInNotify("game flag")); }', `
  assert(MCP_Bridge_ShowInNotify("console"));
  {
    MCPBridgeReplyGuard reply;
    MCPBridgeReplyGuard nestedReply;
    int a = 0, fd = 0;
    bool isFlag = true;
    struct { int num; } v = { 1 };
    ${call}
    assert(!MCP_Bridge_ShowInNotify("flagged reply"));
    assert(g_replyDepth == 2);
    assert(MCP_GameCall([] { return 7; }) == 7);
    try { MCP_GameCall([] { throw std::runtime_error("game callback"); }); }
    catch (const std::runtime_error &) {}
    assert(g_replyDepth == 2);
    MCP_GameCall([] {
      assert(MCP_Bridge_ShowInNotify("game"));
      MCP_GameCall([] { assert(MCP_Bridge_ShowInNotify("nested game")); });
    });
    assert(!MCP_Bridge_ShowInNotify("bridge reply"));
  }
  assert(MCP_Bridge_ShowInNotify("later tic"));
`);
});

it.skipIf(!compiler).each([0, 1])("probe collision callback %i can log while its reply stays filtered", (index) => {
  const actor = readFileSync(join(overlay, "mcp_actorstate.cpp"), "utf8");
  const calls = [...actor.matchAll(/^\t+if \( !((?:MCP_GameCall\( \[&\]\(\) \{ return )?P_CheckPosition\( [^)]* \)(?:; \} \))?) \)/gm)];
  expect(calls).toHaveLength(2);
  const expression = calls[index][1];
  const args = expression.match(/P_CheckPosition\( (.*?) \)/)![1].split(", ");
  const locals = args.map((arg) => arg === "probe.actor" ? "struct { int actor; } probe = {0};" : `int ${arg} = 0;`).join("\n");
  const output = runNative(`collision-${index}`, `
static bool CanCollideWith() {
  if (MCP_Bridge_ShowInNotify("game collision")) std::puts("game collision");
  return true;
}
template <class... Args> static bool P_CheckPosition(Args...) { return !CanCollideWith(); }
`, `
  MCPBridgeReplyGuard reply;
  ${locals}
  assert(!(${expression}));
  assert(!MCP_Bridge_ShowInNotify("probe reply"));
`);
  expect(output).toBe("game collision\n");
});
