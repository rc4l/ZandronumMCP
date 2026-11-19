import { describe, it, expect, afterEach, vi } from "vitest";
import path from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ServerContext, configFromEnv, defaultContextIo, type ServerConfig } from "../src/context.js";
import { InstanceRegistry, type ChildExit, type LaunchIo } from "../src/process/registry.js";
import { envName } from "../src/adapter.js";
import { engine } from "../src/engine.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { stubIo } from "./fakes/tool-harness.js";
import { buildWad, sectorsLump, doomLinedefsLump, sidedefsLump, vertexesLump } from "./fakes/wad-builder.js";
import { buildBehaviorAcse } from "./fakes/acs-builder.js";

const baseConfig: ServerConfig = { host: "127.0.0.1", basePort: 7777, screenshotDir: "/shots" };

function makeCtx(config: Partial<ServerConfig> = {}, io = {}, registry = new InstanceRegistry(engine)) {
  return new ServerContext(engine, { ...baseConfig, ...config }, stubIo(io), registry);
}

const WAD = buildWad("PWAD", [
  { name: "MAP01" },
  { name: "THINGS" },
  { name: "LINEDEFS", data: doomLinedefsLump([{ v1: 0, v2: 1, flags: 1, special: 0, tag: 3, front: 0, back: 0xffff }]) },
  { name: "SIDEDEFS", data: sidedefsLump([{ xoff: 0, yoff: 0, upper: "-", lower: "-", middle: "BRICK1", sector: 0 }]) },
  { name: "VERTEXES", data: vertexesLump([{ x: 0, y: 0 }, { x: 64, y: 0 }]) },
  { name: "SECTORS", data: sectorsLump([{ floor: 0, ceil: 128, floorTex: "FLAT1", ceilTex: "F_SKY1", light: 160, special: 0, tag: 3 }]) },
]);

let bridge: FakeBridge | undefined;
afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
});

describe("ServerContext ports and log paths", () => {
  it("reads an instance's crash report with its mtime, or nothing when it has no path or no file", () => {
    expect(makeCtx().readCrash(1)).toBeUndefined();
    const written = new Date("2026-09-22T06:10:00Z");
    const io = {
      existsSync: (p: string) => p === "/a.log.crash",
      readTextSync: () => "pid: 7\n",
      mtimeOf: () => written,
    };
    const ctx = makeCtx({}, io);
    ctx.rememberLaunch(1, 7801, "/a.log");
    ctx.rememberLaunch(2, 7802, "/gone.log");
    expect(ctx.readCrash(1)).toEqual({ file: "/a.log.crash", report: "pid: 7\n", written });
    expect(ctx.readCrash(2)).toBeUndefined();
  });

  it("maps instance 1 to the base port and N to base+N-1", () => {
    const ctx = makeCtx();
    expect(ctx.portFor(1)).toBe(7777);
    expect(ctx.portFor(3)).toBe(7779);
    expect(ctx.effectivePort(3)).toBe(7779);
  });

  it("prefers the port a launch actually picked, until the instance is forgotten", () => {
    const ctx = makeCtx();
    ctx.rememberLaunch(1, 7801, "/engine/mcp-bridge-7801.log");
    expect(ctx.effectivePort(1)).toBe(7801);
    expect(ctx.logPathFor(1)).toBe("/engine/mcp-bridge-7801.log");

    ctx.forgetInstance(1);
    expect(ctx.effectivePort(1)).toBe(7777);
  });

  it("forgetAll drops every remembered launch", () => {
    const ctx = makeCtx();
    ctx.rememberLaunch(1, 7801, "/a.log");
    ctx.rememberLaunch(2, 7802, "/b.log");
    ctx.forgetAll();
    expect(ctx.effectivePort(1)).toBe(7777);
    expect(ctx.effectivePort(2)).toBe(7778);
  });

  it("derives a log path next to the engine when the instance was never launched", () => {
    const ctx = makeCtx({ exe: path.join("/engine", "zandronum") });
    expect(ctx.logPathFor(2)).toBe(path.join("/engine", "mcp-bridge-7778.log"));
  });

  it("has no log path at all without an engine configured", () => {
    expect(makeCtx().logPathFor(1)).toBeUndefined();
  });

  it("reads an instance's log, or nothing when it has no path or no file", () => {
    expect(makeCtx().readLog(1)).toBeUndefined();
    const io = { existsSync: (p: string) => p === "/a.log", readTextSync: () => "line\n" };
    const ctx = makeCtx({}, io);
    ctx.rememberLaunch(1, 7801, "/a.log");
    ctx.rememberLaunch(2, 7802, "/gone.log");
    expect(ctx.readLog(1)).toBe("line\n");
    expect(ctx.readLog(2)).toBeUndefined();
  });
});

