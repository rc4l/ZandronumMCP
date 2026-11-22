import { spawn as nodeSpawn } from "node:child_process";
import { BridgeClient } from "../bridge/transport.js";
import {
  buildLaunchArgs,
  buildLaunchEnv,
  clearQuarantine,
  configPathFor,
  waitForPort,
  type LaunchOptions,
} from "./launch.js";

export interface InstanceConfig {
  id: number;
  host?: string;
  port: number;
}

export interface ChildHandle {
  pid?: number;
  kill: () => void;
}

/** I/O seam for launching processes — injected so launch/kill are testable. */
export interface LaunchIo {
  spawn: (exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => ChildHandle;
  waitForPort: (host: string, port: number) => Promise<void>;
  /** Clear macOS quarantine from the engine folder so Gatekeeper won't kill it. */
  clearQuarantine: (exe: string) => void;
}

export const defaultLaunchIo: LaunchIo = {
  spawn: (exe, args, cwd, env) => {
    const cp = nodeSpawn(exe, args, { cwd, env, detached: true, stdio: "ignore" });
    cp.unref();
    // A detached child is still an EventEmitter on our side. If the OS fails to
    // spawn/exec it (ENOENT/EACCES, a Gatekeeper kill, an aborted startup) it
    // emits 'error' — and Node THROWS an unhandled 'error' event as an uncaught
    // exception, which would take the whole MCP server down. Swallow it to
    // stderr; the launch's waitForPort will still time out and surface a proper
    // tool error, and the server stays alive for the next call.
    cp.on("error", (err) => {
      process.stderr.write(`engine process (pid ${cp.pid ?? "?"}) error: ${err.message}\n`);
    });
    // SIGKILL, not the default SIGTERM: the engine doesn't reliably stop on a
    // graceful terminate, so force-kill to avoid leaving a stray process behind.
    // (Note: this still can't reap a process already wedged in the kernel during
    // teardown — see the macOS/Rosetta exit-hang issue.)
    return { pid: cp.pid, kill: () => void cp.kill("SIGKILL") };
  },
  waitForPort: (host, port) => waitForPort(host, port),
  clearQuarantine: (exe) => clearQuarantine(exe),
};

/** How often we re-check whether a quitting engine has actually exited. */
const QUIT_POLL_MS = 150;

/** I/O seam for the graceful-quit wait — injected so timing is testable. */
export interface QuitIo {
  alive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

export const defaultQuitIo: QuitIo = {
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

export interface LaunchConfig extends LaunchOptions {
  id: number;
  exe: string;
  cwd: string;
  port: number;
  host?: string;
  /** If set, the engine writes its console log here (ZANDRONUM_BRIDGE_LOG) so
   *  startup/compile errors can be read back even when the bridge never opens. */
  logFile?: string;
}

/** Tracks bridge connections — and now child processes — for one or more instances. */
export class InstanceRegistry {
  private readonly clients = new Map<number, BridgeClient>();
  private readonly children = new Map<number, ChildHandle>();

  async attach(config: InstanceConfig): Promise<BridgeClient> {
    const client = new BridgeClient({ host: config.host, port: config.port });
    await client.connect();
    this.clients.set(config.id, client);
    return client;
  }

  /** `attachSpawned` for a child `spawn` just started, reaping the child if the attach fails. */
  async attachOrKill(config: InstanceConfig, io: LaunchIo): Promise<BridgeClient> {
    try {
      return await this.attachSpawned(config, io);
    } catch (err) {
      // The launch failed (engine hung and the bridge never opened, or a stale
      // process squatted the port). Reap the child we just spawned so a failed
      // launch can't leave a hung engine orphaned on its port.
      this.kill(config.id);
      throw err;
    }
  }

  /** Spawn a bridge-enabled instance and register its child, without waiting for its bridge. */
  spawn(config: LaunchConfig, io: LaunchIo): ChildHandle {
    // Give the engine its own config unless the caller pinned one, so builds
    // can't trade cvars through the shared user-level ini.
    const args = buildLaunchArgs({ config: configPathFor(config.exe), ...config });
    const env = buildLaunchEnv(config.exe, config.port);
    if (config.logFile) env.ZANDRONUM_BRIDGE_LOG = config.logFile;
    io.clearQuarantine(config.exe);
    const child = io.spawn(config.exe, args, config.cwd, env);
    this.children.set(config.id, child);
    return child;
  }

  /** Wait for a spawned instance's bridge port and attach, leaving the child running on failure. */
  async attachSpawned(config: InstanceConfig, io: LaunchIo): Promise<BridgeClient> {
    const host = config.host ?? "127.0.0.1";
    const child = this.children.get(config.id);
    await io.waitForPort(host, config.port);
    const client = await this.attach({ id: config.id, host, port: config.port });

    // PID handshake: confirm we attached to the engine we just spawned and not a
    // stale bridge that still held the port. Only enforced when both sides report a
    // pid — older bridges omit it, so this stays backward compatible.
    const enginePid = client.enginePid;
    if (child?.pid !== undefined && enginePid !== undefined && enginePid !== child.pid) {
      throw new Error(
        `Bridge on ${host}:${config.port} is PID ${enginePid}, not the engine we ` +
          `launched (PID ${child.pid}) — a stale instance is squatting the port. ` +
          `Run the "reset" tool, then relaunch.`,
      );
    }
    return client;
  }

  get(id: number): BridgeClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`No attached instance with id ${id}`);
    return client;
  }

