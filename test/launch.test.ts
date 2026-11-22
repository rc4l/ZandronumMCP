import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import net from "node:net";
import {
  buildLaunchArgs,
  buildLaunchEnv,
  clearQuarantine,
  resolveEngineExe,
  resolveScreenshotDir,
  waitForPort,
  tryConnect,
  findFreePort,
  deriveBasePort,
  configPathFor,
  isolatedConfigPathFor,
  userTempDir,
  argValue,
  hasArg,
  DEFAULT_BASE_PORT,
  PORT_STRIDE,
} from "../src/process/launch.js";
import type { EngineAdapter } from "../src/adapter.js";
import { engine } from "../src/engine.js";
import { abs, norm } from "./fakes/paths.js";

// A neutral variant, so core launch logic is tested apart from any one engine's values
// (those are in test/engine.test.ts).
const T: EngineAdapter = {
  ...engine,
  envPrefix: "ENG",
  serverName: "eng-mcp",
  macHooksBinary: "eng-hooks",
  fullscreenCvar: "fs",
  launchPins: (_o, env) => ["+set", "pin", env.PIN ?? "0"],
  launchEnv: (base, platform) => (platform === "linux" && base.POS ? { WIN_POS: base.POS } : {}),
  gamelogDefault: (exe) => `${exe}.gamelog`,
  loadSaveArgs: (save) => ["-loadgame", save],
};

describe("resolveEngineExe", () => {
  it("resolves a macOS .app bundle to the engine's inner executable", () => {
    expect(resolveEngineExe("/Apps/eng.app", T)).toBe(norm("/Apps/eng.app/Contents/MacOS/eng-hooks"));
  });
  it("tolerates a trailing slash and case", () => {
    expect(resolveEngineExe("/Apps/eng.APP/", T)).toBe(norm("/Apps/eng.APP/Contents/MacOS/eng-hooks"));
  });
  it("leaves a direct binary path untouched", () => {
    expect(resolveEngineExe("/Apps/eng.app/Contents/MacOS/eng-hooks", T)).toBe("/Apps/eng.app/Contents/MacOS/eng-hooks");
    expect(resolveEngineExe("/games/eng-hooks", T)).toBe("/games/eng-hooks");
    expect(resolveEngineExe("C:/games/eng-hooks.exe", T)).toBe("C:/games/eng-hooks.exe");
  });
});

describe("clearQuarantine", () => {
  it("does nothing off macOS", () => {
    const calls: Array<[string, string[]]> = [];
    clearQuarantine("/games/zandronum.exe", "win32", (cmd, args) => void calls.push([cmd, args]));
    clearQuarantine("/games/zandronum", "linux", (cmd, args) => void calls.push([cmd, args]));
    expect(calls).toEqual([]);
  });

  it("on macOS runs `xattr -dr com.apple.quarantine` against the engine's folder", () => {
    const calls: Array<[string, string[]]> = [];
    clearQuarantine("/Apps/zandronum/zandronum", "darwin", (cmd, args) => void calls.push([cmd, args]));
    expect(calls).toEqual([["xattr", ["-dr", "com.apple.quarantine", "/Apps/zandronum"]]]);
  });

  it("swallows failures (best-effort)", () => {
    expect(() =>
      clearQuarantine("/Apps/zandronum/zandronum", "darwin", () => {
        throw new Error("xattr missing");
      }),
    ).not.toThrow();
  });

  it("uses a real default runner without throwing (covers the default exec path)", () => {
    // platform forced to darwin but run defaulted: on a non-mac CI runner xattr is
    // absent so execFileSync throws — which must be swallowed, not propagated.
    expect(() => clearQuarantine("/nonexistent/zandronum", "darwin")).not.toThrow();
  });
});

