import { describe, it, expect, afterEach } from "vitest";
import path from "node:path";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile } from "node:fs/promises";
import { ServerContext, defaultContextIo, type ServerConfig } from "../src/context.js";
import { InstanceRegistry } from "../src/process/registry.js";
import { FakeBridge } from "./fakes/fake-bridge.js";
import { stubIo } from "./fakes/tool-harness.js";
import { buildWad, sectorsLump, doomLinedefsLump, sidedefsLump, vertexesLump } from "./fakes/wad-builder.js";

const baseConfig: ServerConfig = { host: "127.0.0.1", basePort: 7777, screenshotDir: "/shots" };

function makeCtx(config: Partial<ServerConfig> = {}, io = {}, registry = new InstanceRegistry()) {
  return new ServerContext({ ...baseConfig, ...config }, stubIo(io), registry);
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
    expect(() => makeCtx().loadMap(undefined, "MAP01")).toThrow(/No WAD specified/);
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
    expect(() => makeCtx().loadAcsIndex(undefined)).toThrow(/No ACS source dir/);
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

describe("ServerContext.resolveSaveDir", () => {
  it("prefers the explicit argument", () => {
    expect(makeCtx({ saveDir: "/env" }).resolveSaveDir("/arg")).toBe("/arg");
  });

  it("falls back to the configured save dir, then to the engine folder", () => {
    expect(makeCtx({ saveDir: "/env" }).resolveSaveDir()).toBe("/env");
    expect(makeCtx({ exe: path.join("/engine", "zandronum") }).resolveSaveDir()).toBe("/engine");
  });

  it("throws when nothing is configured", () => {
    expect(() => makeCtx().resolveSaveDir()).toThrow(/No save dir/);
  });
});

describe("defaultContextIo", () => {
  it("wires real filesystem, timer and port helpers", async () => {
    const here = new URL(import.meta.url).pathname;
    expect(defaultContextIo.existsSync(here)).toBe(true);
    expect(defaultContextIo.readFileSync(here).length).toBeGreaterThan(0);
    expect(defaultContextIo.readTextSync(here)).toContain("defaultContextIo");
    expect(defaultContextIo.readdirSync(path.dirname(here))).toContain("context.test.ts");
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
    expect(defaultContextIo.hasBridge(here)).toBe(false);
    const built = defaultContextIo.compileAcs({ compiler: "bcc", exe: "/no/such/bcc", source: "x" });
    expect(built).toMatchObject({ ok: false, diagnostics: "compiler /no/such/bcc (set by ZANDRONUM_BCC) not found." });
    defaultContextIo.removeDir(built.dir);
    expect(defaultContextIo.existsSync(built.dir)).toBe(false);
    expect(typeof defaultContextIo.launchIo.spawn).toBe("function");
  });

  it("finds a free port and captures a screenshot through the real helpers", async () => {
    bridge = await FakeBridge.start();
    // The fake is listening, so the first free port must be past it.
    expect(await defaultContextIo.findFreePort(bridge.port)).toBe(bridge.port + 1);
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
