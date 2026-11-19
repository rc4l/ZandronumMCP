import { describe, it, expect } from "vitest";
import { parseActorState, parseActorsNear } from "../src/parsers/actorstate.js";
import { BUTTON_NAMES, WEAPON_FLAG_NAMES, bitNames } from "../src/parsers/actorstate.js";
import { FLAG_NAMES, filterFound, parseFindActors, parseFoundReply } from "../src/parsers/actorstate.js";

describe("parseActorState", () => {
  const out = [
    "MCP_ACTOR",
    "class DoomPlayer",
    "health 100",
    "pos -3040.0 -3744.0 16.0",
    "angle 178.9",
    "pitch -10.0",
    "state TNT1 A 0",
    "weapon Pistol",
    "morphtics 0",
    "item Clip 50 200",
    "item Pistol 1 1",
  ];

  it("parses a full player actor snapshot incl. DECORATE state", () => {
    const a = parseActorState(out);
    expect(a.class).toBe("DoomPlayer");
    expect(a.health).toBe(100);
    expect(a.pos).toEqual({ x: -3040, y: -3744, z: 16 });
    expect(a.angle).toBe(178.9);
    expect(a.pitch).toBe(-10);
    expect(a.state).toEqual({ sprite: "TNT1", frame: "A", tics: 0 });
    expect(a.weapon).toBe("Pistol");
    expect(a.morphTics).toBe(0);
    expect(a.inventory).toEqual([
      { class: "Clip", amount: 50, maxAmount: 200 },
      { class: "Pistol", amount: 1, maxAmount: 1 },
    ]);
  });

  it("returns nulls for a missing actor and handles bare class/weapon lines", () => {
    const empty = parseActorState(["MCP_ACTOR", "actor none"]);
    expect(empty.class).toBeNull();
    expect(empty.inventory).toEqual([]);
    expect(empty.player).toBeNull();
    // bare lines (no value) -> null
    const bare = parseActorState(["class", "weapon"]);
    expect(bare.class).toBeNull();
    expect(bare.weapon).toBeNull();
  });

  it("parses a player's input, weapon info and psprite layers", () => {
    const a = parseActorState([
      "MCP_ACTOR",
      "class DoomPlayer",
      "state PLAY F 6",
      "stateid DoomPlayer.5 Missile",
      "weapon Pistol",
      "morphtics 0",
      // attack + bit 30 (unnamed), and the post-reborn ~0 oldbuttons.
      `input buttons=${1 | (1 << 30)} oldbuttons=0 forward=12800 side=-10240 up=0 yaw=-320 pitch=64 roll=0`,
      "modinput buttons=1 oldbuttons=4294967295 forward=0 side=0 up=0 yaw=0 pitch=0 roll=0",
      "weaponinfo refire=2 flags=137",
      "psprite layer=1 sprite=PISG frame=B tics=6 x=0.0 y=32.0 id=Pistol.4 label=Fire+1",
      "psprite layer=1000 sprite=PISF frame=A tics=7 x=0.0 y=32.0 id=Pistol.9 label=Flash",
      "psprite layer=-1 sprite=WAVE frame=A tics=-1 x=1.5 y=-2.0 id=StrifeHands.0",
      "psprite layer=2147483645 sprite=0000 frame=A tics=0 x=0.0 y=0.0",
      "item Clip 50 200",
    ]);
    expect(a.state).toEqual({ sprite: "PLAY", frame: "F", tics: 6, id: "DoomPlayer.5", label: "Missile" });
    expect(a.player).toEqual({
      input: {
        buttons: ["attack", "bit30"], oldButtons: [],
        forward: 12800, side: -10240, up: 0, yaw: -320, pitch: 64, roll: 0,
      },
      modInput: {
        buttons: ["attack"],
        oldButtons: [
          ...BUTTON_NAMES, "bit26", "bit27", "bit28", "bit29", "bit30", "bit31",
        ],
        forward: 0, side: 0, up: 0, yaw: 0, pitch: 0, roll: 0,
      },
      refire: 2,
      weaponFlags: ["weaponready", "weaponswitchok", "refireswitchok"],
      pendingWeapon: null,
      psprites: [
        { layer: "weapon", sprite: "PISG", frame: "B", tics: 6, x: 0, y: 32, id: "Pistol.4", label: "Fire+1" },
        { layer: "flash", sprite: "PISF", frame: "A", tics: 7, x: 0, y: 32, id: "Pistol.9", label: "Flash" },
        { layer: "strifehands", sprite: "WAVE", frame: "A", tics: -1, x: 1.5, y: -2, id: "StrifeHands.0" },
        // A numeric-looking sprite stays a string; an unknown layer keeps its number.
        { layer: 2147483645, sprite: "0000", frame: "A", tics: 0, x: 0, y: 0 },
      ],
    });
    expect(a.inventory).toEqual([{ class: "Clip", amount: 50, maxAmount: 200 }]);
  });

  it("reads a pending weapon, none included", () => {
    const pending = (line: string) => parseActorState([line]).player?.pendingWeapon;
    expect(pending("weaponinfo refire=0 flags=0 pending=SuperShotgun")).toBe("SuperShotgun");
    expect(pending("weaponinfo refire=0 flags=0 pending=none")).toBe("none");
    expect(pending("weaponinfo refire=0 flags=0")).toBeNull();
  });

  it("leaves a non-player's player null and keeps a state id without a label", () => {
    const imp = parseActorState(["class DoomImp", "state TROO A 10", "stateid DoomImp.0"]);
    expect(imp.player).toBeNull();
    expect(imp.state).toEqual({ sprite: "TROO", frame: "A", tics: 10, id: "DoomImp.0" });
  });

  it("ignores a stateid with no state line or no id, and tolerates bare player lines", () => {
    expect(parseActorState(["stateid DoomImp.0 Spawn"]).state).toBeNull();
    expect(parseActorState(["state TROO A 10", "stateid"]).state).toEqual({ sprite: "TROO", frame: "A", tics: 10 });
    const bare = parseActorState(["input", "psprite"]).player;
    expect(bare?.input?.buttons).toEqual([]);
    expect(bare?.modInput).toBeNull();
    expect(bare?.refire).toBeNull();
    expect(bare?.psprites).toHaveLength(1);
  });
});

