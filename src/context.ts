import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  EngineExitedError,
  InstanceRegistry,
  PortWaitError,
  defaultLaunchIo,
  defaultQuitIo,
  type LaunchIo,
  type QuitResult,
} from "./process/registry.js";
import {
  deriveBasePort,
  findFreePort,
  gamelogPrefix,
  resolveEngineExe,
  resolveScreenshotDir,
  tryConnect,
} from "./process/launch.js";
import { reapOrphanEngines, defaultIo as defaultReapIo, type ReapResult, type ReapOptions } from "./process/reap.js";
import { hasBridge } from "./process/verify.js";
import { crashLogPath } from "./process/startuplog.js";
import { buildIndex, type AcsIndex } from "./acs/symbols.js";
import { compileAcs, defaultCompileDeps, removeDir, type CompileRequest, type CompileResult } from "./acs/compile.js";
import { resolveMapSlot, type MapSlotRequest, type MapSlotResult } from "./acs/probe.js";
import { collectAcsModulesAt, type AcsModule } from "./acs/collect.js";
import { importsOf, parseProfile, profilesFor, type RunAcsProfile } from "./acs/profiles.js";
import { readMapFromContainer, type MapData } from "./map/index.js";
import { captureScreenshot, readShot } from "./screenshot/capture.js";
import type { BridgeClient } from "./bridge/transport.js";
import type { PlayedDemo } from "./demo/play.js";
import { envName, type EngineAdapter } from "./adapter.js";

/** Everything the tools need from the environment, resolved once at startup. */
export interface ServerConfig {
  host: string;
  basePort: number;
  /** Path to the bridge-patched engine binary, if one is configured. */
  exe?: string;
  screenshotDir: string;
  iwad?: string;
  acsSrc?: string;
  /** Savegame dir: `<PREFIX>_SAVE_DIR`, else the engine's default (`resolveSaveDir`). */
  saveDir?: string;
  /** `run_acs` compilers; default to `zt-bcc`/`bcc` or `acc` on PATH. */
  bcc?: string;
  acc?: string;
  /** `run_acs` profile files (`<PREFIX>_RUNACS_PROFILES`, `path.delimiter`-separated). */
  runAcsProfiles?: string[];
  /** The gamelog prefix launches use (`gamelogPrefix`); its dir holds earlier sessions' gamelogs. */
  gamelog?: string;
  /** Where a bare `record` name lands: `<PREFIX>_DEMO_DIR`, else the exe's dir. */
  demoDir?: string;
}

/** The server's config from `<PREFIX>_*` env vars, so MCP clients can pass it in their config. */
export function configFromEnv(engine: EngineAdapter, env: NodeJS.ProcessEnv): ServerConfig {
  const get = (suffix: string) => env[envName(engine, suffix)];
  // Accept either the macOS .app bundle or the binary directly.
  const raw = get("EXE");
  const exe = raw ? resolveEngineExe(raw, engine) : undefined;
  const profiles = (get("RUNACS_PROFILES") ?? "").split(path.delimiter).map((p) => p.trim()).filter(Boolean);
  return {
    host: get("BRIDGE_HOST") ?? "127.0.0.1",
    // Derived from the engine path unless pinned, so separate checkouts don't all fight over 7777.
    basePort: deriveBasePort(exe, get("BRIDGE_PORT")),
    exe,
    screenshotDir: resolveScreenshotDir(exe, get("SCREENSHOT_DIR")),
    iwad: get("IWAD"),
    acsSrc: get("ACS_SRC"),
    saveDir: engine.resolveSaveDir(env, exe),
    bcc: get("BCC"),
    acc: get("ACC"),
    runAcsProfiles: profiles.length > 0 ? profiles : undefined,
    gamelog: gamelogPrefix(engine, exe, env),
    demoDir: get("DEMO_DIR") ?? (exe && path.dirname(exe)),
  };
}

