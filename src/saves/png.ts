// Zandronum/ZDoom savegames (.zds) are PNG files with metadata in tEXt chunks
// (g_game.cpp: M_AppendPNGText "Title"/"Current Map"/...). Read those chunks.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Parse a PNG's tEXt chunks into a keyword->text map. PNG is big-endian. */
export function parsePngText(buf: Buffer): Record<string, string> {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error("not a PNG (bad signature)");
  }
  const out: Record<string, string> = {};
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (type === "IEND") break;
    if (type === "tEXt") {
      const data = buf.subarray(off + 8, off + 8 + len);
      const nul = data.indexOf(0);
      if (nul >= 0) {
        out[data.toString("latin1", 0, nul)] = data.toString("latin1", nul + 1);
      }
    }
    off += 8 + len + 4; // type+len header is 8, then data, then 4-byte CRC
  }
  return out;
}

export interface SaveMeta {
  file: string;
  title: string | null;
  map: string | null;
  engine: string | null;
  gameWad: string | null;
  created: string | null;
}

/** Pull the save-relevant fields out of a .zds buffer. */
export function readSaveMeta(file: string, buf: Buffer): SaveMeta {
  const t = parsePngText(buf);
  return {
    file,
    title: t["Title"] ?? null,
    map: t["Current Map"] ?? null,
    engine: t["Engine"] ?? null,
    gameWad: t["Game WAD"] ?? null,
    created: t["Creation Time"] ?? null,
  };
}
