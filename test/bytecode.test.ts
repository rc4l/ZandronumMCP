import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseBehaviorNames, parseMapExports, isAcsObject, hasAcsMagic, parseLoadNames, missingImports, chunkTable, functionEntries, arraySizes, importedSlots } from "../src/acs/bytecode.js";
import {
  buildBehaviorAcse,
  buildBehaviorAcs0Enhanced,
  buildBehaviorAcs0Plain,
  buildBehaviorExports,
  buildObject,
  chunk,
  funcChunk,
  nameChunk,
  u32,
} from "./fakes/acs-builder.js";

describe("parseBehaviorNames", () => {
  it("reads FNAM + SNAM from the direct ACSE format", () => {
    const lump = buildBehaviorAcse(["GiveCredits", "ResetTeam"], ["OpenDoor"]);
    expect(parseBehaviorNames(lump)).toEqual({
      functions: ["GiveCredits", "ResetTeam"],
      namedScripts: ["OpenDoor"],
    });
  });

  it("reads names from the old ACS0 header with embedded enhanced chunks", () => {
    const lump = buildBehaviorAcs0Enhanced(["foo"], ["bar", "baz"]);
    expect(parseBehaviorNames(lump)).toEqual({
      functions: ["foo"],
      namedScripts: ["bar", "baz"],
    });
  });

  it("returns empty for pure ACS0 (no name chunks)", () => {
    expect(parseBehaviorNames(buildBehaviorAcs0Plain())).toEqual({ functions: [], namedScripts: [] });
  });

  it("returns empty when ACSE has no FNAM/SNAM chunks", () => {
    const header = Buffer.alloc(8);
    header.write("ACSE", 0, "latin1");
    header.writeUInt32LE(8, 4); // chunks region is empty (offset == length)
    expect(parseBehaviorNames(header)).toEqual({ functions: [], namedScripts: [] });
  });

  it("returns empty for an ACS0 header whose pretag isn't enhanced", () => {
    const buf = Buffer.alloc(40);
    buf.write("ACS\0", 0, "latin1");
    buf.writeUInt32LE(28, 4); // dirofs >= 24, but bytes at 24 aren't 'ACSE'
    expect(parseBehaviorNames(buf)).toEqual({ functions: [], namedScripts: [] });
  });

  it("returns empty for non-ACS or too-short buffers", () => {
    expect(parseBehaviorNames(Buffer.from("PWAD"))).toEqual({ functions: [], namedScripts: [] });
    expect(parseBehaviorNames(Buffer.alloc(2))).toEqual({ functions: [], namedScripts: [] });
  });
});

describe("parseMapExports", () => {
  it("names each exported slot and sizes the ones ARAY marks as arrays", () => {
    const lump = buildBehaviorExports(["credits", "", "round"], [{ index: 0, size: 17 }]);
    expect(parseMapExports(lump)).toEqual([
      { name: "credits", index: 0, isArray: true, size: 17 },
      { name: "round", index: 2, isArray: false },
    ]);
  });

  it("treats every export as a scalar when there is no ARAY chunk", () => {
    expect(parseMapExports(buildBehaviorExports(["a"]))).toEqual([{ name: "a", index: 0, isArray: false }]);
  });

  it("reads only the ARAY pairs actually present when its size overstates them", () => {
    const lump = buildBehaviorExports(["credits"], [{ index: 0, size: 17 }]);
    lump.writeUInt32LE(0xffff, lump.indexOf("ARAY") + 4);
    expect(parseMapExports(lump)).toEqual([{ name: "credits", index: 0, isArray: true, size: 17 }]);
  });

  it("returns empty without an MEXP chunk or chunked bytecode", () => {
    expect(parseMapExports(buildBehaviorAcse(["f"], []))).toEqual([]);
    expect(parseMapExports(buildBehaviorAcs0Plain())).toEqual([]);
  });
});

