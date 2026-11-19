import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { engine } from "../src/engine.js";
import { configFromEnv } from "../src/context.js";
import { buildLaunchArgs, buildLaunchEnv, configPathFor, resolveEngineExe } from "../src/process/launch.js";
import { readSaveMeta } from "../src/saves/png.js";
import { abs, norm } from "./fakes/paths.js";

// Zandronum's adapter values. Core logic is tested engine-neutrally elsewhere.
describe("Zandronum engine adapter", () => {
  it("names its env vars, server, ini and macOS hooks binary", () => {
    expect(engine.envPrefix).toBe("ZANDRONUM");
    expect(configPathFor(engine, join("/g", "zandronum"), {})).toBe(abs("/g/zandronum-mcp.ini"));
    expect(configPathFor(engine, join("/g", "zandronum"), { ZANDRONUM_CONFIG: "/c/z.ini" })).toBe(abs("/c/z.ini"));
    expect(resolveEngineExe("/Apps/z.app", engine)).toBe(norm("/Apps/z.app/Contents/MacOS/zandronum-mcp-hooks"));
  });

  it("pins only fullscreen, ahead of extraArgs", () => {
    expect(buildLaunchArgs({ extraArgs: ["+set", "fullscreen", "1"] }, engine, {})).toEqual([
      "+set", "fullscreen", "0",
      "+set", "fullscreen", "1",
    ]);
  });

  it("on Linux sets SDL_VIDEO_WINDOW_POS from ZANDRONUM_WINDOW_POS when opted in", () => {
    expect(buildLaunchEnv(engine, "/g/z", 7777, { ZANDRONUM_WINDOW_POS: "1920,0" }, "linux").SDL_VIDEO_WINDOW_POS).toBe("1920,0");
    expect(buildLaunchEnv(engine, "/g/z", 7777, {}, "linux").SDL_VIDEO_WINDOW_POS).toBeUndefined();
    expect(buildLaunchEnv(engine, "/g/z.exe", 7777, { ZANDRONUM_WINDOW_POS: "1920,0" }, "win32").SDL_VIDEO_WINDOW_POS).toBeUndefined();
    const pinned = { SDL_VIDEO_WINDOW_POS: "0,0", ZANDRONUM_WINDOW_POS: "1920,0" };
    expect(buildLaunchEnv(engine, "/g/z", 7777, pinned, "linux").SDL_VIDEO_WINDOW_POS).toBe("0,0");
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

  it("points a missing or stock engine at the right builds", () => {
    expect(engine.exeHint).toBe("zandronum.exe on Windows, Zandronum.app on macOS, ./zandronum on Linux");
    expect(engine.bridgeHelp).toBe(": download one from the GitHub Releases, or build it yourself (see docs/ADVANCED.md)");
  });

  it("reads saves as PNG text chunks and opens paths with ANSI fopen", () => {
    expect(engine.readSaveMeta).toBe(readSaveMeta);
    expect(engine.ansiPaths).toBe(true);
  });

  it("keeps saves flat in the save dir", () => {
    expect(engine.saveSubdirs).toBe(false);
  });

  it("refuses no raw console command", () => {
    expect(engine.refuseCommand("debug_restart")).toBeUndefined();
  });

  it("tells the e2e smoke run how this build saves and logs", () => {
    expect(engine.e2e).toEqual({
      saveInto: "path",
      summonAtVoid: false,
      nofocusPattern: undefined,
    });
  });
});