describe("ServerContext launch args (relaunch_instance)", () => {
  it("keeps the last launch past forgetInstance and forgetAll", () => {
    const ctx = makeCtx();
    ctx.rememberLaunchArgs(1, { iwad: "/w/DOOM2.WAD", map: "MAP01" }, 7801, "/a.log");
    ctx.rememberLaunchArgs(2, { files: ["/m.pk3"] }, 7802, "/b.log");
    ctx.forgetInstance(1);
    ctx.forgetAll();
    expect(ctx.launchArgsFor(1)).toEqual({ args: { iwad: "/w/DOOM2.WAD", map: "MAP01" }, port: 7801, logFile: "/a.log" });
    expect(ctx.launchArgsFor(2)?.args.files).toEqual(["/m.pk3"]);
  });

  it("fills in the engine PID once the bridge reports it, and only for a launched instance", () => {
    const ctx = makeCtx();
    ctx.rememberLaunchArgs(1, {}, 7801, "/a.log");
    ctx.rememberEngine(1, undefined);
    expect(ctx.launchArgsFor(1)?.enginePid).toBeUndefined();
    ctx.rememberEngine(1, 42);
    expect(ctx.launchArgsFor(1)?.enginePid).toBe(42);
    ctx.rememberEngine(2, 43);
    expect(ctx.launchArgsFor(2)).toBeUndefined();
    expect(ctx.enginePidFor(2)).toBe(43);
  });

  it("starts each launch's entry fresh and forgets it on request", () => {
    const ctx = makeCtx();
    ctx.rememberLaunchArgs(1, { map: "MAP01" }, 7801, "/a.log");
    ctx.rememberEngine(1, 42);
    ctx.rememberLaunchArgs(1, { map: "MAP02" }, 7802, "/b.log");
    expect(ctx.launchArgsFor(1)).toEqual({ args: { map: "MAP02" }, port: 7802, logFile: "/b.log" });
    ctx.forgetLaunchArgs(1);
    expect(ctx.launchArgsFor(1)).toBeUndefined();
  });
});

