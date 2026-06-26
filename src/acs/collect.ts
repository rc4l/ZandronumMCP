import { parseWad } from "../map/wad.js";
import { isZip, listZipEntries, readZipEntry } from "../map/zip.js";

// ACS bytecode magics: "ACS\0", "ACSE", "ACSe".
const ACS_MAGICS = new Set([0x00534341, 0x45534341, 0x65534341]);

function looksLikeAcs(buf: Buffer): boolean {
  return buf.length >= 4 && ACS_MAGICS.has(buf.readUInt32LE(0));
}

function behaviorLumps(wadBuf: Buffer): Buffer[] {
  return parseWad(wadBuf)
    .lumps.filter((l) => l.name === "BEHAVIOR" && l.size > 0)
    .map((l) => wadBuf.subarray(l.offset, l.offset + l.size));
}

/**
 * Collect every compiled ACS bytecode lump in a WAD or PK3: compiled `#library`
 * lumps (a zip entry that is itself ACS bytecode) plus the BEHAVIOR lump of each
 * contained map WAD. This is what lets bytecode name-reading work on a
 * source-less mod, where the scripts live in a compiled library.
 */
export function collectAcsLumps(buffer: Buffer): Buffer[] {
  if (looksLikeAcs(buffer)) return [buffer]; // a raw compiled .o / BEHAVIOR file
  if (!isZip(buffer)) return behaviorLumps(buffer);
  const out: Buffer[] = [];
  for (const entry of listZipEntries(buffer)) {
    const data = readZipEntry(buffer, entry);
    if (looksLikeAcs(data)) out.push(data);
    else if (entry.name.toLowerCase().endsWith(".wad")) out.push(...behaviorLumps(data));
  }
  return out;
}
