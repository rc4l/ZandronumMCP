import { describe, it, expect } from "vitest";
import { parsePngText, readSaveMeta } from "../src/saves/png.js";

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const b = Buffer.alloc(12 + data.length); // len(4) + type(4) + data + crc(4, left 0)
  b.writeUInt32BE(data.length, 0);
  b.write(type, 4, "latin1");
  data.copy(b, 8);
  return b;
}
function textChunk(key: string, val: string): Buffer {
  return chunk("tEXt", Buffer.concat([Buffer.from(key, "latin1"), Buffer.from([0]), Buffer.from(val, "latin1")]));
}
function buildPng(texts: Array<[string, string]>, opts: { pre?: Buffer[]; iend?: boolean } = {}): Buffer {
  const parts = [SIG, ...(opts.pre ?? []), ...texts.map(([k, v]) => textChunk(k, v))];
  if (opts.iend !== false) parts.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

describe("parsePngText", () => {
  it("reads tEXt chunks, skips other chunks, stops at IEND", () => {
    const png = buildPng(
      [
        ["Title", "My Save"],
        ["Current Map", "MAP07"],
      ],
      { pre: [chunk("IHDR", Buffer.alloc(13))] }, // a non-tEXt chunk to skip
    );
    expect(parsePngText(png)).toMatchObject({ Title: "My Save", "Current Map": "MAP07" });
  });

  it("ignores a malformed tEXt chunk with no null separator", () => {
    const png = buildPng([], { pre: [chunk("tEXt", Buffer.from("nonulhere", "latin1"))] });
    expect(parsePngText(png)).toEqual({});
  });

  it("handles a stream that ends without IEND", () => {
    const png = buildPng([["Title", "X"]], { iend: false });
    expect(parsePngText(png)).toEqual({ Title: "X" });
  });

  it("throws on a non-PNG buffer", () => {
    expect(() => parsePngText(Buffer.from("not a png"))).toThrow(/not a PNG/);
  });
});

describe("readSaveMeta", () => {
  it("extracts the save fields, nulling missing ones", () => {
    const png = buildPng([
      ["Title", "Quick Save"],
      ["Current Map", "E1M1"],
      ["Game WAD", "freedoom2.wad"],
    ]);
    expect(readSaveMeta("slot1.zds", png)).toEqual({
      file: "slot1.zds",
      title: "Quick Save",
      map: "E1M1",
      engine: null,
      gameWad: "freedoom2.wad",
      created: null,
    });
  });

  it("nulls the other fields when only engine/time are present", () => {
    const png = buildPng([
      ["Engine", "Zandronum 3.2"],
      ["Creation Time", "Mon Jun 23"],
    ]);
    expect(readSaveMeta("auto.zds", png)).toEqual({
      file: "auto.zds",
      title: null,
      map: null,
      engine: "Zandronum 3.2",
      gameWad: null,
      created: "Mon Jun 23",
    });
  });
});