describe("ServerContext.clientFor", () => {
  it("attaches once and reuses the connection", async () => {
    bridge = await FakeBridge.start();
    const ctx = makeCtx({ basePort: bridge.port });
    ctx.bind(1, bridge.port);
    const first = await ctx.clientFor(1);
    const second = await ctx.clientFor(1);
    expect(second).toBe(first);
    ctx.registry.closeAll();
  });

  it("shares one attach between concurrent callers instead of leaking sockets", async () => {
    bridge = await FakeBridge.start();
    const ctx = makeCtx({ basePort: bridge.port });
    ctx.bind(1, bridge.port);
    // Parallel tool calls: without in-flight de-duplication each would open its
    // own socket and all but the last would be orphaned in the registry.
    const [a, b, c] = await Promise.all([ctx.clientFor(1), ctx.clientFor(1), ctx.clientFor(1)]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    ctx.registry.closeAll();
  });

  it("refuses a re-attach that landed on a different process", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 4321 } });
    const ctx = makeCtx({ basePort: bridge.port });
    // The instance was launched as PID 1234; the bridge now answering its port
    // belongs to something else, so driving it would drive the wrong game.
    ctx.bind(1, bridge.port);
    ctx.rememberEngine(1, 1234);
    await expect(ctx.clientFor(1)).rejects.toThrow(/is PID 4321, not the engine launched/);
    // The mismatched connection is dropped, never killed — it isn't ours.
    expect(ctx.registry.has(1)).toBe(false);
  });

  it("accepts a re-attach to the same process", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 1234 } });
    const ctx = makeCtx({ basePort: bridge.port });
    ctx.bind(1, bridge.port);
    ctx.rememberEngine(1, 1234);
    await expect(ctx.clientFor(1)).resolves.toBeDefined();
    ctx.registry.closeAll();
  });

  it("skips the identity check when either side has no PID to compare", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake" } });
    const ctx = makeCtx({ basePort: bridge.port });
    ctx.bind(1, bridge.port);
    ctx.rememberEngine(1, 1234); // older bridge reports no pid — stay compatible
    await expect(ctx.clientFor(1)).resolves.toBeDefined();
    ctx.registry.closeAll();

    const other = makeCtx({ basePort: bridge.port });
    other.bind(1, bridge.port);
    other.rememberEngine(1, undefined); // nothing to remember, nothing to enforce
    await expect(other.clientFor(1)).resolves.toBeDefined();
    other.registry.closeAll();
  });

  it("forgets a remembered engine along with the rest of the instance", async () => {
    bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 4321 } });
    const ctx = makeCtx({ basePort: bridge.port });
    ctx.bind(1, bridge.port);
    ctx.rememberEngine(1, 1234);
    ctx.forgetInstance(1);
    ctx.bind(1, bridge.port); // forget drops the binding too; re-claim to retry
    await expect(ctx.clientFor(1)).resolves.toBeDefined();
    ctx.registry.closeAll();

    const other = makeCtx({ basePort: bridge.port });
    other.bind(1, bridge.port);
    other.rememberEngine(1, 1234);
    other.forgetAll();
    other.bind(1, bridge.port);
    await expect(other.clientFor(1)).resolves.toBeDefined();
    other.registry.closeAll();
  });

  describe("a pending (wait: false) launch", () => {
    // A PID that is not (and cannot be) running, so a graceful quit sees the engine gone at once.
    const DEAD_PID = 0x7ffffff0;

    /** A context whose instance 1 was spawned on `port` without waiting, as launchWith does. */
    function pendingCtx(
      port: number,
      opts: { pid?: number; wait?: () => Promise<void>; exited?: Promise<ChildExit>; portOpen?: boolean } = {},
    ) {
      const seen = { waits: 0, killed: 0 };
      const launchIo: LaunchIo = {
        spawn: () => ({ pid: "pid" in opts ? opts.pid : 123, kill: () => void seen.killed++, exited: opts.exited }),
        waitForPort: () => {
          seen.waits++;
          return opts.wait ? opts.wait() : Promise.resolve();
        },
        clearQuarantine: () => {},
        ensureDir: () => {},
        seedConfig: () => {},
      };
      const ctx = makeCtx({ basePort: port }, { launchIo, portOpen: () => Promise.resolve(opts.portOpen === true) });
      const child = ctx.registry.spawn({ id: 1, exe: "z", cwd: ".", port }, launchIo);
      ctx.rememberLaunch(1, port, "/engine/mcp-bridge.log");
      ctx.rememberEngine(1, child.pid);
      return { ctx, seen };
    }

    it("attaches on first use, with concurrent callers sharing one attach", async () => {
      bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 123 } });
      const { ctx, seen } = pendingCtx(bridge.port);
      const [a, b] = await Promise.all([ctx.clientFor(1), ctx.clientFor(1)]);
      expect(b).toBe(a);
      expect(seen.waits).toBe(1);
      expect(ctx.registry.pending(1)).toBe(false);
      ctx.registry.closeAll();
    });

    it("refuses a bridge that isn't the spawned child, leaving the child pending", async () => {
      bridge = await FakeBridge.start({ hello: { v: 1, t: "hello", engine: "fake", pid: 999 } });
      const { ctx, seen } = pendingCtx(bridge.port);
      await expect(ctx.clientFor(1)).rejects.toThrow(/is PID 999, not the engine we launched \(PID 123\)/);
      expect(seen.killed).toBe(0);
      expect(ctx.registry.pending(1)).toBe(true);
      ctx.registry.closeAll();
    });

    // A host whose lobby is closed exits 0, so a clean exit counts as gone too.
    it.each([255, 0])("points at get_startup_errors at once when the engine already exited (code %i)", async (code) => {
      const { ctx } = pendingCtx(1, { wait: () => new Promise<void>(() => {}), exited: Promise.resolve({ code, signal: null }) });
      await expect(ctx.clientFor(1)).rejects.toThrow(
        `Instance 1's engine exited during startup (exit code ${code}); get_startup_errors shows why.`,
      );
      ctx.registry.closeAll();
    });

    it("says the bridge isn't up yet when the port wait gives up, and keeps the engine", async () => {
      const { ctx, seen } = pendingCtx(1, { wait: () => Promise.reject(new Error("bridge port 127.0.0.1:1 never opened")) });
      await expect(ctx.clientFor(1)).rejects.toThrow(/no bridge on port 1 yet: bridge port 127\.0\.0\.1:1 never opened\..*kill_instance stops it/);
      expect(seen.killed).toBe(0);
      expect(ctx.registry.pending(1)).toBe(true);
      ctx.registry.closeAll();
    });

    it("quit attaches first when the bridge is up, so the engine is asked to quit", async () => {
      bridge = await FakeBridge.start();
      const { ctx, seen } = pendingCtx(bridge.port, { pid: DEAD_PID, portOpen: true });
      expect(await ctx.quit(1)).toBe("clean");
      expect(seen.waits).toBe(1);
      // The quit is fire-and-forget, so let the socket deliver it.
      await vi.waitFor(() => expect(bridge!.received.some((m) => m.t === "cmd" && m.text === "quit")).toBe(true));
    });

    it("quit force-kills at once, without attaching or a quit wait, when the bridge isn't up", async () => {
      // A live pid: a graceful quit would sit out its full wait for an exit that never comes.
      const { ctx, seen } = pendingCtx(1, { pid: process.pid });
      expect(await ctx.quit(1)).toBe("unbridged");
      expect(seen.waits).toBe(0);
      expect(seen.killed).toBe(1);
    });

    it("quit still force-kills when the attach on the way fails", async () => {
      const { ctx, seen } = pendingCtx(1, { pid: undefined, portOpen: true, wait: () => Promise.reject(new Error("gone")) });
      expect(await ctx.quit(1)).toBe("unbridged");
      expect(seen.waits).toBe(1);
      expect(seen.killed).toBe(1);
    });
  });

  it("clears the in-flight attach when it fails, so a later call can retry", async () => {
    bridge = await FakeBridge.start();
    const deadPort = bridge.port;
    await bridge.close();
    bridge = undefined;

    const ctx = makeCtx({ basePort: deadPort });
    ctx.bind(1, deadPort);
    await expect(Promise.all([ctx.clientFor(1), ctx.clientFor(1)])).rejects.toThrow();
    // A second round must attempt a fresh attach rather than reuse the failure.
    await expect(ctx.clientFor(1)).rejects.toThrow();
  });
});