/** `launch_instance`'s tool-level options, `iwad` already resolved. */
export interface LaunchArgs {
  iwad?: string;
  files?: string[];
  map?: string;
  skill?: number;
  fullscreen?: boolean;
  width?: number;
  height?: number;
  extraArgs?: string[];
  config?: "shared" | "isolated";
  /** false: return once spawned; the instance attaches on first use. */
  wait?: boolean;
  /** The absolute `.lmp` path a `-record` launch writes, so tools know the instance records. */
  record?: string;
  /** The absolute savegame path a launch starts from (`-loadgame`). */
  save?: string;
  /** Pin `use_mouse` (`buildLaunchArgs`). */
  mouse?: boolean;
}

/** What `relaunch_instance` reuses: the last launch's options and where it ran. */
export interface LastLaunch {
  args: LaunchArgs;
  port: number;
  logFile: string;
  enginePid?: number;
  /** The bridge version its hello gave, once attached. */
  bridge?: string;
}

/**
 * Side-effecting I/O the tools do, behind one injectable seam so every tool
 * branch is testable without a real engine, real clock, or real files.
 */
export interface ContextIo {
  existsSync: (p: string) => boolean;
  readFileSync: (p: string) => Buffer;
  readTextSync: (p: string) => string;
  /** Up to the first `bytes` bytes of a file, so a type check needn't read it whole. */
  readHeadSync: (p: string, bytes: number) => Buffer;
  readdirSync: (p: string) => string[];
  isDirSync: (p: string) => boolean;
  realpathSync: (p: string) => string;
  /** Change-detection stamp for a file; used to invalidate parse caches. */
  stampOf: (p: string) => string;
  mtimeOf: (p: string) => Date;
  sleep: (ms: number) => Promise<void>;
  /** Whether a process is still running. */
  alive: (pid: number) => boolean;
  /** Run `fn` every `ms` until the returned cancel is called. */
  every: (ms: number, fn: () => void) => () => void;
  capture: (
    client: BridgeClient,
    dir: string,
    opts?: { name?: string; keep?: boolean },
  ) => Promise<{ base64: string; path: string }>;
  /** Wait for a shot the engine was told to write elsewhere (`<dir>/<name>.png`) and read it; deleted unless `keep`. */
  readShot: (dir: string, name: string, keep: boolean) => Promise<{ base64: string; path: string }>;
  findFreePort: (start: number) => Promise<number>;
  /** Whether host:port accepts a connection right now (one try). */
  portOpen: (host: string, port: number) => Promise<boolean>;
  hasBridge: (exe: string, marker: string) => boolean;
  reap: (exe: string, opts?: ReapOptions) => Promise<ReapResult>;
  launchIo: LaunchIo;
  compileAcs: (req: CompileRequest) => CompileResult;
  removeDir: (dir: string) => void;
  /** A fresh temp dir named `prefix` plus a unique suffix (mkdtempSync). */
  mkdtemp: (prefix: string) => string;
  /** Delete a file; a missing one is no error. */
  removeFile: (p: string) => void;
  /** The map-var tools' `sourceFile` lookup: two compiles in a temp dir it removes itself. */
  resolveMapSlot: (req: MapSlotRequest) => MapSlotResult[];
  mkdirp: (dir: string) => void;
  /** A file's sha1 and size, read in chunks. */
  sha1Of: (p: string) => { sha1: string; bytes: number };
  /** The git HEAD and dirtiness of the work tree holding `p`, or undefined outside one. */
  gitRevOf: (p: string) => { rev: string; dirty: boolean } | undefined;
  /** Write via a temp file and rename, so a reader never sees a half-written file. */
  writeFileAtomic: (p: string, data: string | Buffer) => void;
  now: () => Date;
}

function sha1File(p: string): { sha1: string; bytes: number } {
  const hash = createHash("sha1");
  const buf = Buffer.alloc(1 << 20);
  const fd = openSync(p, "r");
  let bytes = 0;
  try {
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0; bytes += n) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return { sha1: hash.digest("hex"), bytes };
}

function gitRev(p: string): { rev: string; dirty: boolean } | undefined {
  const dir = statSync(p).isDirectory() ? p : path.dirname(p);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
  try {
    return { rev: git("rev-parse", "HEAD").trim(), dirty: git("status", "--porcelain").trim() !== "" };
  } catch {
    return undefined;
  }
}

function writeAtomic(p: string, data: string | Buffer): void {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, data, { flag: "wx" });
  renameSync(tmp, p);
}

