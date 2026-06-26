// Helpers to construct synthetic WAD buffers + binary map lumps for tests.

export interface LumpSpec {
  name: string;
  data?: Buffer;
}

export function buildWad(type: "IWAD" | "PWAD", lumps: LumpSpec[]): Buffer {
  const datas = lumps.map((l) => l.data ?? Buffer.alloc(0));
  const dir: Array<{ offset: number; size: number; name: string }> = [];
  let offset = 12;
  for (let i = 0; i < lumps.length; i++) {
    const d = datas[i];
    dir.push({ offset: d.length ? offset : 0, size: d.length, name: lumps[i].name });
    offset += d.length;
  }
  const header = Buffer.alloc(12);
  header.write(type, 0, "ascii");
  header.writeInt32LE(lumps.length, 4);
  header.writeInt32LE(offset, 8);
  const dirBuf = Buffer.alloc(lumps.length * 16);
  dir.forEach((e, i) => {
    const o = i * 16;
    dirBuf.writeInt32LE(e.offset, o);
    dirBuf.writeInt32LE(e.size, o + 4);
    dirBuf.write(e.name.slice(0, 8).padEnd(8, "\0"), o + 8, "ascii");
  });
  return Buffer.concat([header, ...datas, dirBuf]);
}

function writeName(buf: Buffer, off: number, name: string): void {
  buf.write(name.slice(0, 8).padEnd(8, "\0"), off, "ascii");
}

export interface SectorRow {
  floor: number; ceil: number; floorTex: string; ceilTex: string; light: number; special: number; tag: number;
}
export function sectorsLump(rows: SectorRow[]): Buffer {
  const buf = Buffer.alloc(rows.length * 26);
  rows.forEach((s, i) => {
    const o = i * 26;
    buf.writeInt16LE(s.floor, o);
    buf.writeInt16LE(s.ceil, o + 2);
    writeName(buf, o + 4, s.floorTex);
    writeName(buf, o + 12, s.ceilTex);
    buf.writeInt16LE(s.light, o + 20);
    buf.writeInt16LE(s.special, o + 22);
    buf.writeInt16LE(s.tag, o + 24);
  });
  return buf;
}

export interface DoomLineRow {
  v1: number; v2: number; flags: number; special: number; tag: number; front: number; back: number;
}
export function doomLinedefsLump(rows: DoomLineRow[]): Buffer {
  const buf = Buffer.alloc(rows.length * 14);
  rows.forEach((l, i) => {
    const o = i * 14;
    buf.writeUInt16LE(l.v1, o);
    buf.writeUInt16LE(l.v2, o + 2);
    buf.writeUInt16LE(l.flags, o + 4);
    buf.writeUInt16LE(l.special, o + 6);
    buf.writeUInt16LE(l.tag, o + 8);
    buf.writeUInt16LE(l.front, o + 10);
    buf.writeUInt16LE(l.back, o + 12);
  });
  return buf;
}

export interface HexenLineRow {
  v1: number; v2: number; flags: number; special: number; args: number[]; front: number; back: number;
}
export function hexenLinedefsLump(rows: HexenLineRow[]): Buffer {
  const buf = Buffer.alloc(rows.length * 16);
  rows.forEach((l, i) => {
    const o = i * 16;
    buf.writeUInt16LE(l.v1, o);
    buf.writeUInt16LE(l.v2, o + 2);
    buf.writeUInt16LE(l.flags, o + 4);
    buf.writeUInt8(l.special, o + 6);
    for (let a = 0; a < 5; a++) buf.writeUInt8(l.args[a] ?? 0, o + 7 + a);
    buf.writeUInt16LE(l.front, o + 12);
    buf.writeUInt16LE(l.back, o + 14);
  });
  return buf;
}

export interface SideRow {
  xOffset: number; yOffset: number; upper: string; lower: string; middle: string; sector: number;
}
export function sidedefsLump(rows: SideRow[]): Buffer {
  const buf = Buffer.alloc(rows.length * 30);
  rows.forEach((s, i) => {
    const o = i * 30;
    buf.writeInt16LE(s.xOffset, o);
    buf.writeInt16LE(s.yOffset, o + 2);
    writeName(buf, o + 4, s.upper);
    writeName(buf, o + 12, s.lower);
    writeName(buf, o + 20, s.middle);
    buf.writeUInt16LE(s.sector, o + 28);
  });
  return buf;
}

import { deflateRawSync } from "node:zlib";

/** Build a minimal valid ZIP (PK3) from named entries. method 8 deflates. */
export function buildZip(files: Array<{ name: string; data: Buffer; method?: number }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const method = f.method ?? 0;
    const compressed = method === 8 ? deflateRawSync(f.data) : f.data;
    const nameBuf = Buffer.from(f.name, "latin1");

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

export function vertexesLump(rows: Array<{ x: number; y: number }>): Buffer {
  const buf = Buffer.alloc(rows.length * 4);
  rows.forEach((v, i) => {
    const o = i * 4;
    buf.writeInt16LE(v.x, o);
    buf.writeInt16LE(v.y, o + 2);
  });
  return buf;
}
