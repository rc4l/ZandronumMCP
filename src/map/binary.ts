// Parsers for the binary map lumps (Doom and Doom-in-Hexen formats). These
// formats are frozen, so this is maintain-once. Each returns an array of plain
// records keyed by index, matching the generic shape the UDMF parser produces.

export type MapEntity = Record<string, unknown>;

function name8(buf: Buffer, off: number): string {
  return buf.toString("ascii", off, off + 8).replace(/\0.*$/, "");
}

/** 0xFFFF means "no side"; normalize to -1. */
function side(v: number): number {
  return v === 0xffff ? -1 : v;
}

/** SECTORS: 26 bytes each. */
export function parseSectors(buf: Buffer): MapEntity[] {
  const out: MapEntity[] = [];
  const n = Math.floor(buf.length / 26);
  for (let i = 0; i < n; i++) {
    const o = i * 26;
    out.push({
      index: i,
      floorHeight: buf.readInt16LE(o),
      ceilingHeight: buf.readInt16LE(o + 2),
      floorTexture: name8(buf, o + 4),
      ceilingTexture: name8(buf, o + 12),
      light: buf.readInt16LE(o + 20),
      special: buf.readInt16LE(o + 22),
      tag: buf.readInt16LE(o + 24),
    });
  }
  return out;
}

/** LINEDEFS: Doom 14 bytes, Hexen 16 bytes (1-byte special + 5 arg bytes). */
export function parseLinedefs(buf: Buffer, hexen: boolean): MapEntity[] {
  const size = hexen ? 16 : 14;
  const out: MapEntity[] = [];
  const n = Math.floor(buf.length / size);
  for (let i = 0; i < n; i++) {
    const o = i * size;
    const base: MapEntity = {
      index: i,
      v1: buf.readUInt16LE(o),
      v2: buf.readUInt16LE(o + 2),
      flags: buf.readUInt16LE(o + 4),
    };
    if (hexen) {
      out.push({
        ...base,
        special: buf.readUInt8(o + 6),
        args: [
          buf.readUInt8(o + 7), buf.readUInt8(o + 8), buf.readUInt8(o + 9),
          buf.readUInt8(o + 10), buf.readUInt8(o + 11),
        ],
        front: side(buf.readUInt16LE(o + 12)),
        back: side(buf.readUInt16LE(o + 14)),
      });
    } else {
      out.push({
        ...base,
        special: buf.readUInt16LE(o + 6),
        tag: buf.readUInt16LE(o + 8),
        front: side(buf.readUInt16LE(o + 10)),
        back: side(buf.readUInt16LE(o + 12)),
      });
    }
  }
  return out;
}

/** SIDEDEFS: 30 bytes each. */
export function parseSidedefs(buf: Buffer): MapEntity[] {
  const out: MapEntity[] = [];
  const n = Math.floor(buf.length / 30);
  for (let i = 0; i < n; i++) {
    const o = i * 30;
    out.push({
      index: i,
      xOffset: buf.readInt16LE(o),
      yOffset: buf.readInt16LE(o + 2),
      upper: name8(buf, o + 4),
      lower: name8(buf, o + 12),
      middle: name8(buf, o + 20),
      sector: buf.readUInt16LE(o + 28),
    });
  }
  return out;
}

/** VERTEXES: 4 bytes each. */
export function parseVertexes(buf: Buffer): MapEntity[] {
  const out: MapEntity[] = [];
  const n = Math.floor(buf.length / 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    out.push({ index: i, x: buf.readInt16LE(o), y: buf.readInt16LE(o + 2) });
  }
  return out;
}
