import { describe, it, expect } from "vitest";
import { parseWad } from "../src/map/wad.js";
import { findMapLumps } from "../src/map/locate.js";
import { parseSectors, parseLinedefs, parseSidedefs, parseVertexes } from "../src/map/binary.js";
import { parseTextmap } from "../src/map/udmf.js";
import { readMap, readMapFromContainer } from "../src/map/index.js";
import {
  buildWad,
  buildZip,
  sectorsLump,
  doomLinedefsLump,
  hexenLinedefsLump,
  sidedefsLump,
  vertexesLump,
} from "./fakes/wad-builder.js";

describe("parseWad", () => {
  it("parses header and directory", () => {
    const wad = parseWad(buildWad("PWAD", [{ name: "MAP01" }, { name: "X", data: Buffer.from("hi") }]));
    expect(wad.type).toBe("PWAD");
    expect(wad.lumps.map((l) => l.name)).toEqual(["MAP01", "X"]);
    expect(wad.lumps[1].size).toBe(2);
  });

  it("rejects a too-short or non-WAD buffer", () => {
    expect(() => parseWad(Buffer.alloc(4))).toThrow(/too short/);
    const bad = buildWad("PWAD", []);
    bad.write("XWAD", 0, "ascii");
    expect(() => parseWad(bad)).toThrow(/bad identifier/);
  });
});

describe("findMapLumps", () => {
  const base = [
    { name: "MAP01" },
    { name: "THINGS", data: Buffer.alloc(0) },
    { name: "SECTORS", data: sectorsLump([]) },
  ];

  it("detects doom format and stops at a non-map lump", () => {
    const wad = parseWad(buildWad("PWAD", [...base, { name: "OTHER", data: Buffer.from("x") }]));
    const m = findMapLumps(wad, "map01");
    expect(m.format).toBe("doom");
    expect(Object.keys(m.lumps)).toEqual(["THINGS", "SECTORS"]);
  });

  it("detects hexen (BEHAVIOR) and udmf (TEXTMAP)", () => {
    const hexen = parseWad(buildWad("PWAD", [...base, { name: "BEHAVIOR", data: Buffer.alloc(0) }]));
    expect(findMapLumps(hexen, "MAP01").format).toBe("hexen");
    const udmf = parseWad(buildWad("PWAD", [{ name: "MAP01" }, { name: "TEXTMAP", data: Buffer.alloc(0) }]));
    expect(findMapLumps(udmf, "MAP01").format).toBe("udmf");
  });

  it("throws when the map is absent", () => {
    const wad = parseWad(buildWad("PWAD", [{ name: "MAP02" }]));
    expect(() => findMapLumps(wad, "MAP01")).toThrow(/not found/);
  });
});

describe("binary parsers", () => {
  it("parses sectors", () => {
    const buf = sectorsLump([
      { floor: 0, ceil: 128, floorTex: "FLOOR4_8", ceilTex: "CEIL3_5", light: 192, special: 0, tag: 0 },
      { floor: -32, ceil: 96, floorTex: "NUKAGE1", ceilTex: "F_SKY1", light: 160, special: 9, tag: 12 },
    ]);
    expect(parseSectors(buf)).toEqual([
      { index: 0, floorHeight: 0, ceilingHeight: 128, floorTexture: "FLOOR4_8", ceilingTexture: "CEIL3_5", light: 192, special: 0, tag: 0 },
      { index: 1, floorHeight: -32, ceilingHeight: 96, floorTexture: "NUKAGE1", ceilingTexture: "F_SKY1", light: 160, special: 9, tag: 12 },
    ]);
  });

  it("parses doom linedefs with a missing back side", () => {
    const buf = doomLinedefsLump([{ v1: 0, v2: 1, flags: 1, special: 0, tag: 0, front: 0, back: 0xffff }]);
    expect(parseLinedefs(buf, false)).toEqual([
      { index: 0, v1: 0, v2: 1, flags: 1, special: 0, tag: 0, front: 0, back: -1 },
    ]);
  });

  it("parses hexen linedefs with args", () => {
    const buf = hexenLinedefsLump([{ v1: 2, v2: 3, flags: 0, special: 13, args: [5, 0, 0, 0, 0], front: 1, back: 2 }]);
    expect(parseLinedefs(buf, true)).toEqual([
      { index: 0, v1: 2, v2: 3, flags: 0, special: 13, args: [5, 0, 0, 0, 0], front: 1, back: 2 },
    ]);
  });

  it("parses sidedefs and vertexes", () => {
    expect(parseSidedefs(sidedefsLump([{ xOffset: 16, yOffset: -8, upper: "BIGDOOR2", lower: "-", middle: "STARTAN3", sector: 0 }]))).toEqual([
      { index: 0, xOffset: 16, yOffset: -8, upper: "BIGDOOR2", lower: "-", middle: "STARTAN3", sector: 0 },
    ]);
    expect(parseVertexes(vertexesLump([{ x: 64, y: -64 }]))).toEqual([{ index: 0, x: 64, y: -64 }]);
  });
});

