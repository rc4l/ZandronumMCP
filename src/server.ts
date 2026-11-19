#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { ServerContext, configFromEnv } from "./context.js";
import { registerTools } from "./tools.js";
import { engine } from "./engine.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const config = configFromEnv(engine, process.env);
const ctx = new ServerContext(engine, config);
const server = new McpServer({ name: engine.serverName, version });
registerTools(server, ctx);

// Kill any games we launched when the server goes away, so they don't linger as
// stray dock processes after the editor closes the MCP session. Detached + unref
// keeps the game off our event loop, but it also means nothing else reaps it.
let cleanedUp = false;
function cleanupAndExit(code: number): void {
  if (cleanedUp) return;
  cleanedUp = true;
  // Ask each engine to quit itself before we go: hard-killing mid-render can
  // wedge macOS GPU teardown into an unkillable process. Short budget so shutdown
  // stays snappy; quitAll force-kills whatever ignores the request.
  ctx.registry
    .quitAll(2500)
    .catch(() => {
      /* best-effort */
    })
    .finally(() => process.exit(code));
}

async function main(): Promise<void> {
  // Last line of defence: a hung/failed engine launch, a socket that faults
  // after teardown, or any stray async error must never take the whole server
  // down — an MCP server has to survive a single bad tool call. Log to stderr
  // and keep running. (Per-handler paths already return proper error results;
  // this only catches anything that escaped a handler's promise chain.)
  process.on("uncaughtException", (err) => {
    process.stderr.write(
      `uncaughtException (kept alive): ${err instanceof Error ? err.stack : String(err)}\n`,
    );
  });
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `unhandledRejection (kept alive): ${reason instanceof Error ? reason.stack : String(reason)}\n`,
    );
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the MCP channel; logs go to stderr.
  process.stderr.write(
    `${engine.serverName} ready (bridge ${config.host}:${config.basePort}+, engine ${config.exe ?? "unset"})\n`,
  );

  // The client closing stdin (session ended) or a terminating signal both mean
  // "shut down" — reap launched instances first. `exit` is the sync safety net.
  process.stdin.on("end", () => cleanupAndExit(0));
  process.stdin.on("close", () => cleanupAndExit(0));
  process.on("SIGINT", () => cleanupAndExit(0));
  process.on("SIGTERM", () => cleanupAndExit(0));
  process.on("exit", () => {
    try {
      ctx.registry.closeAll();
    } catch {
      /* best-effort */
    }
  });

  // Sweep engines orphaned by earlier sessions (launcher dead => PPID 1) so they
  // can't pile up across sessions and squat bridge ports. Strictly orphans-only:
  // instances owned by another live MCP server are never touched. Best-effort and
  // non-blocking — the server is already serving by this point.
  if (config.exe) {
    void ctx.io
      .reap(config.exe, { onlyOrphans: true })
      .then((r) => {
        if (!r.found.length) return;
        const wedged = r.survivors.length
          ? `; ${r.survivors.length} wedged and unkillable (PIDs ${r.survivors.join(", ")}) — log out to clear`
          : "";
        process.stderr.write(
          `startup sweep: reaped ${r.killed.length} orphaned engine(s)${wedged}\n`,
        );
      })
      .catch(() => {
        /* best-effort */
      });
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