export const defaultContextIo: ContextIo = {
  existsSync: (p) => existsSync(p),
  readFileSync: (p) => readFileSync(p),
  readTextSync: (p) => readFileSync(p, "utf8"),
  readHeadSync: (p, bytes) => {
    const fd = openSync(p, "r");
    try {
      const buf = Buffer.alloc(bytes);
      return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
    } finally {
      closeSync(fd);
    }
  },
  readdirSync: (p) => readdirSync(p),
  isDirSync: (p) => statSync(p).isDirectory(),
  realpathSync: (p) => realpathSync(p),
  stampOf: (p) => {
    const s = statSync(p);
    return `${s.mtimeMs}:${s.size}`;
  },
  mtimeOf: (p) => statSync(p).mtime,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  alive: defaultQuitIo.alive,
  every: (ms, fn) => {
    const timer = setInterval(fn, ms);
    // Never let a progress ticker hold the process open.
    timer.unref?.();
    return () => clearInterval(timer);
  },
  capture: (client, dir, opts) => captureScreenshot(client, { dir, ...opts }),
  readShot: (dir, name, keep) => readShot({ dir, name, keep }),
  findFreePort: (start) => findFreePort(start),
  portOpen: (host, port) => tryConnect(host, port),
  hasBridge: (exe, marker) => hasBridge(exe, marker),
  reap: (exe, opts) => reapOrphanEngines(exe, defaultReapIo, opts),
  launchIo: defaultLaunchIo,
  compileAcs: (req) => compileAcs(req),
  removeDir: (dir) => removeDir(dir),
  mkdtemp: (prefix) => mkdtempSync(prefix),
  removeFile: (p) => rmSync(p, { force: true }),
  resolveMapSlot: (req) => resolveMapSlot(req, { readFile: (p) => readFileSync(p), compile: defaultCompileDeps, removeDir }),
  mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
  sha1Of: sha1File,
  gitRevOf: gitRev,
  writeFileAtomic: writeAtomic,
  now: () => new Date(),
};

/**
 * Shared state and helpers for the tool layer: which port each instance is on,
 * the bridge connections, and the parse caches for WADs and ACS source.
 *
 * Split out of the tool definitions so the tools stay declarative and this —
 * the part with the caching, port and attach logic worth testing — is a plain
 * object with injected I/O.
 */
export class ServerContext {
  /**
   * Ports this session has actually bound an instance to — by launching it, or
   * by an explicit attach_instance.
   *
   * An instance number is meaningful only WITHIN a session. Several editor
   * windows each run their own MCP server, and every one of them would call the
   * conventional port "instance 1"; connecting there on demand meant one
   * session silently driving another's game. So a tool call for an unbound
   * instance is an error, not a guess.
   */
  private readonly boundPorts = new Map<number, number>();
  /** Per-instance engine console logfile (<PREFIX>_BRIDGE_LOG). */
  private readonly logFiles = new Map<number, string>();
  /** In-flight attaches, keyed by instance — see `clientFor`. */
  private readonly attaching = new Map<number, Promise<BridgeClient>>();
  /** Engine PID per instance (the launched child's, or an attached bridge's): checked on re-attach and matched against a get_crash report. */
  private readonly enginePids = new Map<number, number>();
  /** Each instance's last launch, kept past kill/reset/crash for `relaunch_instance`. */
  private readonly lastLaunch = new Map<number, LastLaunch>();
  private readonly demos = new Map<number, PlayedDemo>();
  private readonly maps = new Map<string, { stamp: string; data: MapData }>();
  private readonly acsIndexes = new Map<string, { stamp: string; index: AcsIndex }>();
  private readonly acsModules = new Map<string, { stamp: string; modules: AcsModule[] }>();

  constructor(
    readonly engine: EngineAdapter,
    readonly config: ServerConfig,
    readonly io: ContextIo = defaultContextIo,
    readonly registry: InstanceRegistry = new InstanceRegistry(engine),
  ) {}

  /** The name of one of the engine's env vars, e.g. `ctx.env("EXE")`. */
  env(suffix: string): string {
    return envName(this.engine, suffix);
  }