describe("buildLaunchEnv", () => {
  it("always sets the bridge port from the instance port", () => {
    const env = buildLaunchEnv(T, "/games/eng.exe", 7778, {}, "win32");
    expect(env.ENG_BRIDGE_PORT).toBe("7778");
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
  });

  it("passes the MCP's PID as the watchdog parent so the engine can't outlive it", () => {
    const env = buildLaunchEnv(T, "/games/eng.exe", 7778, {}, "win32", 4242);
    expect(env.ENG_BRIDGE_PARENT_PID).toBe("4242");
  });

  it("preserves the base env", () => {
    const env = buildLaunchEnv(T, "/games/eng", 7777, { PATH: "/usr/bin" }, "linux");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
  });

  it("on macOS points DYLD_LIBRARY_PATH at the engine's folder (for the SDL2 dlopen)", () => {
    const env = buildLaunchEnv(T, "/Apps/eng/eng", 7777, {}, "darwin");
    expect(env.DYLD_LIBRARY_PATH).toBe("/Apps/eng");
  });

  it("on macOS prepends to an existing DYLD_LIBRARY_PATH rather than clobbering it", () => {
    const env = buildLaunchEnv(T, "/Apps/eng/eng", 7777, { DYLD_LIBRARY_PATH: "/opt/lib" }, "darwin");
    expect(env.DYLD_LIBRARY_PATH).toBe("/Apps/eng:/opt/lib");
  });

  it("on Linux defaults DISPLAY to :0 when the IDE didn't pass one (issue #6)", () => {
    const env = buildLaunchEnv(T, "/games/eng", 7777, {}, "linux");
    expect(env.DISPLAY).toBe(":0");
  });

  it("on Linux respects an existing DISPLAY", () => {
    const env = buildLaunchEnv(T, "/games/eng", 7777, { DISPLAY: ":1" }, "linux");
    expect(env.DISPLAY).toBe(":1");
  });

  it("never sets DISPLAY off Linux", () => {
    expect(buildLaunchEnv(T, "/g/z.exe", 7777, {}, "win32").DISPLAY).toBeUndefined();
    expect(buildLaunchEnv(T, "/g/z", 7777, {}, "darwin").DISPLAY).toBeUndefined();
  });

  it("adds the engine's own env extras", () => {
    expect(buildLaunchEnv(T, "/games/eng", 7777, { POS: "1920,0" }, "linux").WIN_POS).toBe("1920,0");
    expect(buildLaunchEnv(T, "/games/eng", 7777, {}, "linux").WIN_POS).toBeUndefined();
  });

  it("lets the launching environment win over an engine extra", () => {
    const env = buildLaunchEnv(T, "/games/eng", 7777, { WIN_POS: "0,0", POS: "1920,0" }, "linux");
    expect(env.WIN_POS).toBe("0,0");
  });

  it("defaults the gamelog from the engine", () => {
    const env = buildLaunchEnv(T, "/games/eng/eng", 7777, {}, "linux");
    expect(env.ENG_BRIDGE_GAMELOG).toBe("/games/eng/eng.gamelog");
  });

  it("respects an existing gamelog", () => {
    const env = buildLaunchEnv(T, "/games/eng/eng", 7777, { ENG_BRIDGE_GAMELOG: "/custom/prefix" }, "linux");
    expect(env.ENG_BRIDGE_GAMELOG).toBe("/custom/prefix");
  });
});

describe("findFreePort", () => {
  it("returns the start port when nothing is listening", async () => {
    const free = await findFreePort(7777, "127.0.0.1", 20, async () => false);
    expect(free).toBe(7777);
  });

  it("skips occupied ports and returns the first free one", async () => {
    const busy = new Set([7777, 7778]);
    const free = await findFreePort(7777, "127.0.0.1", 20, async (_h, p) => busy.has(p));
    expect(free).toBe(7779);
  });

  it("throws when the whole span is occupied", async () => {
    await expect(findFreePort(7777, "127.0.0.1", 3, async () => true)).rejects.toThrow(/no free bridge port/);
  });
});

