export interface WadLump {
  name: string;
  offset: number;
  size: number;
}

export interface Wad {
  type: string;
  lumps: WadLump[];
}

function lumpName(buf: Buffer, off: number): string {
  return buf.toString("ascii", off, off + 8).replace(/\0.*$/, "");
}

/** Whether `buf` opens with a WAD identifier. */
export function isWad(buf: Buffer): boolean {
  const type = buf.toString("latin1", 0, 4);
  return type === "IWAD" || type === "PWAD";
}

/** Parse a WAD file's header + directory. Pure: operates on the whole buffer. */
export function parseWad(buf: Buffer): Wad {
  if (buf.length < 12) {
    throw new Error("not a WAD: file too short");
  }
  const type = buf.toString("ascii", 0, 4);
  if (!isWad(buf)) {
    throw new Error(`not a WAD: bad identifier ${JSON.stringify(type)}`);
  }
  const numLumps = buf.readInt32LE(4);
  const dirOffset = buf.readInt32LE(8);
  const lumps: WadLump[] = [];
  for (let i = 0; i < numLumps; i++) {
    const e = dirOffset + i * 16;
    lumps.push({
      offset: buf.readInt32LE(e),
      size: buf.readInt32LE(e + 4),
      name: lumpName(buf, e + 8),
    });
  }
  return { type, lumps };
}
