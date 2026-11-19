import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { envName, type EngineAdapter } from "../adapter.js";

/**
 * Accept `<PREFIX>_EXE` pointing at either the macOS `.app` bundle or the binary
 * directly. A `.app` resolves to its inner executable so users can set the
 * friendly bundle path (e.g. `…/<engine>-mcp-hooks.app`); anything else is
 * returned as-is.
 */
export function resolveEngineExe(exe: string, engine: Pick<EngineAdapter, "macHooksBinary">): string {
  const trimmed = exe.replace(/[/\\]+$/, "");
  return trimmed.toLowerCase().endsWith(".app")
    ? join(trimmed, "Contents", "MacOS", engine.macHooksBinary)
    : exe;
}

/**
 * Where the engine writes named screenshots: its own working directory, which
 * is `dirname(exe)` (the engine cwd we launch it in). The engine ignores
 * `screenshot_dir` for named screenshots, so the server must look here. An
 * explicit `<PREFIX>_SCREENSHOT_DIR` overrides; with no engine configured we
 * fall back to the process cwd.
 */
export function resolveScreenshotDir(
  exe: string | undefined,
  envDir: string | undefined,
): string {
  if (envDir) return envDir;
  return exe ? dirname(exe) : ".";
}

/**
 * Best-effort strip of `com.apple.quarantine` from the engine folder on macOS.
 *
 * Engines downloaded from the GitHub Release are ad-hoc signed but not notarized,
 * and the download tags every file with `com.apple.quarantine`. Gatekeeper then
 * refuses the binary ("Apple could not verify..."), which also kills it when we
 * spawn it. Clearing the attribute from the engine's directory lets the
 * already-bridge-verified binary the user pointed us at actually launch — the
 * same `xattr -dr` the manual instructions document, just done for them.
 *
 * No-op off macOS. Failures are swallowed: the user can still clear it by hand,
 * or it may already be clear (e.g. a self-built engine). `platform`/`run` are
 * injectable for tests.
 */
export function clearQuarantine(
  exe: string,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = (cmd, args) =>
    void execFileSync(cmd, args, { stdio: "ignore" }),
): void {
  if (platform !== "darwin") return;
  try {
    run("xattr", ["-dr", "com.apple.quarantine", dirname(exe)]);
  } catch {
    // not fatal — fall back to the manual instructions in the README
  }
}

/**
 * Build the child-process environment for a launched instance: the bridge port
 * the engine listens on, plus — on macOS — the dylib search path the engine
 * bundle needs. The macOS release engine ships its SDL/FMOD dylibs next to the
 * binary; sdl12-compat dlopen()s libSDL2 by leaf name at runtime, which dyld
 * only resolves via DYLD_LIBRARY_PATH, so we point it at the binary's folder.
 * (`@loader_path` covers the directly-linked dylibs; this covers the dlopen.)
 *
 * On Linux/X11 it also defaults `DISPLAY` to `:0` when unset: IDEs frequently
 * spawn the MCP server (over stdio) in an environment without `DISPLAY`, and the
 * game — which we launch with our own env — then can't reach the X server and
 * never opens a window (see issue #6). We only fill it in when missing, so a real
 * `DISPLAY` (e.g. `:1`, or a remote one) is always respected.
 *
 * The engine adds its own extras (`launchEnv`, e.g. window placement); a key
 * the launching environment already sets always wins.
 *
 * Pure and parameterised so every branch is unit-testable off-platform.
 */