  /** The conventional port for an instance: instance 1 gets the base port. */
  portFor(instance: number): number {
    return this.config.basePort + (instance - 1);
  }

  /** The port an instance is bound to, or the conventional one if unbound. */
  effectivePort(instance: number): number {
    return this.boundPorts.get(instance) ?? this.portFor(instance);
  }

  /** Whether this session has claimed an instance number. */
  isBound(instance: number): boolean {
    return this.boundPorts.has(instance);
  }

  /** Every instance number this session has claimed, ascending. */
  boundInstances(): number[] {
    return [...this.boundPorts.keys()].sort((a, b) => a - b);
  }

  /** Claim an instance number for a port, without a launch behind it. */
  bind(instance: number, port: number): void {
    this.boundPorts.set(instance, port);
  }

  rememberLaunch(instance: number, port: number, logFile: string): void {
    this.boundPorts.set(instance, port);
    this.logFiles.set(instance, logFile);
    // A new engine is starting, so the last one's PID no longer names this instance.
    this.enginePids.delete(instance);
  }

  /** Record which process is this instance's engine. */
  rememberEngine(instance: number, pid: number | undefined): void {
    if (pid === undefined) return;
    this.enginePids.set(instance, pid);
    const last = this.lastLaunch.get(instance);
    if (last) last.enginePid = pid;
  }

  /** Store a launch's options before its spawn, so a launch that never came up stays relaunchable. */
  rememberLaunchArgs(instance: number, args: LaunchArgs, port: number, logFile: string): void {
    this.lastLaunch.set(instance, { args, port, logFile });
  }

  launchArgsFor(instance: number): LastLaunch | undefined {
    return this.lastLaunch.get(instance);
  }

  forgetLaunchArgs(instance: number): void {
    this.lastLaunch.delete(instance);
  }

  /** Keep the bridge version an instance's hello gave, for its recording's sidecar. */
  rememberBridge(instance: number, client: BridgeClient): void {
    const last = this.lastLaunch.get(instance);
    if (last && client.bridgeVersion !== undefined) last.bridge = client.bridgeVersion;
  }

  /** The engine PID recorded for the instance, if any. */
  enginePidFor(instance: number): number | undefined {
    return this.enginePids.get(instance);
  }

  /** The demo `play_demo` last started on an instance, for `seek_demo`'s rewind. */
  rememberDemo(instance: number, demo: PlayedDemo): void {
    this.demos.set(instance, demo);
  }

  demoFor(instance: number): PlayedDemo | undefined {
    return this.demos.get(instance);
  }

  // forgetInstance/forgetAll keep lastLaunch: relaunch must work after kill_instance and reset.
  forgetInstance(instance: number): void {
    this.boundPorts.delete(instance);
    this.logFiles.delete(instance);
    this.enginePids.delete(instance);
    this.demos.delete(instance);
  }

  forgetAll(): void {
    this.boundPorts.clear();
    this.logFiles.clear();
    this.enginePids.clear();
    this.demos.clear();
  }

  /** Where an instance's engine console log lives, if it can be determined. */
  logPathFor(instance: number): string | undefined {
    const known = this.logFiles.get(instance);
    if (known) return known;
    return this.config.exe
      ? path.join(path.dirname(this.config.exe), `mcp-bridge-${this.effectivePort(instance)}.log`)
      : undefined;
  }

  /** An instance's crash report and its file's mtime, or undefined when there is none. */
  readCrash(instance: number): { file: string; report: string; written: Date } | undefined {
    const logFile = this.logPathFor(instance);
    const file = logFile && crashLogPath(logFile);
    return file && this.io.existsSync(file)
      ? { file, report: this.io.readTextSync(file), written: this.io.mtimeOf(file) }
      : undefined;
  }

  /** An instance's engine console log text, or undefined when there is none to read. */
  readLog(instance: number): string | undefined {
    const logFile = this.logPathFor(instance);
    return logFile && this.io.existsSync(logFile) ? this.io.readTextSync(logFile) : undefined;
  }

