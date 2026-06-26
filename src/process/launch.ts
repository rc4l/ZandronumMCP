import net from "node:net";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Accept `ZANDRONUM_EXE` pointing at either the macOS `.app` bundle or the binary
 * directly. A `.app` resolves to its inner executable so users can set the
 * friendly bundle path (e.g. `…/Zandronum.app`); anything else is returned as-is.
 */
export function resolveEngineExe(exe: string): string {
  const trimmed = exe.replace(/[/\\]+$/, "");
  return trimmed.toLowerCase().endsWith(".app")
    ? join(trimmed, "Contents", "MacOS", "zandronum")
    : exe;
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
 * Pure and parameterised so both branches are unit-testable off-platform.
 */
export function buildLaunchEnv(
  exe: string,
  port: number,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ZANDRONUM_BRIDGE_PORT: String(port) };
  if (platform === "darwin") {
    const dir = dirname(exe);
    env.DYLD_LIBRARY_PATH = env.DYLD_LIBRARY_PATH ? `${dir}:${env.DYLD_LIBRARY_PATH}` : dir;
  }
  return env;
}

/** Game options that map to Zandronum command-line arguments. */
export interface LaunchOptions {
  iwad?: string;
  files?: string[];
  map?: string;
  skill?: number;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  extraArgs?: string[];
}

/** Build the argv for launching Zandronum from structured options. */
export function buildLaunchArgs(o: LaunchOptions): string[] {
  const args: string[] = [];
  if (o.iwad) args.push("-iwad", o.iwad);
  if (o.files?.length) args.push("-file", ...o.files);
  if (o.skill !== undefined) args.push("-skill", String(o.skill));
  if (o.map) args.push("+map", o.map);
  if (o.fullscreen !== undefined) args.push("+set", "fullscreen", o.fullscreen ? "1" : "0");
  if (o.width !== undefined) args.push("+set", "vid_defwidth", String(o.width));
  if (o.height !== undefined) args.push("+set", "vid_defheight", String(o.height));
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
