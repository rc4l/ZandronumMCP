import { describe, it, expect } from "vitest";
import net from "node:net";
import { buildLaunchArgs, buildLaunchEnv, waitForPort, tryConnect } from "../src/process/launch.js";

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
  it("returns nothing for empty options", () => {
    expect(buildLaunchArgs({})).toEqual([]);
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
    expect(buildLaunchArgs({ files: [], extraArgs: [] })).toEqual([]);
  });

  it("emits fullscreen 1 when true", () => {
    expect(buildLaunchArgs({ fullscreen: true })).toEqual(["+set", "fullscreen", "1"]);
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
