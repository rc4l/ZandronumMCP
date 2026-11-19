import { describe, it, expect } from "vitest";
import { dirname, join } from "node:path";
import { engine } from "../src/engine.js";
import { configFromEnv } from "../src/context.js";
import { buildLaunchArgs, buildLaunchEnv, configPathFor, resolveEngineExe, userTempDir } from "../src/process/launch.js";
import { collectAcsModulesAt } from "../src/acs/collect.js";
import { buildBehaviorAcse } from "./fakes/acs-builder.js";
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

  it("loads a save by its absolute path, whatever save dir the caller sets", () => {
    expect(engine.loadSaveArgs("/s/base.zds", ["-savedir", "/other"])).toEqual(["-loadgame", "/s/base.zds"]);
  });

  it("refuses no raw console command", () => {
    expect(engine.refuseCommand("debug_restart")).toBeUndefined();
  });

  it("walks a -file directory as file_directory.cpp does on each platform", () => {
    const entries: Array<[string, boolean]> = [[".old", true], [".lib.o", false], ["acs", true], ["lib.o.bak", false], ["lib.orig.o", false], ["lib.BAK", false]];
    const skipped = (platform: NodeJS.Platform) => entries.filter(([name, isDir]) => engine.dirWalkSkips(name, isDir, platform)).map(([n]) => n);
    expect(skipped("linux")).toEqual([".old"]);
    expect(skipped("freebsd")).toEqual([".old"]);
    expect(skipped("darwin")).toEqual([".old", ".lib.o"]);
    expect(skipped("win32")).toEqual(["lib.o.bak", "lib.orig.o"]);
  });

  it("never finds a stale copy under acs/.old/ in a launch dir, since the Linux fts walk skips dot-dirs", () => {
    // Sorting ahead of acs/lib.o, the stale copy would be the one a sourceFile build matched.
    const root = join("/mod");
    const dirs = new Map([[root, ["acs"]], [join(root, "acs"), [".old", "lib.o"]], [join(root, "acs", ".old"), ["lib.o"]]]);
    const lib = buildBehaviorAcse(["f"], []);
    const io = {
      isDirSync: (p: string) => dirs.has(p),
      readdirSync: (p: string) => dirs.get(p)!,
      readFileSync: () => lib,
      readHeadSync: (_p: string, bytes: number) => lib.subarray(0, bytes),
      realpathSync: (p: string) => p,
    };
    const walked = collectAcsModulesAt(root, io, (name, isDir) => engine.dirWalkSkips(name, isDir, "linux"));
    expect(walked.map((m) => m.name)).toEqual(["acs/lib.o"]);
  });
});