describe("bitNames", () => {
  it("names set bits in order and numbers unnamed ones", () => {
    expect(bitNames(0, BUTTON_NAMES)).toEqual([]);
    expect(bitNames((1 << 1) | (1 << 25) | (1 << 31), BUTTON_NAMES)).toEqual(["use", "run", "bit31"]);
    expect(bitNames((1 << 11) | (1 << 12), WEAPON_FLAG_NAMES)).toEqual(["user4ok", "bit12"]);
  });
});

describe("parseActorsNear", () => {
  it("parses nearby actors with their current sprite", () => {
    const out = [
      "MCP_ACTORS",
      "near DoomImp 60 100.0 200.0 TROO",
      "near Clip 0 -50.0 50.0 CLIP",
    ];
    expect(parseActorsNear(out)).toEqual([
      { class: "DoomImp", health: 60, x: 100, y: 200, sprite: "TROO" },
      { class: "Clip", health: 0, x: -50, y: 50, sprite: "CLIP" },
    ]);
  });
  it("ignores the header / non-matching lines", () => {
    expect(parseActorsNear(["MCP_ACTORS", "blah"])).toEqual([]);
  });
});

describe("filterFound", () => {
  // Engine order (nearest first): a live imp, a friendly marine, an imp corpse, a 0 hp imp
  // not yet a corpse, a flagless column and a row with no flags= at all.
  const found = parseFindActors([
    "MCP_FOUND",
    "found class=DoomImp tid=1 hp=60 dist=10.0 flags=mso",
    "found class=Marine tid=2 hp=100 dist=20.0 flags=mfso",
    "found class=DoomImp tid=3 hp=-5 dist=30.0 flags=mc",
    "found class=DoomImp tid=4 hp=0 dist=40.0 flags=ms",
    "found class=Column tid=5 hp=1000 dist=50.0 flags=-",
    "found class=Odd tid=6 dist=60.0",
  ]);
  const tids = (want: Record<string, boolean | undefined>, limit = 200) =>
    filterFound(found, want, limit).actors.map((a) => a.tid);

  it("names every flag letter", () => {
    expect(FLAG_NAMES).toEqual([
      "monster", "friendly", "corpse", "dormant", "shootable", "solid", "invulnerable", "ambush",
    ]);
  });

  it("keeps rows having every true key, in engine order", () => {
    expect(tids({ monster: true })).toEqual([1, 2, 3, 4]);
    expect(tids({ monster: true, solid: true })).toEqual([1, 2]);
    expect(tids({ corpse: true })).toEqual([3]);
  });

  it("drops rows having a false key, keeping flagless ones", () => {
    expect(tids({ monster: false })).toEqual([5, 6]);
    expect(tids({ monster: true, friendly: false })).toEqual([1, 3, 4]);
  });

  it("derives alive from hp > 0 and no corpse flag", () => {
    expect(tids({ alive: true })).toEqual([1, 2, 5]);
    expect(tids({ monster: true, alive: true })).toEqual([1, 2]);
    expect(tids({ monster: true, alive: false })).toEqual([3, 4]);
    // A corpse left with hp is still dead.
    const raised = parseFindActors(["found class=DoomImp tid=9 hp=60 flags=mc"]);
    expect(filterFound(raised, { alive: true }, 200).actors).toEqual([]);
  });

  it("ignores an unset key", () => {
    expect(tids({ monster: undefined })).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("cuts to the limit, counting the filtered rows", () => {
    const cut = filterFound(found, { monster: true }, 3);
    expect(cut.actors.map((a) => a.tid)).toEqual([1, 2, 3]);
    expect(cut.truncated).toEqual({ shown: 3, total: 4 });
  });

  it("leaves truncated unset when the limit doesn't cut", () => {
    expect(filterFound(found, { monster: true }, 4)).toEqual({ actors: found.actors.slice(0, 4) });
    expect(filterFound(found, { dormant: true }, 1)).toEqual({ actors: [] });
  });
});

describe("parseFoundReply", () => {
  it("parses a reply under its header and rejects an error line or a missing header", () => {
    expect(parseFoundReply(["MCP_FOUND", "found class=Imp tid=0"])?.actors).toEqual([{ class: "Imp", tid: 0 }]);
    expect(parseFoundReply(["MCP_FOUND", "error no level"])).toBeUndefined();
    expect(parseFoundReply(["Unknown command \"findactors\""])).toBeUndefined();
  });
});