describe("parseTextmap", () => {
  const text = `
    namespace = "zdoom"; // a comment
    /* block comment */
    vertex { x = 0.0; y = 0.0; }
    sidedef { sector = 0; texturemiddle = "STARTAN3"; }
    linedef { v1 = 0; v2 = 1; special = 13; arg0 = 5; }
    sector { heightfloor = 0; texturefloor = "FLOOR4_8"; lightlevel = 192; blockmonsters = true; secret = false; user_mood = "happy"; weird = foo; }
    thing { x = 0.0; y = 0.0; type = 1; }
    foobar { ignored = 1; }
  `;

  it("parses every block kind generically with typed values", () => {
    const map = parseTextmap(text);
    expect(map.namespace).toBe("zdoom");
    expect(map.vertices).toHaveLength(1);
    expect(map.linedefs[0]).toMatchObject({ index: 0, v1: 0, special: 13, arg0: 5 });
    expect(map.sectors[0]).toMatchObject({
      heightfloor: 0,
      texturefloor: "FLOOR4_8",
      lightlevel: 192,
      blockmonsters: true,
      secret: false,
      user_mood: "happy",
      weird: "foo",
    });
  });

  it("parses things, ignores unknown block kinds, and works without a namespace", () => {
    const map = parseTextmap(text);
    expect(map.things).toHaveLength(1);
    expect(map.things[0]).toMatchObject({ type: 1 });
    const all = [...map.vertices, ...map.linedefs, ...map.sidedefs, ...map.sectors, ...map.things];
    expect(all.some((e) => "ignored" in e)).toBe(false); // 'foobar' dropped
    expect(parseTextmap("sector { x = 1; }").namespace).toBe("");
  });
});

describe("readMap", () => {
  const doomLumps = [
    { name: "MAP01" },
    { name: "VERTEXES", data: vertexesLump([{ x: 0, y: 0 }]) },
    { name: "SIDEDEFS", data: sidedefsLump([{ xOffset: 0, yOffset: 0, upper: "-", lower: "-", middle: "STARTAN3", sector: 0 }]) },
    { name: "LINEDEFS", data: doomLinedefsLump([{ v1: 0, v2: 1, flags: 0, special: 0, tag: 0, front: 0, back: 0xffff }]) },
    { name: "SECTORS", data: sectorsLump([{ floor: 0, ceil: 128, floorTex: "F", ceilTex: "C", light: 160, special: 0, tag: 7 }]) },
  ];

  it("reads a full Doom map", () => {
    const data = readMap(buildWad("PWAD", doomLumps), "MAP01");
    expect(data.format).toBe("doom");
    expect(data.sectors[0]).toMatchObject({ tag: 7, light: 160 });
    expect(data.linedefs[0].back).toBe(-1);
    expect(data.sidedefs[0].middle).toBe("STARTAN3");
    expect(data.vertices).toHaveLength(1);
  });

  it("returns empty arrays when geometry lumps are missing", () => {
    const data = readMap(buildWad("PWAD", [{ name: "MAP01" }, { name: "THINGS", data: Buffer.alloc(0) }]), "MAP01");
    expect(data.format).toBe("doom");
    expect(data).toMatchObject({ sectors: [], linedefs: [], sidedefs: [], vertices: [] });
  });

  it("reads a hexen map", () => {
    const data = readMap(
      buildWad("PWAD", [
        { name: "MAP01" },
        { name: "LINEDEFS", data: hexenLinedefsLump([{ v1: 0, v2: 1, flags: 0, special: 80, args: [1, 2, 3, 4, 5], front: 0, back: 1 }]) },
        { name: "BEHAVIOR", data: Buffer.alloc(0) },
      ]),
      "MAP01",
    );
    expect(data.format).toBe("hexen");
    expect(data.linedefs[0]).toMatchObject({ special: 80, args: [1, 2, 3, 4, 5] });
  });

  it("reads a UDMF map", () => {
    const textmap = Buffer.from('namespace = "zdoom"; sector { lightlevel = 200; id = 5; }', "ascii");
    const data = readMap(buildWad("PWAD", [{ name: "MAP01" }, { name: "TEXTMAP", data: textmap }]), "MAP01");
    expect(data.format).toBe("udmf");
    expect(data.sectors[0]).toMatchObject({ lightlevel: 200, id: 5 });
  });
});

describe("readMapFromContainer", () => {
  const wad = () =>
    buildWad("PWAD", [
      { name: "MAP01" },
      { name: "SECTORS", data: sectorsLump([{ floor: 0, ceil: 128, floorTex: "F", ceilTex: "C", light: 160, special: 0, tag: 7 }]) },
    ]);

  it("passes a plain WAD straight through", () => {
    expect(readMapFromContainer(wad(), "MAP01").sectors[0]).toMatchObject({ tag: 7 });
  });

  it("extracts maps/<name>.wad from a PK3 (zip) and reads it", () => {
    const pk3 = buildZip([
      { name: "decorate.txt", data: Buffer.from("// stuff") },
      { name: "maps/MAP01.wad", data: wad(), method: 8 },
    ]);
    const data = readMapFromContainer(pk3, "MAP01");
    expect(data.format).toBe("doom");
    expect(data.sectors[0]).toMatchObject({ tag: 7 });
  });

  it("throws if the map is not in the archive", () => {
    const pk3 = buildZip([{ name: "maps/OTHER.wad", data: wad() }]);
    expect(() => readMapFromContainer(pk3, "MAP01")).toThrow(/not found in archive/);
  });
});