describe("buildLaunchArgs", () => {
  it("defaults to windowed, with no other options", () => {
    expect(buildLaunchArgs({}, T, {})).toEqual(["+set", "fs", "0", "+set", "pin", "0"]);
  });

  it("passes the server env to the engine's own pins", () => {
    expect(buildLaunchArgs({}, T, { PIN: "7" }).slice(-3)).toEqual(["+set", "pin", "7"]);
  });

  it("maps every option to its flag", () => {
    const args = buildLaunchArgs({
      iwad: "freedoom2.wad",
      files: ["a.pk3", "b.wad"],
      skill: 4,
      map: "MAP01",
      fullscreen: false,
      width: 1920,
      height: 1080,
      extraArgs: ["-nomonsters"],
    }, T, {});
    expect(args).toEqual([
      "-iwad", "freedoom2.wad",
      "-file", "a.pk3", "b.wad",
      "-skill", "4",
      "+set", "fs", "0",
      "+set", "vid_defwidth", "1920",
      "+set", "vid_defheight", "1080",
      "+set", "pin", "0",
      "+map", "MAP01",
      "-nomonsters",
    ]);
  });

  it("puts +map after every +set pin, so a launch with `map` can't load a live level on the saved values", () => {
    const args = buildLaunchArgs({ map: "MAP01", mouse: false, width: 640 }, T, {});
    const mapIndex = args.indexOf("+map");
    const lastSetIndex = args.lastIndexOf("+set");
    expect(mapIndex).toBeGreaterThan(lastSetIndex);
  });

  it("treats empty arrays as absent", () => {
    expect(buildLaunchArgs({ files: [], extraArgs: [] }, T, {})).toEqual(["+set", "fs", "0", "+set", "pin", "0"]);
  });

  it("emits fullscreen 1 when true", () => {
    expect(buildLaunchArgs({ fullscreen: true }, T, {}).slice(0, 3)).toEqual(["+set", "fs", "1"]);
  });

  it("reads the server's own env for the pins by default", () => {
    expect(buildLaunchArgs({}, T)).toEqual(buildLaunchArgs({}, T, process.env));
  });

  it("pins use_mouse only when mouse is set, and on by default for a recording", () => {
    const mouse = (o: Parameters<typeof buildLaunchArgs>[0]) => {
      const args = buildLaunchArgs(o, T, {});
      return args.includes("use_mouse") ? args.slice(args.indexOf("use_mouse") - 1, args.indexOf("use_mouse") + 2) : [];
    };
    expect(mouse({})).toEqual([]);
    expect(mouse({ mouse: true })).toEqual(["+set", "use_mouse", "1"]);
    expect(mouse({ mouse: false })).toEqual(["+set", "use_mouse", "0"]);
    expect(mouse({ record: "/d/a.lmp" })).toEqual(["+set", "use_mouse", "1"]);
    expect(mouse({ record: "/d/a.lmp", mouse: false })).toEqual(["+set", "use_mouse", "0"]);
  });

  it("passes save and record as -loadgame and -record before the +set pins", () => {
    expect(buildLaunchArgs({ save: "/s/base.zds", record: "/d/a.lmp", mouse: false }, T, {}).slice(0, 4)).toEqual([
      "-loadgame", "/s/base.zds", "-record", "/d/a.lmp",
    ]);
  });

  it("builds the save args through the adapter, which sees the caller's extraArgs", () => {
    const E: EngineAdapter = { ...T, loadSaveArgs: (save, extra) => ["-ls", save, ...(extra ?? [])] };
    const args = buildLaunchArgs({ save: "/s/base.zds", extraArgs: ["-x"] }, E, {});
    expect(args.slice(0, 4)).toEqual(["-ls", "/s/base.zds", "-x", "+set"]);
    expect(buildLaunchArgs({ save: "/s/base.zds" }, E, {}).slice(0, 3)).toEqual(["-ls", "/s/base.zds", "+set"]);
  });

  it("pins vid_defwidth/vid_defheight only when given", () => {
    const size = (o: Parameters<typeof buildLaunchArgs>[0]) =>
      buildLaunchArgs(o, T, {}).flatMap((a, i, all) => (a.startsWith("vid_def") ? [a, all[i + 1]] : []));
    expect(size({})).toEqual([]);
    expect(size({ width: 640 })).toEqual(["vid_defwidth", "640"]);
    expect(size({ height: 480 })).toEqual(["vid_defheight", "480"]);
  });

  it("puts the engine's pins ahead of the caller's extraArgs so they can still override", () => {
    const args = buildLaunchArgs({ extraArgs: ["+set", "pin", "2"] }, T, {});
    expect(args.slice(-6)).toEqual(["+set", "pin", "0", "+set", "pin", "2"]);
  });
});

