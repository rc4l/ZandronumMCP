// Read function and named-script names out of a compiled ACS BEHAVIOR lump, for
// mods that ship bytecode but no source. Ports the engine's chunk logic
// (FBehavior load + FindChunk, p_acs.cpp): FNAM = function names, SNAM = named
// scripts. Numbered scripts have no names in bytecode (their source #define
// aliases are compiled away) — only the source indexer can recover those.

import { createHash } from "node:crypto";

const MAGIC_ACS0 = 0x00534341; // "ACS\0"
const MAGIC_ACSE = 0x45534341; // "ACSE"
const MAGIC_ACSe = 0x65534341; // "ACSe"

export interface BytecodeNames {
  functions: string[];
  namedScripts: string[];
}

/** `ACSE` (`#nocompact`: 4-byte opcodes and operands) or `ACSe` (compact). */
export type AcsFormat = "ACSE" | "ACSe";

export interface Chunk {
  id: string;
  offset: number;
  /** The size field: data bytes after the 8-byte header. */
  size: number;
}

export interface ChunkTable {
  format: AcsFormat;
  /** Where the chunks start, which is where the code ends. */
  start: number;
  /** Where the engine stops walking chunks (its DataSize). */
  end: number;
  chunks: Chunk[];
}

/** Where the chunk region lives + how far it runs. null if not chunked bytecode. */
function locateChunks(lump: Buffer): { offset: number; end: number; format: AcsFormat } | null {
  if (lump.length < 8) return null;
  const magic = lump.readUInt32LE(0);
  if (magic === MAGIC_ACSE || magic === MAGIC_ACSe) {
    return { offset: lump.readUInt32LE(4), end: lump.length, format: magic === MAGIC_ACSE ? "ACSE" : "ACSe" };
  }
  if (magic === MAGIC_ACS0) {
    // Old header may embed enhanced chunks: two DWORDs sit just before the
    // directory — [chunks offset][pretag]. (p_acs.cpp:2407-2419)
    const dirofs = lump.readUInt32LE(4);
    if (dirofs >= 24 && dirofs <= lump.length) {
      const pretag = lump.readUInt32LE(dirofs - 4);
      if (pretag === MAGIC_ACSE || pretag === MAGIC_ACSe) {
        return { offset: lump.readUInt32LE(dirofs - 8), end: dirofs - 8, format: pretag === MAGIC_ACSE ? "ACSE" : "ACSe" };
      }
    }
  }
  return null;
}

/** Every chunk ([id][size][data]) in file order, walked as FindChunk walks them; null if not chunked bytecode. */
export function chunkTable(lump: Buffer): ChunkTable | null {
  const region = locateChunks(lump);
  if (!region) return null;
  const chunks: Chunk[] = [];
  let o = region.offset;
  while (o + 8 <= region.end) {
    const size = lump.readUInt32LE(o + 4);
    chunks.push({ id: lump.toString("latin1", o, o + 4), offset: o, size });
    o += size + 8;
  }
  return { format: region.format, start: region.offset, end: region.end, chunks };
}

/** The first chunk with `id`, as FindChunk returns it; -1 if absent. */
function findChunk(table: ChunkTable, id: string): number {
  return table.chunks.find((c) => c.id === id)?.offset ?? -1;
}

/** A chunk's bytes, header included. */
export function chunkBytes(lump: Buffer, c: Chunk): Buffer {
  return lump.subarray(c.offset, c.offset + 8 + c.size);
}

/** A name chunk: [count][offset×count][nul-terminated strings], offsets relative to chunk+8. */
function readNameChunk(lump: Buffer, chunkStart: number): string[] {
  const base = chunkStart + 8;
  const count = lump.readUInt32LE(base);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const start = base + lump.readUInt32LE(base + 4 + i * 4);
    let end = start;
    while (end < lump.length && lump[end] !== 0) end++;
    names.push(lump.toString("latin1", start, end));
  }
  return names;
}

/** Extract function + named-script names from a BEHAVIOR lump buffer. */
export function parseBehaviorNames(lump: Buffer): BytecodeNames {
  const table = chunkTable(lump);
  if (!table) return { functions: [], namedScripts: [] };
  const fnam = findChunk(table, "FNAM");
  const snam = findChunk(table, "SNAM");
  return {
    functions: fnam >= 0 ? readNameChunk(lump, fnam) : [],
    namedScripts: snam >= 0 ? readNameChunk(lump, snam) : [],
  };
}

/** Whether a buffer starts with one of the ACS bytecode magics. */
export function hasAcsMagic(buf: Buffer): boolean {
  return buf.length >= 4 && [MAGIC_ACS0, MAGIC_ACSE, MAGIC_ACSe].includes(buf.readUInt32LE(0));
}

/** Whether a buffer is loadable ACS bytecode at all (FBehavior's magic + 32-byte floor). */
export function isAcsObject(lump: Buffer): boolean {
  return lump.length >= 32 && hasAcsMagic(lump);
}

/** Libraries an object imports: the LOAD chunk's NUL-separated names (p_acs.cpp, "Load required libraries"). */
export function parseLoadNames(lump: Buffer): string[] {
  const table = chunkTable(lump);
  if (!table) return [];
  const load = findChunk(table, "LOAD");
  if (load < 0) return [];
  const size = lump.readUInt32LE(load + 4);
  return lump.toString("latin1", load + 8, load + 8 + size).split("\0").filter((n) => n.length > 0);
}

/** The imports none of the `loaded` module names satisfies, matched as the engine does: 8-character lump names, case-insensitively. */
export function missingImports(imports: string[], loaded: string[]): string[] {
  const have = new Set(loaded.map((n) => n.toUpperCase()));
  return imports.filter((n) => !have.has(n.slice(0, 8).toUpperCase()));
}

