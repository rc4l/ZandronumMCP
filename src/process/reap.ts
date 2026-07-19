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
  /** Parent PID of `pid`, or undefined if it can't be read. On POSIX a value of
   *  1 means the process was reparented to launchd/init — i.e. whatever launched
   *  it is gone, which is exactly our "orphan" marker. */
  ppidOf: (pid: number) => number | undefined;
}

export interface ReapOptions {
  /** Only reap engines whose launcher is gone (PPID 1). Instances still owned by
   *  another live MCP session (PPID = that server) are left strictly alone —
   *  essential for the automatic startup sweep, which must never kill someone
   *  else's running game. Windows can't report this, so nothing is swept there. */
  onlyOrphans?: boolean;
}

/** Parse `ps -o ppid= -p <pid>` output into a PID. */
export function parsePpid(out: string): number | undefined {
  const n = Number.parseInt(out.trim(), 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

/** Read a process's parent PID. Returns undefined when it can't be determined. */
export function readPpid(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => string = (cmd, args) =>
    execFileSync(cmd, args, { encoding: "utf8" }),
): number | undefined {
  if (platform === "win32") return undefined; // no POSIX reparent-to-1 signal
  try {
    return parsePpid(run("ps", ["-o", "ppid=", "-p", String(pid)]));
  } catch {
    return undefined;
  }
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
  ppidOf: (pid) => readPpid(pid),
};

export async function reapOrphanEngines(
  exePath: string,
  io: ReapIo = defaultIo,
  opts: ReapOptions = {},
): Promise<ReapResult> {
  const all = io.list(exePath);
  // In orphan-only mode keep just the ones whose launcher died (PPID 1). Anything
  // we can't read a PPID for is left alone — better to miss an orphan than to
  // kill a live session's game.
  const found = opts.onlyOrphans ? all.filter((pid) => io.ppidOf(pid) === 1) : all;
  for (const pid of found) io.kill(pid);
  if (found.length) await io.sleep(300);
  const survivors = found.filter((pid) => io.alive(pid));
  const killed = found.filter((pid) => !survivors.includes(pid));
  return { found, killed, survivors };
}