export function buildLaunchEnv(
  engine: EngineAdapter,
  exe: string,
  port: number,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  parentPid: number = process.pid,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    [envName(engine, "BRIDGE_PORT")]: String(port),
    // The engine's watchdog exits the game if this PID (the MCP server) dies, so a
    // launched instance can never outlive the session that spawned it and linger
    // as a stale bridge. See mcp_bridge.cpp WatchdogThread.
    [envName(engine, "BRIDGE_PARENT_PID")]: String(parentPid),
  };
  if (platform === "darwin") {
    const dir = dirname(exe);
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${dir}:${env.DYLD_LIBRARY_PATH}` : dir;
  }
  if (platform === "linux" && !env.DISPLAY) {
    env.DISPLAY = ":0";
  }
  for (const [key, value] of Object.entries(engine.launchEnv(base, platform))) {
    if (!env[key]) env[key] = value;
  }
  return env;
}

/**
 * How far apart two engine builds' port ranges sit. Wider than findFreePort's
 * search span, so one build's instances can never wander into another's range.
 */
export const PORT_STRIDE = 20;
/** Number of distinct derived ranges before they wrap and can collide. */
const PORT_BUCKETS = 64;
export const DEFAULT_BASE_PORT = 7777;

/**
 * The bridge port an engine's instance 1 listens on.
 *
 * An explicit <PREFIX>_BRIDGE_PORT always wins. Otherwise it is derived from
 * the engine's path, so several checkouts of the same project — each with its
 * own build, each driven by its own editor session — land in different port
 * ranges without anyone configuring anything. Sessions sharing one build still
 * share a range; that is what the per-instance free-port scan and the refusal to
 * attach to an unbound port are for.
 */
export function deriveBasePort(exe: string | undefined, envPort: string | undefined): number {
  if (envPort !== undefined) {
    const explicit = Number.parseInt(envPort, 10);
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
  }
  if (!exe) return DEFAULT_BASE_PORT;
  // First 4 bytes of the digest is plenty of spread for 64 buckets.
  const digest = createHash("sha1").update(exe).digest();
  return DEFAULT_BASE_PORT + (digest.readUInt32BE(0) % PORT_BUCKETS) * PORT_STRIDE;
}

/**
 * Where a launched engine keeps its own config, so agent-driven runs can't
 * scribble on the user's real settings.
 *
 * The engines store their ini under the user's preferences directory, NOT next
 * to the binary, so every build on the machine reads and writes the SAME file —
 * this gives each checkout a dedicated one beside its binary instead.
 * `<PREFIX>_CONFIG` moves it, a relative one resolving against the engine's cwd as `-config` would.
 */
export function configPathFor(
  engine: Pick<EngineAdapter, "serverName" | "envPrefix">,
  exe: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolve(dirname(exe), env[envName(engine, "CONFIG")] || `${engine.serverName}.ini`);
}

/** Game options that map to engine command-line arguments. */
export interface LaunchOptions {
  iwad?: string;
  files?: string[];
  map?: string;
  skill?: number;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  extraArgs?: string[];
  /** Engine config file (-config). See configPathFor. */
  config?: string;
}

/** Where engine args carry `flag` (`-config`; case-insensitive), or -1. */
function argIndex(args: readonly string[] | undefined, flag: string): number {
  const want = flag.toLowerCase();
  return args?.findIndex((a) => a.toLowerCase() === want) ?? -1;
}

/** Whether engine args carry `flag`. */
export function hasArg(args: readonly string[] | undefined, flag: string): boolean {
  return argIndex(args, flag) >= 0;
}

/** Build the engine argv from structured options; `env` feeds the engine's own pins. */
export function buildLaunchArgs(
  o: LaunchOptions,
  engine: EngineAdapter,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args: string[] = [];
  // Before anything else: the config decides defaults the rest may override.
  // A caller's own -config in extraArgs wins, as the engine takes the first match.
  if (o.config && !hasArg(o.extraArgs, "-config")) args.push("-config", o.config);
  if (o.iwad && !hasArg(o.extraArgs, "-iwad")) args.push("-iwad", o.iwad);
  if (o.files?.length) args.push("-file", ...o.files);
  if (o.skill !== undefined) args.push("-skill", String(o.skill));
  // All +set pins precede +map, since +args run in argv order and a map launch would otherwise load with the saved values.
  //
  // Always pin the video mode so an agent-driven instance never inherits the
  // saved fullscreen cvar (it's CVAR_ARCHIVE) and takes over the user's
  // screen. Windowed unless fullscreen is explicitly requested.
  args.push("+set", engine.fullscreenCvar, o.fullscreen ? "1" : "0");
  if (o.width !== undefined) args.push("+set", "vid_defwidth", String(o.width));
  if (o.height !== undefined) args.push("+set", "vid_defheight", String(o.height));
  args.push(...engine.launchPins(o, env));
  if (o.map) args.push("+map", o.map);
  if (o.extraArgs?.length) args.push(...o.extraArgs);
  return args;
}

/** Resolve true once a TCP connection to host:port succeeds, false otherwise. */
export function tryConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.on("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Return the first port >= `start` that nothing is currently listening on, by
 * probing with a throwaway TCP connect. Used so a launch never collides with a
 * stale engine (or anything else) squatting the conventional instance port —
 * the launcher picks the next free port instead of silently attaching to it.
 */
export async function findFreePort(
  start: number,
  host = "127.0.0.1",
  span = 20,
  connect: (h: string, p: number) => Promise<boolean> = tryConnect,
): Promise<number> {
  for (let port = start; port < start + span; port++) {
    if (!(await connect(host, port))) return port; // nothing answered -> free
  }
  throw new Error(`no free bridge port in [${start}, ${start + span})`);
}

/** Poll until host:port accepts a connection, or throw after `attempts` tries. */
export async function waitForPort(
  host: string,
  port: number,
  attempts = 60,
  intervalMs = 700,
  connect: (h: string, p: number) => Promise<boolean> = tryConnect,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (await connect(host, port)) return;
    if (i < attempts - 1) await sleep(intervalMs);
  }
  throw new Error(`bridge port ${host}:${port} never opened`);
}
