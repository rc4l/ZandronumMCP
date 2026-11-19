import { describe, it, expect } from "vitest";
import { parseDumpActors } from "../src/parsers/dumpactors.js";
import { engineFixture } from "./fakes/fixtures.js";

const golden = (engineId: string) => engineFixture(engineId, "dumpactors.golden.txt");

// Each engine's golden, with its root Actor source and one game actor it must yield.
const engines = {
  zandronum: {
    root: "zandronum.pk3:actors/actor.txt",
    sample: {
      name: "ArtiBoostArmor",
      edNum: 8041,
      spawnId: 22,
      filter: "4:Hexen",
      source: "zandronum.pk3:actors/hexen/boostarmor.txt",
    },
  },
};

describe.each(Object.entries(engines))("parseDumpActors on the %s golden", (engineId, want) => {
  const fixture = golden(engineId);

  it("parses the real tab-delimited dumpactors rows", () => {
    const actors = parseDumpActors(fixture);
    expect(actors).toContainEqual({ name: "Actor", edNum: -1, spawnId: 0, filter: "0:All", source: want.root });
    expect(actors).toContainEqual(want.sample);
  });

  it("skips the count line, the header row and non-actor (n/a) rows", () => {
    const actors = parseDumpActors(fixture);
    expect(actors).toHaveLength(4);
    expect(actors.some((a) => a.name.includes("total"))).toBe(false);
    expect(actors.every((a) => Number.isInteger(a.edNum))).toBe(true);
  });

  it("handles output where multiple lines arrive in one chunk", () => {
    expect(parseDumpActors([fixture.join("\n")])).toHaveLength(4);
  });
});

describe("parseDumpActors", () => {
  it("drops UZDoom's n/a rows for non-actor classes", () => {
    const rows = ["ACSThinker\tn/a\tn/a\tn/a\tEngine (not an actor type)\tSource: None", "Actor\t-1\t0\t0:All\tuzdoom.pk3:zscript/actors/actor.zs"];
    expect(parseDumpActors(rows).map((a) => a.name)).toEqual(["Actor"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseDumpActors([])).toEqual([]);
  });
});