describe("ServerContext.loadMap", () => {
  it("requires a WAD from the argument or the environment", () => {
    expect(() => makeCtx().loadMap(undefined, "MAP01")).toThrow(`No WAD specified. Pass \`file\` or set ${envName(engine, "IWAD")}.`);
  });

  it("falls back to the configured IWAD", () => {
    const ctx = makeCtx({ iwad: "/game/doom2.wad" }, { readFileSync: () => WAD });
    expect(ctx.loadMap(undefined, "MAP01").sectors).toHaveLength(1);
  });

  it("parses a container once and serves later queries from cache", () => {
    let reads = 0;
    const ctx = makeCtx({}, { readFileSync: () => { reads++; return WAD; } });
    ctx.loadMap("/mods/x.wad", "MAP01");
    ctx.loadMap("/mods/x.wad", "map01"); // same map, different case
    expect(reads).toBe(1);
  });

  it("re-reads when the WAD changes on disk", () => {
    let reads = 0;
    let stamp = "1:100";
    const ctx = makeCtx(
      {},
      {
        readFileSync: () => { reads++; return WAD; },
        stampOf: () => stamp,
      },
    );
    ctx.loadMap("/mods/x.wad", "MAP01");
    expect(reads).toBe(1);
    // The agent edits the WAD — the cache must not keep serving stale geometry.
    stamp = "2:120";
    ctx.loadMap("/mods/x.wad", "MAP01");
    expect(reads).toBe(2);
  });
});

