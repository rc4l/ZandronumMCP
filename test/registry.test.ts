import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { InstanceRegistry, defaultLaunchIo, type LaunchIo } from "../src/process/registry.js";

let bridge: FakeBridge | undefined;
let registry: InstanceRegistry | undefined;

afterEach(async () => {
  registry?.closeAll();
  registry = undefined;
  await bridge?.close();
  bridge = undefined;
});

describe("InstanceRegistry", () => {
  it("attaches, exposes, and routes commands by id", async () => {
    bridge = await FakeBridge.start();
    bridge.respondTo("version", ["Zandronum 3.2.1"]);
    registry = new InstanceRegistry();

    const client = await registry.attach({ id: 1, port: bridge.port });
    expect(registry.has(1)).toBe(true);
    expect(registry.get(1)).toBe(client);
    expect(await client.runCommand("version")).toEqual(["Zandronum 3.2.1"]);
  });

  it("throws for an unknown id", () => {
    registry = new InstanceRegistry();
    expect(() => registry!.get(99)).toThrow(/No attached instance/);
  });

  it("closeAll clears the registry", async () => {
    bridge = await FakeBridge.start();
    registry = new InstanceRegistry();
    await registry.attach({ id: 1, port: bridge.port });
    registry.closeAll();
    expect(registry.has(1)).toBe(false);
  });

  it("closeAll kills launched children too (no stray processes)", async () => {
    bridge = await FakeBridge.start();
    let killed = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 7, kill: () => (killed = true) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
    };
    registry = new InstanceRegistry();
    await registry.launch({ id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    registry.closeAll();
    expect(killed).toBe(true);
    expect(registry.has(1)).toBe(false);
  });

  it("launch spawns with the right args/env, clears quarantine, waits, and attaches", async () => {
    bridge = await FakeBridge.start();
    const spawned: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const dequarantined: string[] = [];
    const io: LaunchIo = {
      spawn: (exe, args, _cwd, env) => {
        spawned.push({ exe, args, env });
        return { pid: 123, kill: () => {} };
      },
      waitForPort: async () => {},
      clearQuarantine: (exe) => void dequarantined.push(exe),
    };
    registry = new InstanceRegistry();
    const client = await registry.launch(
      { id: 1, exe: "zandronum.exe", cwd: ".", port: bridge.port, iwad: "freedoom2.wad", logFile: "C:/tmp/inst1.log" },
      io,
    );
    expect(spawned[0].exe).toBe("zandronum.exe");
    expect(spawned[0].args).toEqual(["-iwad", "freedoom2.wad", "+set", "fullscreen", "0"]);
    expect(spawned[0].env.ZANDRONUM_BRIDGE_PORT).toBe(String(bridge.port));
    expect(spawned[0].env.ZANDRONUM_BRIDGE_LOG).toBe("C:/tmp/inst1.log");
    expect(dequarantined).toEqual(["zandronum.exe"]);
    expect(registry.has(1)).toBe(true);
    expect(registry.get(1)).toBe(client);
  });

  it("kill stops the process and detaches", async () => {
    bridge = await FakeBridge.start();
    let killed = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 1, kill: () => (killed = true) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
    };
    registry = new InstanceRegistry();
    await registry.launch({ id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    registry.kill(1);
    expect(killed).toBe(true);
    expect(registry.has(1)).toBe(false);
  });

  it("kill on an unknown id is a no-op", () => {
    registry = new InstanceRegistry();
    expect(() => registry!.kill(99)).not.toThrow();
  });
});

describe("defaultLaunchIo", () => {
  it("spawns a real process and detects its port", async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", function (this: net.Server) {
        const p = (this.address() as net.AddressInfo).port;
        this.close(() => resolve(p));
      });
      void probe;
    });
    const child = defaultLaunchIo.spawn(
      process.execPath,
      ["-e", `require('net').createServer().listen(${port},'127.0.0.1')`],
      process.cwd(),
      process.env,
    );
    try {
      await defaultLaunchIo.waitForPort("127.0.0.1", port);
      expect(typeof child.pid).toBe("number");
      // No-op off macOS; on macOS it best-effort clears quarantine. Either way
      // it must never throw for a path that isn't quarantined.
      expect(() => defaultLaunchIo.clearQuarantine(process.execPath)).not.toThrow();
    } finally {
      child.kill();
    }
  });
});
