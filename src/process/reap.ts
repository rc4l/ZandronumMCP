import { execFileSync } from "node:child_process";

/**
 * Best-effort reaping of engine processes that outlived their MCP session.
 *
 * With the engine's parent-death watchdog (mcp_bridge.cpp), a launched instance
 * normally exits on its own when its MCP server dies — so orphans should be rare.
 * This is the recovery hatch for the cases the watchdog can't cover: an engine
 * that wedged in the macOS window server during teardown, or one launched before
 * the watchdog existed. The `reset` tool calls it to clear the slate.
 */

export interface ReapResult {
  /** PIDs of engine processes found matching the exe. */
  found: number[];
  /** PIDs that were gone after we signalled them. */
  killed: number[];
  /** PIDs still alive after SIGKILL (e.g. wedged in the kernel — need a manual
   *  force-quit / logout). */
  survivors: number[];
}

export interface ReapIo {
  /** List PIDs of processes whose command line contains `needle`. */
  list: (needle: string) => number[];
  /** Send SIGKILL (or platform equivalent) to a PID. Never throws. */
  kill: (pid: number) => void;
  /** Whether a PID is still alive. */
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

/** Parse `ps -A -o pid=,command=` output into PIDs whose command contains needle. */
export function parsePsPids(psOutput: string, needle: string): number[] {
  const pids: number[] = [];
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes(needle)) continue;
    const pid = Number.parseInt(trimmed.split(/\s+/, 1)[0], 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.push(pid);
  }
  return pids;
}

/** The process-listing command per platform (wmic on Windows, ps elsewhere). */
export function psCommand(platform: NodeJS.Platform): { cmd: string; args: string[] } {
  return platform === "win32"
    ? { cmd: "wmic", args: ["process", "get", "ProcessId,CommandLine"] }
    : { cmd: "ps", args: ["-A", "-o", "pid=,command="] };
}

/** List PIDs whose command line contains `needle`. Returns [] if listing fails. */
export function listEnginePids(
  needle: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8" }),
): number[] {
  try {
    const { cmd, args } = psCommand(platform);
    return parsePsPids(run(cmd, args), needle);
  } catch {
    return [];
  }
}

export const defaultIo: ReapIo = {
  list: (needle) => listEnginePids(needle),
  kill: (pid) => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone, or not ours */
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function reapOrphanEngines(
  exePath: string,
  io: ReapIo = defaultIo,
): Promise<ReapResult> {
  const found = io.list(exePath);
  for (const pid of found) io.kill(pid);
  if (found.length) await io.sleep(300);
  const survivors = found.filter((pid) => io.alive(pid));
  const killed = found.filter((pid) => !survivors.includes(pid));
  return { found, killed, survivors };
}