describe("ServerContext.deployedModules", () => {
  const lib = buildBehaviorAcse(["f"], []);

  it("caches a regular file's modules on its stamp", () => {
    let reads = 0;
    let stamp = "1:100";
    const ctx = makeCtx({}, { readFileSync: () => (reads++, lib), stampOf: () => stamp });
    expect(ctx.deployedModules("/mods/lib.o")).toEqual([{ name: "lib.o", data: lib }]);
    ctx.deployedModules("/mods/lib.o");
    expect(reads).toBe(1);
    stamp = "2:100";
    ctx.deployedModules("/mods/lib.o");
    expect(reads).toBe(2);
  });

  it("walks a directory on every call", () => {
    let reads = 0;
    const dir = path.join("/mods/res");
    const ctx = makeCtx({}, { isDirSync: (p: string) => p === dir, readdirSync: () => ["lib.o"], readFileSync: () => (reads++, lib), readHeadSync: () => lib.subarray(0, 4) });
    expect(ctx.deployedModules(dir)).toEqual([{ name: "lib.o", data: lib }]);
    ctx.deployedModules(dir);
    expect(reads).toBe(2);
  });

  it("walks a directory with the engine's skip policy for this platform", () => {
    const dir = path.join("/mods/res");
    const asked: string[] = [];
    const dirWalkSkips = (name: string, _isDir: boolean, platform: NodeJS.Platform) => (asked.push(platform), name === "old.o");
    const io = stubIo({ isDirSync: (p: string) => p === dir, readdirSync: () => ["old.o", "lib.o"], readFileSync: () => lib });
    const ctx = new ServerContext({ ...engine, dirWalkSkips }, baseConfig, io, new InstanceRegistry(engine));
    expect(ctx.deployedModules(dir)).toEqual([{ name: "lib.o", data: lib }]);
    expect(asked).toEqual([process.platform, process.platform]);
  });
});

describe("ServerContext.loadAcsIndex", () => {
  const dir = "/mods/acs";
  const sources: Record<string, string> = {
    "main.acs": "#define GOLD 7\nscript 1 OPEN { }\nfunction void Give(void) { }",
  };

  function acsIo(stamps: Record<string, string>) {
    return {
      readdirSync: () => [...Object.keys(sources), "notes.txt"],
      readTextSync: (p: string) => sources[path.basename(p)],
      stampOf: (p: string) => stamps[path.basename(p)],
    };
  }

  it("requires a source dir from the argument or the environment", () => {
    expect(() => makeCtx().loadAcsIndex(undefined)).toThrow(`No ACS source dir. Pass \`dir\` or set ${envName(engine, "ACS_SRC")}.`);
  });

  it("indexes only .acs files and caches the result", () => {
    let reads = 0;
    const ctx = makeCtx(
      { acsSrc: dir },
      { ...acsIo({ "main.acs": "1:10" }), readTextSync: (p: string) => { reads++; return sources[path.basename(p)]; } },
    );
    const idx = ctx.loadAcsIndex(undefined);
    expect(idx.symbols.some((s) => s.kind === "script")).toBe(true);
    ctx.loadAcsIndex(dir);
    expect(reads).toBe(1);
  });

  it("re-indexes when a source file's contents change", () => {
    let stamp = "1:10";
    let reads = 0;
    const ctx = makeCtx(
      {},
      {
        readdirSync: () => ["main.acs"],
        readTextSync: (p: string) => { reads++; return sources[path.basename(p)]; },
        stampOf: () => stamp,
      },
    );
    ctx.loadAcsIndex(dir);
    stamp = "2:11"; // same filenames, edited contents — dir mtime wouldn't move
    ctx.loadAcsIndex(dir);
    expect(reads).toBe(2);
  });
});