describe("resolveScreenshotDir", () => {
  it("prefers an explicit env override", () => {
    expect(resolveScreenshotDir("/app/Contents/MacOS/engine", "/shots")).toBe("/shots");
  });

  it("falls back to the engine's own folder", () => {
    expect(resolveScreenshotDir("/app/Contents/MacOS/engine", undefined)).toBe(
      "/app/Contents/MacOS",
    );
  });

  it("defaults to the process cwd when no engine is configured", () => {
    expect(resolveScreenshotDir(undefined, undefined)).toBe(".");
  });
});

describe("waitForPort", () => {
  it("resolves once connect succeeds", async () => {
    await expect(waitForPort("h", 1, { attempts: 5, intervalMs: 1, connect: async () => true })).resolves.toBeUndefined();
  });

  it("retries then throws when the port never opens", async () => {
    let calls = 0;
    const connect = async () => {
      calls += 1;
      return false;
    };
    await expect(
      waitForPort("h", 1, { attempts: 3, intervalMs: 1, connect, sleep: async () => {} }),
    ).rejects.toThrow(/never opened/);
    expect(calls).toBe(3);
  });

  it("stops polling once its signal is aborted", async () => {
    const polling = new AbortController();
    let calls = 0;
    const connect = async () => {
      calls += 1;
      if (calls === 2) polling.abort();
      return false;
    };
    await expect(
      waitForPort("h", 1, { attempts: 60, intervalMs: 1, connect, sleep: async () => {}, signal: polling.signal }),
    ).rejects.toThrow(/stopped waiting for bridge port h:1/);
    expect(calls).toBe(2);
  });

  it("works against a real port that opens slightly late (default connect/sleep)", async () => {
    const server = net.createServer();
    // grab a free port, then start listening a little later
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", function (this: net.Server) {
        const p = (this.address() as net.AddressInfo).port;
        this.close(() => resolve(p));
      });
      void probe;
    });
    setTimeout(() => server.listen(port, "127.0.0.1"), 60);
    await waitForPort("127.0.0.1", port, { attempts: 30, intervalMs: 25 });
    expect(await tryConnect("127.0.0.1", port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("deriveBasePort", () => {
  it("honours an explicit port", () => {
    expect(deriveBasePort("/repos/a/build/zandronum", "9000")).toBe(9000);
  });

  it("ignores a junk or non-positive explicit port", () => {
    expect(deriveBasePort(undefined, "nonsense")).toBe(DEFAULT_BASE_PORT);
    expect(deriveBasePort(undefined, "0")).toBe(DEFAULT_BASE_PORT);
  });

  it("falls back to the default with no engine and no setting", () => {
    expect(deriveBasePort(undefined, undefined)).toBe(DEFAULT_BASE_PORT);
  });

  it("is stable for a given engine path", () => {
    const exe = "/repos/ZandroX-chat2/build/zandronum";
    expect(deriveBasePort(exe, undefined)).toBe(deriveBasePort(exe, undefined));
  });

  it("separates sibling checkouts into different ranges", () => {
    // The real motivating case: four branches of one project, four builds, four
    // editor windows that would otherwise all claim 7777.
    const bases = ["", "-chat2", "-chat3", "-chat4"].map((suffix) =>
      deriveBasePort(`/Users/x/repos/ZandroX${suffix}/build/zandronum`, undefined),
    );
    expect(new Set(bases).size).toBe(4);
    // Far enough apart that findFreePort's search can't cross into a neighbour.
    for (const a of bases) {
      for (const b of bases) {
        if (a !== b) expect(Math.abs(a - b)).toBeGreaterThanOrEqual(PORT_STRIDE);
      }
    }
  });

  it("lands on a sane port range", () => {
    const port = deriveBasePort("/some/engine", undefined);
    expect(port).toBeGreaterThanOrEqual(DEFAULT_BASE_PORT);
    expect(port).toBeLessThan(49152); // below the ephemeral range
  });
});

describe("configPathFor", () => {
  it("gives each checkout its own ini beside the engine binary", () => {
    expect(configPathFor(T, join("/a", "eng"), {})).toBe(abs("/a/eng-mcp.ini"));
    expect(configPathFor(T, join("/b", "eng"), {})).toBe(abs("/b/eng-mcp.ini"));
  });
  it("takes <PREFIX>_CONFIG over the default, ignoring an empty one", () => {
    expect(configPathFor(T, join("/a", "eng"), { ENG_CONFIG: "/c/mine.ini" })).toBe(abs("/c/mine.ini"));
    expect(configPathFor(T, join("/a", "eng"), { ENG_CONFIG: "" })).toBe(abs("/a/eng-mcp.ini"));
  });
  it("resolves a relative <PREFIX>_CONFIG against the engine's folder, as the engine would", () => {
    expect(configPathFor(T, join("/a", "eng"), { ENG_CONFIG: join("cfg", "mine.ini") })).toBe(abs("/a/cfg/mine.ini"));
  });
  it("reads the process env when none is given", () => {
    expect(configPathFor(T, join("/a", "eng"))).toBe(configPathFor(T, join("/a", "eng"), process.env));
  });
});

describe("isolatedConfigPathFor", () => {
  it("sits beside the shared ini, keyed by bridge port", () => {
    expect(isolatedConfigPathFor(T, join("/c", "mine.ini"), 7781)).toBe(join("/c", "eng-mcp-7781.ini"));
  });
});

describe("userTempDir", () => {
  it("keys the dir by uid where there is one, so users sharing a temp dir don't collide", () => {
    expect(userTempDir("eng-mcp", "/tmp", { getuid: () => 1000 })).toBe(join("/tmp", "eng-mcp-1000"));
    expect(userTempDir("eng-mcp", "C:\\Temp", {})).toBe(join("C:\\Temp", "eng-mcp"));
  });
  it("defaults to the OS temp dir and this process", () => {
    expect(userTempDir("eng-mcp")).toBe(userTempDir("eng-mcp", tmpdir(), process));
  });
});

describe("buildLaunchArgs config", () => {
  it("passes -config first so later flags win", () => {
    expect(buildLaunchArgs({ config: "/b/z.ini", iwad: "d2.wad" }, T, {}).slice(0, 4)).toEqual([
      "-config",
      "/b/z.ini",
      "-iwad",
      "d2.wad",
    ]);
  });

  it("omits -config when none is given", () => {
    expect(buildLaunchArgs({}, T, {}).includes("-config")).toBe(false);
  });

  it.each([
    ["config", "-CONFIG", "/b/z.ini", "/t/mine.ini"],
    ["iwad", "-Iwad", "/w/DOOM2.WAD", "/t/FREEDOOM2.WAD"],
  ])("drops the default %s when extraArgs brings its own", (key, flag, ours, theirs) => {
    const args = buildLaunchArgs({ [key]: ours, extraArgs: [flag, theirs] }, T, {});
    expect(args.includes(ours)).toBe(false);
    expect(args.slice(-2)).toEqual([flag, theirs]);
  });

  it("finds the value after a flag in any case, as a whole arg only", () => {
    expect(argValue(["-nosound", "-Config", "/t/a.ini"], "-config")).toBe("/t/a.ini");
    expect(argValue(["-connect", "127.0.0.1", "+NAME", "client_a"], "+name")).toBe("client_a");
    expect(argValue(["-config"], "-config")).toBeUndefined();
    expect(argValue(["-nosound"], "-config")).toBeUndefined();
    expect(argValue(undefined, "+name")).toBeUndefined();
    expect(argValue(["+name", "-hostile"], "-host")).toBeUndefined();
  });

  it("spots a flag in any case, even with no value after it", () => {
    expect(hasArg(["-nosound", "-CONFIG"], "-config")).toBe(true);
    expect(hasArg(["-CONFIG"], "-Config")).toBe(true);
    expect(hasArg(["-nosound"], "-config")).toBe(false);
    expect(hasArg(undefined, "-config")).toBe(false);
  });

  it("keeps the default -config when extraArgs has none", () => {
    expect(buildLaunchArgs({ config: "/b/z.ini", extraArgs: ["-nosound"] }, T, {}).slice(0, 2)).toEqual([
      "-config",
      "/b/z.ini",
    ]);
  });
});
