import { describe, it, expect } from "vitest";
import net from "node:net";
import { buildLaunchArgs, buildLaunchEnv, clearQuarantine, resolveEngineExe, resolveScreenshotDir, waitForPort, tryConnect } from "../src/process/launch.js";

describe("resolveEngineExe", () => {
  it("resolves a macOS .app bundle to its inner executable", () => {
    expect(resolveEngineExe("/Apps/zandronum-mcp-hooks.app")).toBe("/Apps/zandronum-mcp-hooks.app/Contents/MacOS/zandronum-mcp-hooks");
  });
  it("tolerates a trailing slash and case", () => {
    expect(resolveEngineExe("/Apps/zandronum-mcp-hooks.APP/")).toBe("/Apps/zandronum-mcp-hooks.APP/Contents/MacOS/zandronum-mcp-hooks");
  });
  it("leaves a direct binary path untouched", () => {
    expect(resolveEngineExe("/Apps/zandronum-mcp-hooks.app/Contents/MacOS/zandronum-mcp-hooks")).toBe("/Apps/zandronum-mcp-hooks.app/Contents/MacOS/zandronum-mcp-hooks");
    expect(resolveEngineExe("/games/zandronum-mcp-hooks")).toBe("/games/zandronum-mcp-hooks");
    expect(resolveEngineExe("C:/games/zandronum-mcp-hooks.exe")).toBe("C:/games/zandronum-mcp-hooks.exe");
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
    const env = buildLaunchEnv("/games/zandronum.exe", 7778, {}, "win32");
    expect(env.ZANDRONUM_BRIDGE_PORT).toBe("7778");
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
  });

  it("preserves the base env", () => {
    const env = buildLaunchEnv("/games/zandronum", 7777, { PATH: "/usr/bin" }, "linux");
    expect(env.PATH).toBe("/usr/bin");
    expect(env.DYLD_LIBRARY_PATH).toBeUndefined();
  });

  it("on macOS points DYLD_LIBRARY_PATH at the engine's folder (for the SDL2 dlopen)", () => {
    const env = buildLaunchEnv("/Apps/zandronum/zandronum", 7777, {}, "darwin");
    expect(env.DYLD_LIBRARY_PATH).toBe("/Apps/zandronum");
  });

  it("on macOS prepends to an existing DYLD_LIBRARY_PATH rather than clobbering it", () => {
    const env = buildLaunchEnv("/Apps/zandronum/zandronum", 7777, { DYLD_LIBRARY_PATH: "/opt/lib" }, "darwin");
    expect(env.DYLD_LIBRARY_PATH).toBe("/Apps/zandronum:/opt/lib");
  });
});

describe("buildLaunchArgs", () => {
  it("defaults to windowed with no other options", () => {
    expect(buildLaunchArgs({})).toEqual(["+set", "fullscreen", "0"]);
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
    });
    expect(args).toEqual([
      "-iwad", "freedoom2.wad",
      "-file", "a.pk3", "b.wad",
      "-skill", "4",
      "+map", "MAP01",
      "+set", "fullscreen", "0",
      "+set", "vid_defwidth", "1920",
      "+set", "vid_defheight", "1080",
      "-nomonsters",
    ]);
  });

  it("treats empty arrays as absent", () => {
    expect(buildLaunchArgs({ files: [], extraArgs: [] })).toEqual(["+set", "fullscreen", "0"]);
  });

  it("emits fullscreen 1 when true", () => {
    expect(buildLaunchArgs({ fullscreen: true })).toEqual(["+set", "fullscreen", "1"]);
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
    await expect(waitForPort("h", 1, 5, 1, async () => true)).resolves.toBeUndefined();
  });

  it("retries then throws when the port never opens", async () => {
    let calls = 0;
    const connect = async () => {
      calls += 1;
      return false;
    };
    await expect(waitForPort("h", 1, 3, 1, connect, async () => {})).rejects.toThrow(/never opened/);
    expect(calls).toBe(3);
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
    await waitForPort("127.0.0.1", port, 30, 25);
    expect(await tryConnect("127.0.0.1", port)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
