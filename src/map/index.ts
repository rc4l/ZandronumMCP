import { parseWad } from "./wad.js";
import { findMapLumps, type MapFormat } from "./locate.js";
import { parseSectors, parseLinedefs, parseSidedefs, parseVertexes, type MapEntity } from "./binary.js";
import { parseTextmap } from "./udmf.js";
import { isZip, listZipEntries, readZipEntry } from "./zip.js";

export type { MapFormat } from "./locate.js";
export type { MapEntity } from "./binary.js";

export interface MapData {
  format: MapFormat;
  sectors: MapEntity[];
  linedefs: MapEntity[];
  sidedefs: MapEntity[];
  vertices: MapEntity[];
}

/**
 * Read a map out of a WAD buffer into structured, indexable data. Pure: the
 * server reads the file and caches the result, then serves targeted queries so
 * even slaughtermaps never ship in full.
 */
/**
 * Read a map from a WAD buffer, or from a PK3/PK7 archive (a zip) that holds the
 * map as `maps/<name>.wad`. Handles either container; the map format
 * (doom/hexen/udmf) inside is detected the same way.
 */
export function readMapFromContainer(buffer: Buffer, mapName: string): MapData {
  if (isZip(buffer)) {
    const target = `maps/${mapName}.wad`.toLowerCase();
    const entry = listZipEntries(buffer).find((e) => e.name.toLowerCase() === target);
    if (!entry) {
      throw new Error(`map ${mapName} not found in archive (looked for ${target})`);
    }
    return readMap(readZipEntry(buffer, entry), mapName);
  }
  return readMap(buffer, mapName);
}

export function readMap(wadBuffer: Buffer, mapName: string): MapData {
  const wad = parseWad(wadBuffer);
  const { format, lumps } = findMapLumps(wad, mapName);
  const slice = (name: string): Buffer | null => {
    const l = lumps[name];
    return l ? wadBuffer.subarray(l.offset, l.offset + l.size) : null;
  };

  if (format === "udmf") {
    // format === "udmf" guarantees a TEXTMAP lump (that's how it's detected).
    const tm = parseTextmap(slice("TEXTMAP")!.toString("ascii"));
    return { format, sectors: tm.sectors, linedefs: tm.linedefs, sidedefs: tm.sidedefs, vertices: tm.vertices };
  }

  const hexen = format === "hexen";
  const sectors = slice("SECTORS");
  const linedefs = slice("LINEDEFS");
  const sidedefs = slice("SIDEDEFS");
  const vertexes = slice("VERTEXES");
  return {
    format,
    sectors: sectors ? parseSectors(sectors) : [],
    linedefs: linedefs ? parseLinedefs(linedefs, hexen) : [],
    sidedefs: sidedefs ? parseSidedefs(sidedefs) : [],
    vertices: vertexes ? parseVertexes(vertexes) : [],
  };
}
