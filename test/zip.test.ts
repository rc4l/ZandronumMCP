import { describe, it, expect } from "vitest";
import { isZip, listZipEntries, readZipEntry } from "../src/map/zip.js";
import { buildZip } from "./fakes/wad-builder.js";

describe("zip reader", () => {
  it("detects a zip by its signature", () => {
    expect(isZip(buildZip([{ name: "a.txt", data: Buffer.from("hi") }]))).toBe(true);
    expect(isZip(Buffer.from("IWAD"))).toBe(false);
  });

  it("lists entries and reads stored + deflated content", () => {
    const big = Buffer.from("x".repeat(500));
    const zip = buildZip([
      { name: "maps/MAP01.wad", data: Buffer.from("stored") },
      { name: "deflated.bin", data: big, method: 8 },
    ]);
    const entries = listZipEntries(zip);
    expect(entries.map((e) => e.name)).toEqual(["maps/MAP01.wad", "deflated.bin"]);
    expect(readZipEntry(zip, entries[0]).toString()).toBe("stored");
    expect(readZipEntry(zip, entries[1])).toEqual(big); // deflate round-trips
  });

  it("throws on a non-zip buffer", () => {
    expect(() => listZipEntries(Buffer.alloc(10))).toThrow(/no end-of-central-directory/);
  });

  it("rejects an unsupported compression method", () => {
    const zip = buildZip([{ name: "x", data: Buffer.from("y"), method: 99 }]);
    const entry = listZipEntries(zip)[0];
    expect(() => readZipEntry(zip, entry)).toThrow(/unsupported.*method/);
  });

  it("stops if the central directory has fewer entries than claimed", () => {
    const zip = buildZip([{ name: "a", data: Buffer.from("x") }]);
    zip.writeUInt16LE(2, zip.length - 22 + 10); // claim 2 entries, only 1 present
    expect(listZipEntries(zip)).toHaveLength(1);
  });

  it("throws on a corrupt local file header", () => {
    const zip = buildZip([{ name: "a", data: Buffer.from("x") }]);
    const entry = listZipEntries(zip)[0];
    zip.writeUInt32LE(0, entry.localOffset); // clobber the local signature
    expect(() => readZipEntry(zip, entry)).toThrow(/bad local file header/);
  });
});
