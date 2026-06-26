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

  it("launch spawns with the right args/env, waits, and attaches", async () => {
    bridge = await FakeBridge.start();
    const spawned: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const io: LaunchIo = {
      spawn: (exe, args, _cwd, env) => {
        spawned.push({ exe, args, env });
        return { pid: 123, kill: () => {} };
      },
      waitForPort: async () => {},
    };
    registry = new InstanceRegistry();
    const client = await registry.launch(
      { id: 1, exe: "zandronum.exe", cwd: ".", port: bridge.port, iwad: "freedoom2.wad" },
      io,
    );
    expect(spawned[0].exe).toBe("zandronum.exe");
    expect(spawned[0].args).toEqual(["-iwad", "freedoom2.wad"]);
    expect(spawned[0].env.ZANDRONUM_BRIDGE_PORT).toBe(String(bridge.port));
    expect(registry.has(1)).toBe(true);
    expect(registry.get(1)).toBe(client);
  });

  it("kill stops the process and detaches", async () => {
    bridge = await FakeBridge.start();
    let killed = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 1, kill: () => (killed = true) }),
      waitForPort: async () => {},
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
    } finally {
      child.kill();
    }
  });
});
