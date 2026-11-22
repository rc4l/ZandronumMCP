import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { FakeBridge } from "./fakes/fake-bridge.js";
import {
  InstanceRegistry,
  defaultLaunchIo,
  defaultQuitIo,
  type LaunchConfig,
  type LaunchIo,
} from "../src/process/registry.js";
import { EngineExitedError, LaunchSetupError, type ChildExit } from "../src/process/registry.js";

/** launch_instance's sequence: spawn, then attach (reaping the child on failure). */
function launch(registry: InstanceRegistry, config: LaunchConfig, io: LaunchIo) {
  registry.spawn(config, io);
  return registry.attachOrKill(config, io);
}
import { configPathFor, isolatedConfigPathFor } from "../src/process/launch.js";
import { envName } from "../src/adapter.js";
import { engine } from "../src/engine.js";

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
    registry = new InstanceRegistry(engine);

    const client = await registry.attach({ id: 1, port: bridge.port });
    expect(registry.has(1)).toBe(true);
    expect(registry.get(1)).toBe(client);
    expect(await client.runCommand("version")).toEqual(["Zandronum 3.2.1"]);
  });

  it("throws for an unknown id", () => {
    registry = new InstanceRegistry(engine);
    expect(() => registry!.get(99)).toThrow(/No attached instance/);
  });

  it("closeAll clears the registry", async () => {
    bridge = await FakeBridge.start();
    registry = new InstanceRegistry(engine);
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
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    registry.closeAll();
    expect(killed).toBe(true);
    expect(registry.has(1)).toBe(false);
  });

  it("launch spawns with the right args/env, clears quarantine, waits, and attaches", async () => {
    bridge = await FakeBridge.start();
    const spawned: Array<{ exe: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const dequarantined: string[] = [];
    const configDirs: string[] = [];
    const io: LaunchIo = {
      spawn: (exe, args, _cwd, env) => {
        spawned.push({ exe, args, env });
        return { pid: 123, kill: () => {} };
      },
      waitForPort: async () => {},
      clearQuarantine: (exe) => void dequarantined.push(exe),
      ensureDir: (dir) => void configDirs.push(dir),
      seedConfig: () => {
        throw new Error("a shared-config launch must not seed");
      },
    };
    registry = new InstanceRegistry(engine);
    const client = await launch(registry,
      { id: 1, exe: "zandronum.exe", cwd: ".", port: bridge.port, iwad: "freedoom2.wad", logFile: "C:/tmp/inst1.log" },
      io,
    );
    expect(spawned[0].exe).toBe("zandronum.exe");
    // A dedicated -config, separate from the user's real zandronum.ini.
    expect(spawned[0].args).toEqual([
      "-config",
      configPathFor(engine, "zandronum.exe"),
      "-iwad",
      "freedoom2.wad",
      "+set",
      engine.fullscreenCvar,
      "0",
      ...engine.launchPins({}, process.env),
    ]);
    expect(spawned[0].env[envName(engine, "BRIDGE_PORT")]).toBe(String(bridge.port));
    expect(spawned[0].env[envName(engine, "BRIDGE_LOG")]).toBe("C:/tmp/inst1.log");
    expect(dequarantined).toEqual(["zandronum.exe"]);
    // The config's folder, then the gamelog's: the engine creates neither.
    const gamelog = String(spawned[0].env[envName(engine, "BRIDGE_GAMELOG")]);
    expect(configDirs).toEqual([dirname(configPathFor(engine, "zandronum.exe")), dirname(resolve(".", gamelog))]);
    expect(registry.has(1)).toBe(true);
    expect(registry.get(1)).toBe(client);
  });

  it("an isolated launch seeds its per-port copy first, then runs on it", async () => {
    bridge = await FakeBridge.start();
    const calls: string[] = [];
    let args: string[] = [];
    const io: LaunchIo = {
      spawn: (_exe, a) => {
        args = a;
        return { kill: () => {} };
      },
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: (dir) => void calls.push(`dir ${dir}`),
      seedConfig: (from, to) => void calls.push(`seed ${from} -> ${to}`),
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "/w/z", cwd: "/w", port: bridge.port, isolateConfig: true }, io);
    const shared = configPathFor(engine, "/w/z");
    const own = isolatedConfigPathFor(engine, shared, bridge.port);
    // Then the gamelog's folder, checked in the launch test.
    expect(calls.slice(0, 2)).toEqual([`dir ${dirname(shared)}`, `seed ${shared} -> ${own}`]);
    expect(args.slice(0, 2)).toEqual(["-config", own]);
  });

  it("fails a launch whose folders can't be made before spawning, naming the env var that moves them", () => {
    const spawned: string[][] = [];
    const io = (bad: (dir: string) => boolean, err: unknown = new Error("EACCES")): LaunchIo => ({
      spawn: (_exe, a) => (spawned.push(a), { kill: () => {} }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: (dir) => {
        if (bad(dir)) throw err;
      },
      seedConfig: () => {},
    });
    registry = new InstanceRegistry(engine);
    // cwd off the exe's folder: UZDoom's gamelog lands in cwd, which would share the config folder.
    const shared = dirname(configPathFor(engine, "/w/z"));
    const cfg = `can't create the config folder (${envName(engine, "CONFIG")} moves it): EACCES`;
    expect(() => registry!.spawn({ id: 1, exe: "/w/z", cwd: "/run", port: 1 }, io((d) => d === shared))).toThrow(new LaunchSetupError(cfg));
    // A caller's own -config never touches the default folder.
    registry.spawn({ id: 1, exe: "/w/z", cwd: "/run", port: 1, extraArgs: ["-config", "/t/my.ini"] }, io((d) => d === shared));
    expect(spawned).toHaveLength(1);
    // A non-Error throw still reads as text.
    expect(() => registry!.spawn({ id: 2, exe: "/w/z", cwd: "/run", port: 2 }, io((d) => d !== shared, "EROFS"))).toThrow(
      /^can't create the gamelog folder \(\w+_BRIDGE_GAMELOG moves it\): EROFS$/,
    );
  });

  it("accepts the attach when the engine's hello pid matches the spawned child", async () => {
    bridge = await FakeBridge.start({
      hello: { v: 1, t: "hello", engine: "fake", pid: 123, caps: ["cmd"] },
    });
    const io: LaunchIo = {
      spawn: () => ({ pid: 123, kill: () => {} }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    expect(registry.has(1)).toBe(true);
  });

  it("rejects (and kills) when the bridge pid is a stranger squatting the port", async () => {
    bridge = await FakeBridge.start({
      hello: { v: 1, t: "hello", engine: "fake", pid: 999, caps: ["cmd"] },
    });
    let killed = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 123, kill: () => (killed = true) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await expect(
      launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io),
    ).rejects.toThrow(/stale instance is squatting/);
    expect(killed).toBe(true);
    expect(registry.has(1)).toBe(false);
  });

  it("stays backward-compatible: an older bridge with no pid still attaches", async () => {
    bridge = await FakeBridge.start(); // default hello has no pid
    const io: LaunchIo = {
      spawn: () => ({ pid: 123, kill: () => {} }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    expect(registry.has(1)).toBe(true);
  });

  it("kill stops the process and detaches", async () => {
    bridge = await FakeBridge.start();
    let killed = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 1, kill: () => (killed = true) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    registry.kill(1);
    expect(killed).toBe(true);
    expect(registry.has(1)).toBe(false);
  });

  it("kill on an unknown id is a no-op", () => {
    registry = new InstanceRegistry(engine);
    expect(() => registry!.kill(99)).not.toThrow();
  });

  it("quit asks the engine to shut itself down and doesn't force-kill when it obeys", async () => {
    bridge = await FakeBridge.start();
    let forced = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 4242, kill: () => (forced = true) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);

    // Engine exits on its own after the first poll.
    let polls = 0;
    const clean = await registry.quit(1, 5000, {
      alive: () => ++polls < 2,
      sleep: async () => {},
    });
    expect(clean).toBe("clean");
    // The send is fire-and-forget, so let the socket actually deliver it.
    const sawQuit = async () => {
      for (let i = 0; i < 100; i++) {
        if (bridge!.received.some((m) => m.t === "cmd" && m.text === "quit")) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    };
    expect(await sawQuit()).toBe(true);
    expect(forced).toBe(false); // it went quietly — no SIGKILL needed
    expect(registry.has(1)).toBe(false);
  });

  it("quit force-kills an engine that ignores the request", async () => {
    bridge = await FakeBridge.start();
    let forced = false;
    const io: LaunchIo = {
      spawn: () => ({ pid: 4242, kill: () => (forced = true) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);

    const clean = await registry.quit(1, 450, { alive: () => true, sleep: async () => {} });
    expect(clean).toBe("forced");
    expect(forced).toBe(true); // never leaves it running
    expect(registry.has(1)).toBe(false);
  });

  it("quit on an unknown id is a harmless no-op that reports nothing there", async () => {
    registry = new InstanceRegistry(engine);
    await expect(
      registry.quit(99, 100, { alive: () => false, sleep: async () => {} }),
    ).resolves.toBe("absent");
  });

  it("quit still force-kills when the engine can't be reached to ask", async () => {
    bridge = await FakeBridge.start();
    registry = new InstanceRegistry(engine);
    const client = await registry.attach({ id: 1, port: bridge.port });
    // Simulate a dead/disconnected bridge: asking it to quit throws.
    (client as unknown as { sendCommand: () => void }).sendCommand = () => {
      throw new Error("Not connected");
    };
    const clean = await registry.quit(1, 100, { alive: () => true, sleep: async () => {} });
    expect(clean).toBe("forced");
    expect(registry.has(1)).toBe(false); // still cleaned up
  });

  describe("an engine that exits during startup", () => {
    /** A LaunchIo whose port never opens until `openPort`, recording what spawn and the poll were handed. */
    function exitingIo(exited: Promise<ChildExit> | undefined) {
      const seen: { stderrPath?: string; signal?: AbortSignal; killed: boolean } = { killed: false };
      let openPort = () => {};
      const io: LaunchIo = {
        spawn: (_exe, _args, _cwd, _env, stderrPath) => {
          seen.stderrPath = stderrPath;
          return { pid: 5, kill: () => (seen.killed = true), exited };
        },
        waitForPort: (_host, _port, signal) => {
          seen.signal = signal;
          return new Promise<void>((r) => (openPort = r));
        },
        clearQuarantine: () => {},
        ensureDir: () => {},
        seedConfig: () => {},
      };
      return { io, seen, openPort: () => openPort() };
    }

    it("fails fast with the exit code, reaps the child and stops the poll", async () => {
      registry = new InstanceRegistry(engine);
      const { io, seen } = exitingIo(Promise.resolve({ code: 255, signal: null }));
      const err = await launch(registry, { id: 1, exe: "z", cwd: "/w", port: 1, logFile: "/w/mcp-bridge-1.log" }, io).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(EngineExitedError);
      expect((err as EngineExitedError).message).toBe("engine exited during startup (exit code 255)");
      expect((err as EngineExitedError).exit).toEqual({ code: 255, signal: null });
      expect(seen.stderrPath).toBe("/w/mcp-bridge-1.log.stderr");
      expect(seen.signal?.aborted).toBe(true);
      expect(seen.killed).toBe(true);
      expect(registry.has(1)).toBe(false);
    });

    it("names a fatal signal and a spawn failure", async () => {
      registry = new InstanceRegistry(engine);
      const launchExit = (exit: ChildExit) =>
        launch(registry!, { id: 1, exe: "z", cwd: ".", port: 1 }, exitingIo(Promise.resolve(exit)).io);
      await expect(launchExit({ code: null, signal: "SIGSEGV" })).rejects.toThrow(
        "engine exited during startup (signal SIGSEGV)",
      );
      await expect(launchExit({ code: null, signal: null, error: "spawn z ENOENT" })).rejects.toThrow(
        "engine exited during startup (could not start: spawn z ENOENT)",
      );
    });

    it("hands spawn no stderr path without a logFile", async () => {
      bridge = await FakeBridge.start();
      registry = new InstanceRegistry(engine);
      const { io, seen, openPort } = exitingIo(undefined);
      const launched = launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
      openPort();
      await launched;
      expect(seen.stderrPath).toBeUndefined();
    });

    it("a clean exit (a wrapper that backgrounds the engine) keeps waiting for the port", async () => {
      bridge = await FakeBridge.start();
      registry = new InstanceRegistry(engine);
      const { io, openPort } = exitingIo(Promise.resolve({ code: 0, signal: null }));
      const launched = launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
      await new Promise((r) => setTimeout(r, 20));
      openPort();
      await launched;
      expect(registry.has(1)).toBe(true);
    });

    it("an engine dying after the port opened is no unhandled rejection", async () => {
      bridge = await FakeBridge.start();
      registry = new InstanceRegistry(engine);
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => void unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);
      try {
        let die = (_e: ChildExit) => {};
        const { io, openPort } = exitingIo(new Promise<ChildExit>((r) => (die = r)));
        const launched = launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
        openPort();
        await launched;
        die({ code: 1, signal: null });
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
      expect(unhandled).toEqual([]);
      expect(registry.has(1)).toBe(true);
    });
  });

  it("attachOrKill reaps the child on a failed attach; childPid names the child only until then", async () => {
    let killed = 0;
    const io: LaunchIo = {
      spawn: () => ({ pid: 123, kill: () => void killed++ }),
      waitForPort: () => Promise.reject(new Error("never opened")),
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    expect(registry.childPid(1)).toBeUndefined();
    registry.spawn({ id: 1, exe: "z", cwd: ".", port: 1 }, io);
    expect(registry.childPid(1)).toBe(123);
    await expect(registry.attachOrKill({ id: 1, port: 1 }, io)).rejects.toThrow("never opened");
    expect(killed).toBe(1);
    expect(registry.childPid(1)).toBeUndefined();
  });

  it("quitAll graceful-quits every launched instance", async () => {
    bridge = await FakeBridge.start();
    const killed: number[] = [];
    const io: LaunchIo = {
      spawn: () => ({ pid: 1, kill: () => killed.push(1) }),
      waitForPort: async () => {},
      clearQuarantine: () => {},
      ensureDir: () => {},
      seedConfig: () => {},
    };
    registry = new InstanceRegistry(engine);
    await launch(registry, { id: 1, exe: "z", cwd: ".", port: bridge.port }, io);
    await registry.quitAll(300, { alive: () => false, sleep: async () => {} });
    expect(registry.has(1)).toBe(false);
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

  it("creates a missing config directory, and tolerates one that already exists", () => {
    const dir = join(tmpdir(), `zandronum-mcp-test-${process.pid}-${Date.now()}`);
    expect(existsSync(dir)).toBe(false);
    defaultLaunchIo.ensureDir(dir);
    expect(existsSync(dir)).toBe(true);
    expect(() => defaultLaunchIo.ensureDir(dir)).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  it("seedConfig copies the shared ini over a stale copy, and removes the copy when there's none", () => {
    const dir = mkdtempSync(join(tmpdir(), "zandronum-mcp-seed-"));
    const shared = join(dir, "shared.ini");
    const own = join(dir, "own.ini");
    try {
      writeFileSync(own, "stale");
      writeFileSync(shared, "[GlobalSettings]\nalias=1\n");
      defaultLaunchIo.seedConfig(shared, own);
      expect(readFileSync(own, "utf8")).toBe("[GlobalSettings]\nalias=1\n");
      rmSync(shared);
      defaultLaunchIo.seedConfig(shared, own);
      expect(existsSync(own)).toBe(false);
      expect(() => defaultLaunchIo.seedConfig(shared, own)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("swallows a child 'error' event (bad exe) instead of crashing the server", async () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // Capture stderr so we can assert the error was logged, not thrown. An
    // unhandled ChildProcess 'error' would otherwise be an uncaught exception.
    process.stderr.write = ((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const child = defaultLaunchIo.spawn(
        "/nonexistent/zandronum-mcp-does-not-exist",
        [],
        process.cwd(),
        process.env,
      );
      // The ENOENT 'error' fires asynchronously; poll until it's been swallowed.
      for (let i = 0; i < 100 && writes.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      child.kill(); // no-op on a process that never spawned; must not throw
      const exit = await child.exited;
      expect(exit).toMatchObject({ code: null, signal: null });
      expect(exit?.error).toMatch(/ENOENT/);
    } finally {
      process.stderr.write = orig;
    }
    expect(writes.join("")).toMatch(/engine process .* error:/);
  });

  it("writes the child's stderr to the given file and reports its exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zandronum-mcp-stderr-"));
    const file = join(dir, "mcp-bridge-1.log.stderr");
    try {
      const child = defaultLaunchIo.spawn(
        process.execPath,
        ["-e", "process.stdout.write('chatter');process.stderr.write('boom');process.exit(3)"],
        process.cwd(),
        process.env,
        file,
      );
      expect(await child.exited).toEqual({ code: 3, signal: null });
      expect(readFileSync(file, "utf8")).toBe("boom");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still spawns, uncaptured, when the stderr file can't be opened", async () => {
    const file = join(tmpdir(), `zandronum-mcp-missing-${process.pid}-${Date.now()}`, "x.stderr");
    const child = defaultLaunchIo.spawn(process.execPath, ["-e", "process.exit(3)"], process.cwd(), process.env, file);
    expect(await child.exited).toEqual({ code: 3, signal: null });
    expect(existsSync(file)).toBe(false);
  });
});

describe("defaultQuitIo (real process glue)", () => {
  it("alive() reports live and dead pids", () => {
    expect(defaultQuitIo.alive(process.pid)).toBe(true);
    expect(defaultQuitIo.alive(2 ** 30)).toBe(false);
  });

  it("sleep resolves", async () => {
    await expect(defaultQuitIo.sleep(1)).resolves.toBeUndefined();
  });
});
