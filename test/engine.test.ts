import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { engine } from "../src/engine.js";
import { configFromEnv } from "../src/context.js";
import { buildLaunchArgs, buildLaunchEnv, configPathFor, resolveEngineExe, userTempDir } from "../src/process/launch.js";
import { abs, norm } from "./fakes/paths.js";

// Zandronum's adapter values, since core logic is tested engine-neutrally elsewhere.
describe("Zandronum engine adapter", () => {
  it("names its env vars, server, ini and macOS hooks binary", () => {
    expect(engine.envPrefix).toBe("ZANDRONUM");
    expect(configPathFor(engine, join("/g", "zandronum"), {})).toBe(abs("/g/zandronum-mcp.ini"));
    expect(configPathFor(engine, join("/g", "zandronum"), { ZANDRONUM_CONFIG: "/c/z.ini" })).toBe(abs("/c/z.ini"));
    expect(resolveEngineExe("/Apps/z.app", engine)).toBe(norm("/Apps/z.app/Contents/MacOS/zandronum-mcp-hooks"));
  });

  it("pins fullscreen, no master-server announce and 8 clients per IP, ahead of extraArgs", () => {
    expect(buildLaunchArgs({ extraArgs: ["+set", "sv_maxclientsperip", "2"] }, engine, {})).toEqual([
      "+set", "fullscreen", "0",
      "+set", "sv_updatemaster", "0",
      "+set", "sv_maxclientsperip", "8",
      "+set", "sv_maxclientsperip", "2",
    ]);
  });

  it("on Linux sets SDL_VIDEO_WINDOW_POS from ZANDRONUM_WINDOW_POS when opted in", () => {
    expect(buildLaunchEnv(engine, "/g/z", 7777, { ZANDRONUM_WINDOW_POS: "1920,0" }, "linux").SDL_VIDEO_WINDOW_POS).toBe("1920,0");
    expect(buildLaunchEnv(engine, "/g/z", 7777, {}, "linux").SDL_VIDEO_WINDOW_POS).toBeUndefined();
    expect(buildLaunchEnv(engine, "/g/z.exe", 7777, { ZANDRONUM_WINDOW_POS: "1920,0" }, "win32").SDL_VIDEO_WINDOW_POS).toBeUndefined();
    const pinned = { SDL_VIDEO_WINDOW_POS: "0,0", ZANDRONUM_WINDOW_POS: "1920,0" };
    expect(buildLaunchEnv(engine, "/g/z", 7777, pinned, "linux").SDL_VIDEO_WINDOW_POS).toBe("0,0");
  });

  it("defaults the gamelog to a prefix in a per-user temp dir, not beside the engine binary", () => {
    expect(buildLaunchEnv(engine, "/games/zandronum/zandronum", 7777, {}, "linux").ZANDRONUM_BRIDGE_GAMELOG).toBe(
      join(userTempDir("zandronum-mcp"), "gamelogs", "zagamelog"),
    );
  });

  it("saves to ZANDRONUM_SAVE_DIR, else beside the engine (the save CCMD writes to its cwd)", () => {
    expect(engine.resolveSaveDir({ ZANDRONUM_SAVE_DIR: "/env" }, "/engine/zandronum")).toBe("/env");
    expect(engine.resolveSaveDir({}, join("/engine", "zandronum"))).toBe(norm("/engine"));
    expect(engine.resolveSaveDir({}, undefined)).toBeUndefined();
  });

  it("defaults the server's save dir to the resolved engine binary's folder", () => {
    const config = configFromEnv(engine, { ZANDRONUM_EXE: "/Apps/Z.app" });
    expect(config.saveDir).toBe(dirname(config.exe as string));
    expect(config.saveDir).toBe(join("/Apps/Z.app", "Contents", "MacOS"));
  });

  it("refuses no raw console command", () => {
    expect(engine.refuseCommand("debug_restart")).toBeUndefined();
  });
});
