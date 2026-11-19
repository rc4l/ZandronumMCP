import { describe, it, expect } from "vitest";
import { parsePlayerState, parseTarget, playersReply, withLiveStatus } from "../src/parsers/playerstate.js";
import type { PlayerState } from "../src/parsers/playerstate.js";

// Captured currentpos replies: Zandronum's single "lightlevel", UZDoom's sector + actor pair.
const CURRENTPOS = {
  zandronum:
    "Current player position: (128.500,-64.000,0.000), angle: 270.000, floorheight: -8.000, sector:12, lightlevel: 144",
  uzdoom:
    "Current player position: (128.500,-64.000,0.000), angle: 270.000, floorheight: -8.000, sector:12, sector lightlevel: 144, actor lightlevel: -1",
};

describe("parsePlayerState", () => {
  it.each(Object.entries(CURRENTPOS))("parses %s's currentpos including negative coordinates", (_e, line) => {
    expect(parsePlayerState([line])).toEqual({
      x: 128.5,
      y: -64,
      z: 0,
      angle: 270,
      floorHeight: -8,
      sector: 12,
      light: 144,
    });
  });
  it.each(["nothing here", "You are not in game!"])("returns null for %j", (line) => {
    expect(parsePlayerState([line])).toBeNull();
  });
});

describe("parseTarget", () => {
  it.each([
    ["Zandronum", "Target=DoomImp, Health=60, Spawnhealth=60"],
    ["UZDoom", "Class=DoomImp, Health=60, Spawnhealth=60"],
    ["UZDoom player", "Player=bob, Class=DoomPlayer, Health=60, Spawnhealth=100"],
  ])("parses a %s linetarget result", (_e, line) => {
    expect(parseTarget([line])).toMatchObject({ health: 60, target: expect.stringMatching(/^Doom/) });
  });
  it("keeps the class name and spawn health", () => {
    expect(parseTarget(["Class=DoomImp, Health=60, Spawnhealth=60"])).toEqual({
      target: "DoomImp",
      health: 60,
      spawnHealth: 60,
    });
  });
  it.each(["(no target)", "No target found"])("returns null for %j", (line) => {
    expect(parseTarget([line])).toBeNull();
  });
});

describe("withLiveStatus", () => {
  const base: PlayerState = {
    x: 0,
    y: 0,
    z: 0,
    angle: 0,
    floorHeight: 0,
    sector: 0,
    light: 160,
  };

  it("is a no-op on a legacy bridge with no status", () => {
    expect(withLiveStatus(base, undefined)).toEqual(base);
  });

  it("leaves the state untouched when the status carries none of these fields", () => {
    expect(withLiveStatus(base, {})).toEqual(base);
  });

  it("merges health, armor, liveness and spectating", () => {
    expect(
      withLiveStatus(base, { health: "80", armor: "25", player: "alive", spectating: "0" }),
    ).toEqual({ ...base, health: 80, armor: 25, player: "alive", spectating: false });
  });

  it("recognizes dead and none as valid player values", () => {
    expect(withLiveStatus(base, { player: "dead" }).player).toBe("dead");
    expect(withLiveStatus(base, { player: "none" }).player).toBe("none");
  });

  it("ignores a player value that isn't alive/dead/none", () => {
    expect(withLiveStatus(base, { player: "zombie" }).player).toBeUndefined();
  });

  it("reads spectating=1 as true", () => {
    expect(withLiveStatus(base, { spectating: "1" }).spectating).toBe(true);
  });
});

describe("playersReply", () => {
  it("returns the player rows under MCP_PLAYERS, else undefined", () => {
    expect(playersReply(["MCP_PLAYERS", "player slot=0 name=Player"])).toEqual([{ slot: 0, name: "Player" }]);
    expect(playersReply(["MCP_PLAYERS"])).toEqual([]);
    expect(playersReply(["Unknown command \"dumpplayers\""])).toBeUndefined();
  });
});