export interface MapExport {
  name: string;
  /** Map variable slot; MEXP entry i names slot i (FindMapVarName, p_acs.cpp). */
  index: number;
  isArray: boolean;
  /** Element count, for arrays only. */
  size?: number;
}

/**
 * Exported map variables and arrays, the only names get_map_var/get_map_array can see:
 * MEXP is a name chunk, ARAY is [slot][size] pairs (p_acs.cpp, "Create arrays").
 */
export function parseMapExports(lump: Buffer): MapExport[] {
  const table = chunkTable(lump);
  if (!table) return [];
  const mexp = findChunk(table, "MEXP");
  if (mexp < 0) return [];
  const sizes = arraySizes(lump);
  return readNameChunk(lump, mexp).flatMap((name, index) => {
    if (!name) return [];
    const size = sizes.get(index);
    return [size === undefined ? { name, index, isArray: false } : { name, index, isArray: true, size }];
  });
}

/** Where each fixed-size entry of the first `id` chunk starts, walking only entries that fit in the lump. */
function fixedEntries(lump: Buffer, table: ChunkTable, id: string, width: number): number[] {
  const at = findChunk(table, id);
  if (at < 0) return [];
  const count = Math.floor(Math.min(lump.readUInt32LE(at + 4), lump.length - at - 8) / width);
  return Array.from({ length: count }, (_, i) => at + 8 + i * width);
}

export interface FunctionEntry {
  /** Code offset of the function's first instruction; 0 for an import. */
  address: number;
  importNum: number;
  /** FNAM names only public functions, the first FUNC entries; stored lowercased. */
  name?: string;
}

/** The FUNC chunk's entries ([argc][locals][hasReturn][importNum][address]), named from FNAM by index. */
export function functionEntries(lump: Buffer, table = chunkTable(lump)): FunctionEntry[] {
  if (!table) return [];
  const fnam = findChunk(table, "FNAM");
  const names = fnam >= 0 ? readNameChunk(lump, fnam) : [];
  return fixedEntries(lump, table, "FUNC", 8).map((at, i) => {
    const entry: FunctionEntry = { address: lump.readUInt32LE(at + 4), importNum: lump[at + 3] };
    return i < names.length ? { ...entry, name: names[i] } : entry;
  });
}

/** Map-var slot to array size for the module's own arrays: ARAY [slot][size] pairs (p_acs.cpp, "Create arrays"). */
export function arraySizes(lump: Buffer): Map<number, number> {
  const table = chunkTable(lump);
  if (!table) return new Map();
  return new Map(fixedEntries(lump, table, "ARAY", 8).map((at) => [lump.readUInt32LE(at), lump.readUInt32LE(at + 4)]));
}

/** An import chunk's [slot, name] entries (MIMP [slot][name\0]..., AIMP [count] then [slot][size][name\0]...), walked while they fit. */
function importEntries(lump: Buffer, c: Chunk): Array<[number, string]> {
  const data = lump.subarray(c.offset + 8, c.offset + 8 + c.size);
  const counted = c.id === "AIMP";
  const [first, head] = counted ? [4, 8] : [0, 4];
  const out: Array<[number, string]> = [];
  for (let at = first; at + head < data.length && (!counted || out.length < data.readUInt32LE(0)); ) {
    const nul = data.indexOf(0, at + head);
    const stop = nul < 0 ? data.length : nul;
    out.push([data.readUInt32LE(at), data.toString("latin1", at + head, stop)]);
    at = stop + 1;
  }
  return out;
}

/** Map-var slot to its MIMP/AIMP import name, which binds only if a loaded library has that name (p_acs.cpp "Resolve map variables"). */
export function importedSlots(lump: Buffer): Map<number, string> {
  const table = chunkTable(lump);
  const out = new Map<number, string>();
  for (const id of ["MIMP", "AIMP"]) {
    const c = table?.chunks.find((x) => x.id === id);
    if (c) for (const [slot, name] of importEntries(lump, c)) out.set(slot, name);
  }
  return out;
}

/** The chunks the image digest covers after the code, in this order (each id's chunks in file order). */
export const DIGEST_CHUNKS = ["ARAY", "AIMP", "MIMP", "MEXP", "MINI", "AINI", "LOAD"] as const;

/** What the `mcp_mapslot` CCMD matches a loaded module by (`v=1`). */
export interface ImageDigest {
  /** Header plus code: where the chunks start. */
  len: number;
  /** The first chunk's id as the engine sees it once loaded (`STRE` is renamed `STRL` in place). */
  first: string;
  /** MD5 of the first `len` bytes, then every DIGEST_CHUNKS chunk, header included. */
  md5: string;
}

/** The image digest of a compiled object, which a loaded module matches since the loader rewrites only string chunks in place. */
export function imageDigest(lump: Buffer): ImageDigest | { refused: string } {
  const table = chunkTable(lump);
  if (!table) return { refused: "it isn't chunked ACSE/ACSe bytecode" };
  const head = table.chunks[0]?.id ?? "";
  if (!/^[A-Za-z]{4}$/.test(head)) return { refused: `its first chunk id ${JSON.stringify(head)} isn't four ASCII letters` };
  const over = table.chunks.find((c) => c.offset + 8 + c.size > table.end);
  if (over) return { refused: `its ${over.id} chunk at ${over.offset} runs past the chunk region` };
  const md5 = createHash("md5").update(lump.subarray(0, table.start));
  for (const id of DIGEST_CHUNKS) {
    for (const c of table.chunks) if (c.id === id) md5.update(chunkBytes(lump, c));
  }
  return { len: table.start, first: head === "STRE" ? "STRL" : head, md5: md5.digest("hex") };
}
