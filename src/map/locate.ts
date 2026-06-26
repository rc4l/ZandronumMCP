import type { Wad, WadLump } from "./wad.js";

export type MapFormat = "udmf" | "doom" | "hexen";

export interface MapLumps {
  format: MapFormat;
  lumps: Record<string, WadLump>;
}

// Lump names that belong to a map (consumed after the map marker lump).
const MAP_LUMPS = new Set([
  "THINGS", "LINEDEFS", "SIDEDEFS", "VERTEXES", "SEGS", "SSECTORS", "NODES",
  "SECTORS", "REJECT", "BLOCKMAP", "BEHAVIOR", "SCRIPTS", "TEXTMAP", "ZNODES",
  "DIALOGUE", "ENDMAP", "LIGHTMAP",
]);

/**
 * Locate a map's lumps in a WAD by marker name (e.g. "MAP01", "E1M1") and
 * detect its format: UDMF if a TEXTMAP lump is present, Hexen if a BEHAVIOR
 * lump is present, otherwise Doom.
 */
export function findMapLumps(wad: Wad, mapName: string): MapLumps {
  const marker = mapName.toUpperCase();
  const idx = wad.lumps.findIndex((l) => l.name === marker);
  if (idx < 0) {
    throw new Error(`map ${mapName} not found in WAD`);
  }
  const lumps: Record<string, WadLump> = {};
  for (let i = idx + 1; i < wad.lumps.length; i++) {
    const lump = wad.lumps[i];
    if (!MAP_LUMPS.has(lump.name)) break;
    lumps[lump.name] = lump;
  }
  const format: MapFormat = lumps.TEXTMAP ? "udmf" : lumps.BEHAVIOR ? "hexen" : "doom";
  return { format, lumps };
}
