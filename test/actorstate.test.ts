import { describe, it, expect } from "vitest";
import { parseActorState, parseActorsNear } from "../src/parsers/actorstate.js";

describe("parseActorState", () => {
  const out = [
    "MCP_ACTOR",
    "class DoomPlayer",
    "health 100",
    "pos -3040.0 -3744.0 16.0",
    "angle 178.9",
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
    // bare lines (no value) -> null
    const bare = parseActorState(["class", "weapon"]);
    expect(bare.class).toBeNull();
    expect(bare.weapon).toBeNull();
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
