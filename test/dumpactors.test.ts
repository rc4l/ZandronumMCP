import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDumpActors } from "../src/parsers/dumpactors.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/dumpactors.golden.txt", import.meta.url)),
  "utf8",
).split(/\r?\n/);

describe("parseDumpActors", () => {
  it("parses the real tab-delimited dumpactors rows", () => {
    const actors = parseDumpActors(fixture);
    expect(actors).toContainEqual({
      name: "Actor",
      edNum: -1,
      spawnId: 0,
      filter: "0:All",
      source: "zandronum.pk3:actors/actor.txt",
    });
    expect(actors).toContainEqual({
      name: "ArtiBoostArmor",
      edNum: 8041,
      spawnId: 22,
      filter: "4:Hexen",
      source: "zandronum.pk3:actors/hexen/boostarmor.txt",
    });
  });

  it("skips the count line and the header row", () => {
    const actors = parseDumpActors(fixture);
    expect(actors).toHaveLength(4);
    expect(actors.some((a) => a.name.includes("total"))).toBe(false);
    expect(actors.some((a) => a.edNum === Number.parseInt("Ed Num", 10))).toBe(false);
  });

  it("handles output where multiple lines arrive in one chunk", () => {
    const actors = parseDumpActors([fixture.join("\n")]);
    expect(actors).toHaveLength(4);
  });

  it("returns nothing for empty input", () => {
    expect(parseDumpActors([])).toEqual([]);
  });
});
