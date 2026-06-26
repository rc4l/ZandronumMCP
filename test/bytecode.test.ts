import { describe, it, expect } from "vitest";
import { parseBehaviorNames } from "../src/acs/bytecode.js";
import {
  buildBehaviorAcse,
  buildBehaviorAcs0Enhanced,
  buildBehaviorAcs0Plain,
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
