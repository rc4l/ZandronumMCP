import { spawn as nodeSpawn } from "node:child_process";
import { BridgeClient } from "../bridge/transport.js";
import { buildLaunchArgs, buildLaunchEnv, waitForPort, type LaunchOptions } from "./launch.js";

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
}

export const defaultLaunchIo: LaunchIo = {
  spawn: (exe, args, cwd, env) => {
    const cp = nodeSpawn(exe, args, { cwd, env, detached: true, stdio: "ignore" });
    cp.unref();
    return { pid: cp.pid, kill: () => void cp.kill() };
  },
  waitForPort: (host, port) => waitForPort(host, port),
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

  /** Spawn a bridge-enabled instance, wait for its port, then attach. */
  async launch(config: LaunchConfig, io: LaunchIo): Promise<BridgeClient> {
    const host = config.host ?? "127.0.0.1";
    const args = buildLaunchArgs(config);
    const env = buildLaunchEnv(config.exe, config.port);
    if (config.logFile) env.ZANDRONUM_BRIDGE_LOG = config.logFile;
    const child = io.spawn(config.exe, args, config.cwd, env);
    this.children.set(config.id, child);
    await io.waitForPort(host, config.port);
    return this.attach({ id: config.id, host, port: config.port });
  }

  get(id: number): BridgeClient {
    const client = this.clients.get(id);
    if (!client) throw new Error(`No attached instance with id ${id}`);
    return client;
  }

  has(id: number): boolean {
    return this.clients.has(id);
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

  closeAll(): void {
    for (const client of this.clients.values()) client.close();
    this.clients.clear();
  }
}