describe("chunkTable / functionEntries / arraySizes / importedSlots", () => {
  const aimp = (count: number, ...entries: Array<[number, number, string]>) =>
    chunk("AIMP", Buffer.concat([u32(count), ...entries.map(([slot, size, name]) => Buffer.concat([u32(slot, size), Buffer.from(`${name}\0`)]))]));
  const mimp = (...entries: Array<[number, string]>) =>
    chunk("MIMP", Buffer.concat(entries.map(([slot, name]) => Buffer.concat([u32(slot), Buffer.from(`${name}\0`)]))));

  it("lists every chunk in file order with the format, chunk start and walk end", () => {
    const obj = buildObject({ format: "ACSE", code: u32(1), chunks: [chunk("MINI", u32(3, 1)), chunk("ALIB", Buffer.alloc(0))] });
    expect(chunkTable(obj)).toEqual({
      format: "ACSE",
      start: 12,
      end: 12 + 16 + 8,
      chunks: [
        { id: "MINI", offset: 12, size: 8 },
        { id: "ALIB", offset: 28, size: 0 },
      ],
    });
    expect(chunkTable(buildBehaviorAcs0Plain())).toBeNull();
  });

  it("names the FUNC entries FNAM covers, by index", () => {
    const obj = buildObject({ chunks: [funcChunk([40, 52]), nameChunk("FNAM", ["pub"])] });
    expect(functionEntries(obj)).toEqual([
      { address: 40, importNum: 0, name: "pub" },
      { address: 52, importNum: 0 },
    ]);
    expect(functionEntries(buildObject({ chunks: [funcChunk([40])] }))).toEqual([{ address: 40, importNum: 0 }]);
    expect(functionEntries(buildBehaviorAcs0Plain())).toEqual([]);
  });

  it("sizes the module's own arrays (ARAY), not the ones it imports (AIMP)", () => {
    const obj = buildObject({ chunks: [chunk("ARAY", u32(0, 4)), aimp(2, [5, 10, "lib_a"], [7, 3, "b"])] });
    expect(arraySizes(obj)).toEqual(new Map([[0, 4]]));
    expect(arraySizes(buildBehaviorAcs0Plain())).toEqual(new Map());
  });

  it("names each imported slot, scalars (MIMP) and arrays (AIMP), from the first chunk of each", () => {
    const obj = buildObject({ chunks: [mimp([1, "lv"], [4, "w"]), chunk("ARAY", u32(0, 4)), aimp(2, [5, 10, "lib_a"], [7, 3, "b"]), mimp([9, "late"])] });
    expect(importedSlots(obj)).toEqual(new Map([[1, "lv"], [4, "w"], [5, "lib_a"], [7, "b"]]));
    expect(importedSlots(buildObject({ chunks: [chunk("ARAY", u32(0, 4))] }))).toEqual(new Map());
    expect(importedSlots(buildBehaviorAcs0Plain())).toEqual(new Map());
  });

  it("stops at AIMP's count or a chunk's end, whichever comes first", () => {
    expect(importedSlots(buildObject({ chunks: [aimp(1, [5, 10, "a"], [7, 3, "b"])] }))).toEqual(new Map([[5, "a"]]));
    expect(importedSlots(buildObject({ chunks: [aimp(9, [5, 10, "a"])] }))).toEqual(new Map([[5, "a"]]));
    const empty = [chunk("AIMP", Buffer.alloc(0)), chunk("MIMP", Buffer.alloc(0)), chunk("MINI", u32(3, 1))];
    expect(importedSlots(buildObject({ chunks: empty }))).toEqual(new Map());
    // A name without its NUL runs to the end of the chunk; a slot with no name byte after it isn't an entry.
    const cut = buildObject({ indirect: false, chunks: [chunk("AIMP", Buffer.concat([u32(2, 5, 10), Buffer.from("ab")]))] });
    expect(importedSlots(cut)).toEqual(new Map([[5, "ab"]]));
    expect(importedSlots(buildObject({ chunks: [chunk("MIMP", Buffer.concat([u32(1), Buffer.from("x\0"), u32(2)]))] }))).toEqual(new Map([[1, "x"]]));
    // A size past the lump reads only what the lump holds.
    const over = buildObject({ indirect: false, chunks: [chunk("MIMP", Buffer.concat([u32(1), Buffer.from("x")]))] });
    over.writeUInt32LE(99, 12);
    expect(importedSlots(over)).toEqual(new Map([[1, "x"]]));
  });
});

describe("isAcsObject / parseLoadNames", () => {
  // Real zt-bcc output: a #library snippet that #imports "mcplib".
  const imp = readFileSync(new URL("./fixtures/runacs-import.o", import.meta.url));

  it("reads a real object's LOAD chunk", () => {
    expect(isAcsObject(imp)).toBe(true);
    expect(parseLoadNames(imp)).toEqual(["mcplib"]);
  });

  it("finds no imports without a LOAD chunk or chunk region", () => {
    expect(parseLoadNames(buildBehaviorAcse(["f"], []))).toEqual([]);
    expect(parseLoadNames(buildBehaviorAcs0Plain())).toEqual([]);
  });

  it("rejects anything the engine's magic check would", () => {
    expect(isAcsObject(Buffer.from("script 1 (void) {}  padding to 32 bytes"))).toBe(false);
    expect(isAcsObject(Buffer.from("ACS"))).toBe(false);
    const bad = Buffer.from(imp);
    bad[3] = 0x58;
    expect(isAcsObject(bad)).toBe(false);
    expect(isAcsObject(buildBehaviorAcse([], []))).toBe(true);
  });
});

describe("hasAcsMagic / missingImports", () => {
  it("knows the three magics, however short the rest is", () => {
    for (const magic of ["ACS\0", "ACSE", "ACSe"]) expect(hasAcsMagic(Buffer.from(magic, "latin1"))).toBe(true);
    expect(hasAcsMagic(Buffer.from("ACSX"))).toBe(false);
    expect(hasAcsMagic(Buffer.from("ACS"))).toBe(false);
  });

  it("matches imports on the first 8 characters, case-insensitively", () => {
    expect(missingImports(["mcplib", "LongLibraryName"], ["MCPLIB", "LONGLIBR"])).toEqual([]);
    expect(missingImports(["mcplib", "other"], ["MCPLIB"])).toEqual(["other"]);
    expect(missingImports(["LongLibraryName"], ["LONGLIBRARYNAME"])).toEqual(["LongLibraryName"]);
  });
});