  /**
   * Lazily attach to instance N on first use.
   *
   * Concurrent callers share one attach: MCP clients issue tool calls in
   * parallel, and without this each would see "not attached", open its own
   * socket, and all but the last would be orphaned in the registry — leaked
   * connections plus a bridge talking to a client nobody holds.
   *
   * A re-attach also re-checks identity. `launch_instance` verifies the bridge
   * it connected to is the process it spawned, but that guarantee expires the
   * moment the connection drops: if the engine dies and anything else takes its
   * port, the next tool call would silently drive the wrong process. So when we
   * know which PID an instance is supposed to be, a mismatch fails loudly
   * instead.
   *
   * An instance launched with `wait: false` attaches here, waiting for its bridge (`attachPending`).
   */
  async clientFor(instance: number): Promise<BridgeClient> {
    if (this.registry.has(instance)) return this.registry.get(instance);
    if (!this.isBound(instance)) {
      throw new Error(
        `Instance ${instance} isn't running in this session. Start it with ` +
          `launch_instance, or point at an engine you started yourself with ` +
          `attach_instance. (Instance numbers are per-session — connecting to ` +
          `whatever happens to be on port ${this.portFor(instance)} could drive ` +
          `another editor window's game.)`,
      );
    }
    const inflight = this.attaching.get(instance);
    if (inflight) return inflight;
    const port = this.effectivePort(instance);
    const connect = this.registry.pending(instance)
      ? this.attachPending(instance, port)
      : this.registry.attach({ id: instance, host: this.config.host, port });
    const attach = connect
      .then((client) => {
        const expected = this.enginePids.get(instance);
        const actual = client.enginePid;
        // Only enforced when both sides report a PID — older bridges omit it.
        if (expected !== undefined && actual !== undefined && actual !== expected) {
          this.registry.detach(instance);
          throw new Error(
            `Bridge on ${this.config.host}:${port} is PID ${actual}, not the engine ` +
              `launched for instance ${instance} (PID ${expected}) — the original engine ` +
              `is gone and something else took its port. Run the "reset" tool, then relaunch.`,
          );
        }
        this.rememberBridge(instance, client);
        return client;
      })
      .finally(() => this.attaching.delete(instance));
    this.attaching.set(instance, attach);
    return attach;
  }

  /** Wait for a spawned instance's bridge and attach, failing on any exit, since a wrapper that
   *  backgrounds the engine would fail the PID handshake anyway. */
  private attachPending(instance: number, port: number): Promise<BridgeClient> {
    const target = { id: instance, host: this.config.host, port };
    return this.registry.attachSpawned(target, this.io.launchIo, true).catch((e: unknown) => {
      if (e instanceof EngineExitedError) {
        throw new Error(`Instance ${instance}'s ${e.message}; get_startup_errors shows why.`);
      }
      if (e instanceof PortWaitError) {
        throw new Error(
          `Instance ${instance} (launched with wait: false) has no bridge on port ${port} yet: ${e.message}. ` +
            `If it is still starting (a netgame host opens its bridge only once its lobby fills), call again later; kill_instance stops it.`,
        );
      }
      throw e;
    });
  }

  /** Quit an instance, attaching a pending one whose bridge is up first, since a SIGKILLed netgame
   *  host can freeze its guests; one with no bridge yet is force-killed at once. */
  async quit(instance: number): Promise<QuitResult> {
    if (this.registry.pending(instance)) {
      if (await this.io.portOpen(this.config.host, this.effectivePort(instance))) {
        await this.clientFor(instance).catch(() => undefined);
      }
      if (!this.registry.find(instance)) {
        this.registry.kill(instance);
        return "unbridged";
      }
    }
    return this.registry.quit(instance);
  }

  /** Peek at an instance's client without attaching, connecting, or throwing —
   *  see `InstanceRegistry.find`. Used by `registerLive` (tools.ts) so the
   *  live-status wrapper can never itself open a socket or fail a tool call. */
  attachedClient(instance: number): BridgeClient | undefined {
    return this.registry.find(instance);
  }

