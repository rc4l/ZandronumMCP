import path from "node:path";
import { isWad, parseWad } from "../map/wad.js";
import { isZip, listZipEntries, readZipEntry } from "../map/zip.js";
import { hasAcsMagic } from "./bytecode.js";

export interface AcsModule {
  /** Zip entry name, `<wad>:<map marker>` for a map BEHAVIOR, or the caller's raw-file name. */
  name: string;
  data: Buffer;
  /** The map marker, set only for a map's BEHAVIOR lump. */
  map?: string;
}

// A map's marker is the lump right before its THINGS (binary) or TEXTMAP (UDMF).
const MAP_FIRST_LUMPS = new Set(["THINGS", "TEXTMAP"]);

function behaviorModules(wadBuf: Buffer, prefix: string): AcsModule[] {
  const lumps = parseWad(wadBuf).lumps;
  const out: AcsModule[] = [];
  let marker = "BEHAVIOR";
  lumps.forEach((l, i) => {
    if (MAP_FIRST_LUMPS.has(lumps[i + 1]?.name ?? ""))marker = l.name;
    if (l.name === "BEHAVIOR" && l.size > 0) {
      out.push({ name: prefix + marker, data: wadBuf.subarray(l.offset, l.offset + l.size), map: marker });
    }
  });
  return out;
}

/**
 * Collect every compiled ACS bytecode lump in a WAD or PK3, with a name for each:
 * compiled `#library` lumps (a zip entry that is itself ACS bytecode) plus the
 * BEHAVIOR lump of each contained map WAD. This is what lets bytecode reading
 * work on a source-less mod, where the scripts live in a compiled library.
 */
export function collectAcsModules(buffer: Buffer, rawName = "BEHAVIOR"): AcsModule[] {
  if (hasAcsMagic(buffer)) return [{ name: rawName, data: buffer }]; // a raw compiled .o / BEHAVIOR file
  if (!isZip(buffer)) return behaviorModules(buffer, "");
  return listZipEntries(buffer).flatMap((entry) => entryModules(entry.name, readZipEntry(buffer, entry)));
}

const isWadName = (name: string) => name.toLowerCase().endsWith(".wad");

/** A container entry's modules: itself if it is bytecode, else its maps' BEHAVIOR lumps if it is a WAD. */
function entryModules(name: string, data: Buffer): AcsModule[] {
  if (hasAcsMagic(data)) return [{ name, data }];
  return isWadName(name) ? behaviorModules(data, `${name}:`) : [];
}

/** `entryModules` for a walked file, read whole only if it could hold any: a WAD by name, else bytecode by its magic. */
function fileModules(name: string, file: string, io: CollectIo): AcsModule[] {
  if (!isWadName(name) && !hasAcsMagic(io.readHeadSync(file, 4))) return [];
  return entryModules(name, io.readFileSync(file));
}

/** What `collectAcsModulesAt` reads through (a subset of the tools' ContextIo). */
export interface CollectIo {
  readFileSync: (p: string) => Buffer;
  /** Up to the first `bytes` bytes of a file (fewer if it is shorter). */
  readHeadSync: (p: string, bytes: number) => Buffer;
  readdirSync: (p: string) => string[];
  isDirSync: (p: string) => boolean;
  realpathSync: (p: string) => string;
}

/** The launch files `collectAcsModulesAt` finds modules in. */
export const ACS_CONTAINERS = "WADs, PK3/zips, directories and raw ACS objects";

/** Whether the engine's walk of a -file directory leaves out an entry, by its own name (the adapter's `dirWalkSkips`). */
export type DirWalkSkips = (name: string, isDir: boolean) => boolean;

/** `collectAcsModules` for a -file path, where a directory loads like a PK3 of its files (relative `/` paths, sorted, minus `skips`). */
export function collectAcsModulesAt(file: string, io: CollectIo, skips: DirWalkSkips): AcsModule[] {
  if (!io.isDirSync(file)) {
    const buf = io.readFileSync(file);
    return isWad(buf) || isZip(buf) || hasAcsMagic(buf) ? collectAcsModules(buf, path.basename(file)) : [];
  }
  // Like fts's FTS_LOGICAL, cuts only a symlink back into a parent dir, so a sibling link to a dir walks it again.
  const walk = (dir: string, prefix: string, parents: string[]): AcsModule[] => {
    const real = io.realpathSync(dir);
    if (parents.includes(real)) return [];
    const chain = [...parents, real];
    return [...io.readdirSync(dir)].sort().flatMap((name) => {
      const full = path.join(dir, name);
      const isDir = io.isDirSync(full);
      if (skips(name, isDir)) return [];
      return isDir ? walk(full, `${prefix}${name}/`, chain) : fileModules(prefix + name, full, io);
    });
  };
  return walk(file, "", []);
}

/** The modules whose name or extension-less basename is `lump` (a BEHAVIOR also by `behavior` or its map, case-insensitive), or all. */
export function pickModules(modules: AcsModule[], lump?: string): AcsModule[] {
  const want = lump?.toLowerCase();
  return modules.filter((m) => {
    const full = m.name.toLowerCase();
    const keys = [full, path.basename(full).replace(/\.[^.]*$/, "")];
    if (m.map) keys.push("behavior", m.map.toLowerCase());
    return !want || keys.includes(want);
  });
}

/** Just the bytecode buffers of `collectAcsModules`, for callers that pool names across modules. */
export function collectAcsLumps(buffer: Buffer): Buffer[] {
  return collectAcsModules(buffer).map((m) => m.data);
}
