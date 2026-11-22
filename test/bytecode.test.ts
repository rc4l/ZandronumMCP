import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parseBehaviorNames, parseMapExports, isAcsObject, hasAcsMagic, parseLoadNames, missingImports } from "../src/acs/bytecode.js";
import {
  buildBehaviorAcse,
  buildBehaviorAcs0Enhanced,
  buildBehaviorAcs0Plain,
  buildBehaviorExports,
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
