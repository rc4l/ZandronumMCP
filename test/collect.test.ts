import { describe, it, expect } from "vitest";
import { collectAcsLumps } from "../src/acs/collect.js";
import { parseBehaviorNames } from "../src/acs/bytecode.js";
import { buildWad, buildZip } from "./fakes/wad-builder.js";
import { buildBehaviorAcse } from "./fakes/acs-builder.js";

describe("collectAcsLumps", () => {
  it("finds BEHAVIOR lumps in a plain WAD", () => {
    const wad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "BEHAVIOR", data: buildBehaviorAcse(["wadFunc"], []) },
    ]);
    const lumps = collectAcsLumps(wad);
    expect(lumps).toHaveLength(1);
    expect(parseBehaviorNames(lumps[0]).functions).toEqual(["wadFunc"]);
  });

  it("accepts a raw compiled ACS lump (a .o file) directly", () => {
    const lib = buildBehaviorAcse(["rawFunc"], []);
    const lumps = collectAcsLumps(lib);
    expect(lumps).toHaveLength(1);
    expect(parseBehaviorNames(lumps[0]).functions).toEqual(["rawFunc"]);
  });

  it("finds compiled library lumps and map BEHAVIORs inside a PK3", () => {
    const innerWad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "BEHAVIOR", data: buildBehaviorAcse(["mapFunc"], []) },
    ]);
    const pk3 = buildZip([
      { name: "decorate.txt", data: Buffer.from("actor X {}") }, // ignored
      { name: "acs/lib.o", data: buildBehaviorAcse(["libFunc"], ["libScript"]), method: 8 },
      { name: "maps/MAP01.wad", data: innerWad },
    ]);
    const lumps = collectAcsLumps(pk3);
    const names = lumps.flatMap((l) => parseBehaviorNames(l).functions);
    expect(names).toContain("libFunc"); // compiled library
    expect(names).toContain("mapFunc"); // map BEHAVIOR inside the inner wad
    expect(lumps).toHaveLength(2);
  });
});