describe("ServerContext.runAcsProfiles", () => {
  const OS = path.resolve("/orc/mcp-run-acs.json");
  const OTHER = path.resolve("/other/p.json");
  const files: Record<string, string> = {
    [OS]: '{ "imports": ["osacs.acs"], "includeDirs": ["."] }',
    [OTHER]: '{ "imports": ["other.acs"] }',
  };
  function profileIo() {
    const reads: string[] = [];
    const readTextSync = (p: string) => {
      reads.push(p);
      if (files[p] === undefined) throw new Error(`ENOENT: no such file, open '${p}'`);
      return files[p];
    };
    return { reads, io: { readTextSync } };
  }
  const env = envName(engine, "RUNACS_PROFILES");

  it("re-reads every listed file on each call and returns the ones the snippet's imports select", () => {
    const { reads, io } = profileIo();
    const ctx = makeCtx({ runAcsProfiles: [OS, OTHER] }, io);
    const got = ctx.runAcsProfiles('#import "osacs.acs"\nscript 1 (void) {}');
    expect(got.map((p) => [p.file, p.includeDirs])).toEqual([[OS, [path.dirname(OS)]]]);
    ctx.runAcsProfiles('#import "zcommon.acs"');
    expect(reads).toEqual([OS, OTHER, OS, OTHER]);
  });

  it("reads nothing for a snippet without an #import, or with no profiles configured", () => {
    const { reads, io } = profileIo();
    expect(makeCtx({ runAcsProfiles: [path.resolve("/missing.json")] }, io).runAcsProfiles('#include "zcommon.acs"')).toEqual([]);
    expect(makeCtx({}, io).runAcsProfiles('#import "osacs.acs"')).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("fails on a missing or invalid file, naming it and the env var", () => {
    const { io } = profileIo();
    const missing = path.resolve("/missing.json");
    expect(() => makeCtx({ runAcsProfiles: [OS, missing] }, io).runAcsProfiles('#import "osacs.acs"')).toThrow(
      `can't read run_acs profile ${missing} (listed in ${env}): ENOENT`,
    );
    files[OTHER] = "{ nope";
    try {
      expect(() => makeCtx({ runAcsProfiles: [OTHER] }, io).runAcsProfiles('#import "osacs.acs"')).toThrow(
        new RegExp(`^run_acs profile .*p\\.json: not JSON .*\\(listed in ${env}\\)$`),
      );
    } finally {
      files[OTHER] = '{ "imports": ["other.acs"] }';
    }
  });
});

describe("configFromEnv", () => {
  const E = { ...engine, envPrefix: "ENG", macHooksBinary: "eng-hooks", resolveSaveDir: () => "/saves" };

  it("reads every setting from the engine's env vars", () => {
    const env = {
      ENG_EXE: "/g/Eng.app/", ENG_BRIDGE_HOST: "10.0.0.2", ENG_BRIDGE_PORT: "9000", ENG_SCREENSHOT_DIR: "/shots",
      ENG_IWAD: "/w/doom.wad", ENG_ACS_SRC: "/acs", ENG_BCC: "/bin/bcc", ENG_ACC: "/bin/acc", ENG_BRIDGE_GAMELOG: "/gl/prefix",
      ENG_RUNACS_PROFILES: "/a/p.json",
    };
    expect(configFromEnv(E, env)).toEqual({
      host: "10.0.0.2", basePort: 9000, exe: path.join("/g/Eng.app", "Contents", "MacOS", "eng-hooks"),
      screenshotDir: "/shots", iwad: "/w/doom.wad",
      acsSrc: "/acs", saveDir: "/saves", bcc: "/bin/bcc", acc: "/bin/acc", runAcsProfiles: ["/a/p.json"], gamelog: "/gl/prefix",
    });
  });

  it("splits the run_acs profile list on the path delimiter, dropping blank entries", () => {
    const list = ["", " /a/p.json ", "  ", "/b/q.json", ""].join(path.delimiter);
    expect(configFromEnv(E, { ENG_RUNACS_PROFILES: list }).runAcsProfiles).toEqual(["/a/p.json", "/b/q.json"]);
    expect(configFromEnv(E, { ENG_RUNACS_PROFILES: ` ${path.delimiter} ` }).runAcsProfiles).toBeUndefined();
    expect(configFromEnv(E, {}).runAcsProfiles).toBeUndefined();
  });

  it("defaults to loopback, the stock port and the cwd with no engine configured", () => {
    expect(configFromEnv(E, {})).toMatchObject({ host: "127.0.0.1", basePort: 7777, exe: undefined, screenshotDir: "." });
    expect(configFromEnv(E, {}).gamelog).toBeUndefined();
    expect(configFromEnv(E, { ENG_BRIDGE_GAMELOG: "/gl/prefix" }).gamelog).toBe("/gl/prefix");
  });

  it("takes the gamelog prefix launches use: the engine's default for the exe without an override", () => {
    expect(configFromEnv(E, { ENG_EXE: "/g/eng" }).gamelog).toBe(E.gamelogDefault("/g/eng"));
  });
});

describe("ServerContext.resolveSaveDir", () => {
  it("prefers the explicit argument", () => {
    expect(makeCtx({ saveDir: "/env" }).resolveSaveDir("/arg")).toBe("/arg");
  });

  it("falls back to the configured save dir", () => {
    expect(makeCtx({ saveDir: "/env" }).resolveSaveDir()).toBe("/env");
  });

  it("throws when nothing is configured, naming the engine's env vars", () => {
    expect(() => makeCtx().resolveSaveDir()).toThrow(
      `No save dir. Pass \`dir\`, or set ${envName(engine, "SAVE_DIR")} or ${envName(engine, "EXE")}.`,
    );
  });
});

describe("defaultContextIo", () => {
  it("wires real filesystem, timer and port helpers", async () => {
    const here = fileURLToPath(import.meta.url);
    expect(defaultContextIo.existsSync(here)).toBe(true);
    expect(defaultContextIo.readFileSync(here).length).toBeGreaterThan(0);
    expect(defaultContextIo.readTextSync(here)).toContain("defaultContextIo");
    const whole = readFileSync(here);
    expect(defaultContextIo.readHeadSync(here, 4)).toEqual(whole.subarray(0, 4));
    expect(defaultContextIo.readHeadSync(here, whole.length + 10)).toEqual(whole);
    expect(defaultContextIo.readdirSync(path.dirname(here))).toContain("context.test.ts");
    expect(defaultContextIo.isDirSync(path.dirname(here))).toBe(true);
    expect(defaultContextIo.isDirSync(here)).toBe(false);
    expect(defaultContextIo.realpathSync(`${path.dirname(here)}/../test/context.test.ts`)).toBe(realpathSync(here));
    expect(defaultContextIo.stampOf(here)).toMatch(/^\d+(\.\d+)?:\d+$/);
    expect(defaultContextIo.mtimeOf(here)).toEqual(statSync(here).mtime);
    await expect(defaultContextIo.sleep(0)).resolves.toBeUndefined();
    const ticks = await new Promise<number>((resolve) => {
      let n = 0;
      const stop = defaultContextIo.every(1, () => {
        if (++n === 2) {
          stop();
          resolve(n);
        }
      });
    });
    expect(ticks).toBe(2);
    // Joined at runtime: `here` is this file, so a literal marker would match itself.
    expect(defaultContextIo.hasBridge(here, ["NO", "MARKER"].join("_"))).toBe(false);
    // Windows appends the .exe-only hint.
    const notFound = `compiler /no/such/bcc (set by ${envName(engine, "BCC")}) not found.`;
    const built = defaultContextIo.compileAcs({ engine, compiler: "bcc", exe: "/no/such/bcc", source: "x" });
    expect(built).toMatchObject({ ok: false, diagnostics: expect.stringContaining(notFound) });
    defaultContextIo.removeDir(built.dir);
    expect(defaultContextIo.existsSync(built.dir)).toBe(false);
    expect(typeof defaultContextIo.launchIo.spawn).toBe("function");
    // Reads the real source and builds in a real temp dir, refused here at its compiler.
    expect(defaultContextIo.resolveMapSlot({ sourceFile: here, expr: "x", exe: "/no/such/bcc", deployed: [], engine })).toEqual({
      guard: "compile",
      refused: expect.stringContaining(`build A of ${here} failed:\n${notFound}`),
    });
  });

  it("finds a free port and captures a screenshot through the real helpers", async () => {
    bridge = await FakeBridge.start();
    // The fake is listening, so the first free port is past it (not always +1: another listener may hold that).
    expect(await defaultContextIo.findFreePort(bridge.port)).toBeGreaterThan(bridge.port);
    expect(await defaultContextIo.portOpen("127.0.0.1", bridge.port)).toBe(true);
    await expect(defaultContextIo.reap("/no/such/engine")).resolves.toMatchObject({ found: [] });
  });

  it("captures a screenshot from the engine's working directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zmcp-shot-"));
    // Stand in for the engine: writing the PNG the `screenshot <name>` command asks for.
    const client = {
      runCommand: async (text: string) => {
        const name = text.replace(/^screenshot\s+/, "").split(" ")[0];
        await writeFile(path.join(dir, `${name}.png`), Buffer.from([0x89, 0x50]));
        return [];
      },
    };
    const shot = await defaultContextIo.capture(client as never, dir);
    expect(shot.base64).toBe(Buffer.from([0x89, 0x50]).toString("base64"));
  });
});