  /**
   * Read a map from a WAD/PK3, memoised so a slaughtermap is parsed once and
   * then sliced per query.
   *
   * Keyed on the container's mtime+size, not just its path: the whole point of
   * this server is an agent editing a WAD and re-inspecting it, and a
   * path-keyed cache would keep serving the pre-edit geometry forever. A
   * changed stamp replaces the entry, so the cache also can't grow without
   * bound for a file being edited in a loop.
   */
  loadMap(file: string | undefined, map: string): MapData {
    const wad = file ?? this.config.iwad;
    if (!wad) throw new Error(`No WAD specified. Pass \`file\` or set ${this.env("IWAD")}.`);
    const key = `${wad}|${map.toUpperCase()}`;
    const stamp = this.io.stampOf(wad);
    const hit = this.maps.get(key);
    if (hit && hit.stamp === stamp) return hit.data;
    const data = readMapFromContainer(this.io.readFileSync(wad), map);
    this.maps.set(key, { stamp, data });
    return data;
  }

  /** The ACS modules a launch file holds, memoised on a regular file's stamp but not a directory's,
   *  which doesn't move when a file inside it is rewritten. */
  deployedModules(file: string): AcsModule[] {
    const skips = (name: string, isDir: boolean) => this.engine.dirWalkSkips(name, isDir, process.platform);
    if (this.io.isDirSync(file)) return collectAcsModulesAt(file, this.io, skips);
    const stamp = this.io.stampOf(file);
    const hit = this.acsModules.get(file);
    if (hit && hit.stamp === stamp) return hit.modules;
    const modules = collectAcsModulesAt(file, this.io, skips);
    this.acsModules.set(file, { stamp, modules });
    return modules;
  }

  /**
   * Index a directory of .acs sources, memoised on the stamps of the files
   * themselves. A directory's own mtime doesn't move when a file's contents
   * change, so the stamp covers every .acs file in it — otherwise an agent that
   * edits a script keeps resolving symbols against the version it started with.
   */
  loadAcsIndex(dir: string | undefined): AcsIndex {
    const src = dir ?? this.config.acsSrc;
    if (!src) throw new Error(`No ACS source dir. Pass \`dir\` or set ${this.env("ACS_SRC")}.`);
    const names = this.io
      .readdirSync(src)
      .filter((f) => f.toLowerCase().endsWith(".acs"))
      .sort();
    const stamp = names.map((n) => `${n}@${this.io.stampOf(path.join(src, n))}`).join("|");
    const hit = this.acsIndexes.get(src);
    if (hit && hit.stamp === stamp) return hit.index;
    const files = names.map((f) => ({ path: f, text: this.io.readTextSync(path.join(src, f)) }));
    const index = buildIndex(files);
    this.acsIndexes.set(src, { stamp, index });
    return index;
  }

  /** The `run_acs` profiles a snippet's `#import`s select, reread every call so an edit needs no reconnect. */
  runAcsProfiles(source: string): RunAcsProfile[] {
    const files = this.config.runAcsProfiles;
    if (!files || importsOf(source).length === 0) return [];
    const env = this.env("RUNACS_PROFILES");
    const profiles = files.map((file) => {
      let text: string;
      try {
        text = this.io.readTextSync(file);
      } catch (e) {
        throw new Error(`can't read run_acs profile ${file} (listed in ${env}): ${(e as Error).message}`);
      }
      try {
        return parseProfile(text, file);
      } catch (e) {
        throw new Error(`${(e as Error).message} (listed in ${env})`);
      }
    });
    return profilesFor(source, profiles);
  }

  /** Where savegames live: explicit arg, else the configured dir. */
  resolveSaveDir(dir?: string): string {
    const d = dir ?? this.config.saveDir;
    if (!d) throw new Error(`No save dir. Pass \`dir\`, or set ${this.env("SAVE_DIR")} or ${this.env("EXE")}.`);
    return d;
  }

  /** The `.zds` files in a save dir, relative to it; one subfolder level deep when the engine nests saves. */
  saveFiles(dir: string): string[] {
    const names = this.io.readdirSync(dir);
    const subs = this.engine.saveSubdirs ? names.filter((f) => this.io.isDirSync(path.join(dir, f))) : [];
    return [
      ...names.filter((f) => !subs.includes(f)),
      ...subs.flatMap((s) => this.io.readdirSync(path.join(dir, s)).map((f) => path.join(s, f))),
    ].filter((f) => f.toLowerCase().endsWith(".zds"));
  }
}
