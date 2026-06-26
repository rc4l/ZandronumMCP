import { inflateRawSync } from "node:zlib";

// Minimal ZIP reader for PK3/PK7 archives (which are plain zips). Enough to list
// entries and extract one — stored (method 0) or deflated (method 8, via Node's
// built-in zlib). No CRC validation; we only read.

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** A buffer is a zip if it begins with a local-file-header signature ("PK\x03\x04"). */
export function isZip(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === LOCAL_SIG;
}

/** Parse the central directory into entries. */
export function listZipEntries(buf: Buffer): ZipEntry[] {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip: no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CENTRAL_SIG) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    entries.push({
      method: buf.readUInt16LE(off + 10),
      compressedSize: buf.readUInt32LE(off + 20),
      size: buf.readUInt32LE(off + 24),
      localOffset: buf.readUInt32LE(off + 42),
      name: buf.toString("latin1", off + 46, off + 46 + nameLen),
    });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one entry's uncompressed bytes. */
export function readZipEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lo = entry.localOffset;
  if (buf.readUInt32LE(lo) !== LOCAL_SIG) throw new Error("bad local file header");
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`unsupported zip compression method ${entry.method}`);
}