  has(id: number): boolean {
    return this.clients.has(id);
  }

  /** The PID of the child this registry launched for an instance, if it has one. */
  childPid(id: number): number | undefined {
    return this.children.get(id)?.pid;
  }

  /** Peek at an instance's client without attaching, connecting, or throwing.
   *  Used by the live-status wrapper, which must never open a socket or affect
   *  whether a tool call succeeds or fails. */
  find(id: number): BridgeClient | undefined {
    return this.clients.get(id);
  }

  /** Drop an instance's connection without touching its process. For letting go
   *  of a bridge that turned out not to be the engine we meant to talk to —
   *  killing it would be killing someone else's process. */
  detach(id: number): void {
    const client = this.clients.get(id);
    if (client) {
      client.close();
      this.clients.delete(id);
    }
  }

  /** Stop a launched instance's process (if any) and detach its client. */
  kill(id: number): void {
    const child = this.children.get(id);
    if (child) {
      child.kill();
      this.children.delete(id);
    }
    const client = this.clients.get(id);
    if (client) {
      client.close();
      this.clients.delete(id);
    }
  }

  /**
   * Ask the engine to shut itself down, and only force-kill if it doesn't go.
   *
   * A hard SIGKILL while the engine is mid-render can strand macOS GPU/Metal
   * teardown in an uninterruptible kernel wait — producing a process that
   * NOTHING can reap (not `kill -9`, not the reaper, not the startup sweep)
   * until the machine reboots. Letting the engine run its own shutdown lets the
   * GPU/XPC teardown finish normally. The force-kill remains as the backstop for
   * an engine that is already hung, so this never leaves an instance running.
   *
   * Resolves true if the engine exited on its own, false if it had to be forced.
   */
  async quit(id: number, timeoutMs = 5000, io: QuitIo = defaultQuitIo): Promise<boolean> {
    const client = this.clients.get(id);
    const pid = this.children.get(id)?.pid;
    if (client) {
      // Fire-and-forget: a quitting engine can never echo runCommand's sentinel.
      try {
        client.sendCommand("quit");
      } catch {
        /* not connected — fall through to the force-kill */
      }
    }
    let exited = false;
    if (pid !== undefined) {
      for (let waited = 0; waited < timeoutMs; waited += QUIT_POLL_MS) {
        if (!io.alive(pid)) {
          exited = true;
          break;
        }
        await io.sleep(QUIT_POLL_MS);
      }
    }
    if (exited) {
      // Gone of its own accord — just drop our handles. Deliberately no signal:
      // the OS may already have recycled that pid.
      this.children.delete(id);
      const done = this.clients.get(id);
      if (done) {
        done.close();
        this.clients.delete(id);
      }
    } else {
      this.kill(id); // ignored us, or was already hung — force it
    }
    return exited;
  }

  /** Graceful-quit every launched instance (in parallel), then drop the rest. */
  async quitAll(timeoutMs = 3000, io: QuitIo = defaultQuitIo): Promise<void> {
    await Promise.all([...this.children.keys()].map((id) => this.quit(id, timeoutMs, io)));
    this.closeAll();
  }

  /** Kill every launched child and detach every client. Called on MCP shutdown
   *  so games the server spawned don't outlive it as stray dock processes. */
  closeAll(): void {
    for (const child of this.children.values()) child.kill();
    this.children.clear();
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
