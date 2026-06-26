import type { MapEntity } from "./binary.js";

export interface UdmfMap {
  namespace: string;
  vertices: MapEntity[];
  linedefs: MapEntity[];
  sidedefs: MapEntity[];
  sectors: MapEntity[];
  things: MapEntity[];
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function parseValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw.startsWith('"')) return raw.slice(1, -1).replace(/\\"/g, '"');
  const n = Number(raw);
  return Number.isNaN(n) ? raw : n;
}

function parseProps(body: string): MapEntity {
  const props: MapEntity = {};
  const re = /(\w+)\s*=\s*([^;]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    props[m[1].toLowerCase()] = parseValue(m[2].trim());
  }
  return props;
}

/**
 * Parse a UDMF TEXTMAP lump generically. Every block's key=value pairs are kept
 * verbatim, so any standard field, new linedef effect, or custom `user_*`
 * property appears automatically — no hardcoded field list.
 */
export function parseTextmap(text: string): UdmfMap {
  const clean = stripComments(text);
  const map: UdmfMap = {
    namespace: "",
    vertices: [],
    linedefs: [],
    sidedefs: [],
    sectors: [],
    things: [],
  };
  const ns = clean.match(/namespace\s*=\s*"([^"]*)"\s*;/i);
  if (ns) map.namespace = ns[1];

  const blockRe = /(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(clean)) !== null) {
    const kind = m[1].toLowerCase();
    const bucket = bucketFor(map, kind);
    if (bucket) bucket.push({ index: bucket.length, ...parseProps(m[2]) });
  }
  return map;
}

function bucketFor(map: UdmfMap, kind: string): MapEntity[] | null {
  switch (kind) {
    case "vertex": return map.vertices;
    case "linedef": return map.linedefs;
    case "sidedef": return map.sidedefs;
    case "sector": return map.sectors;
    case "thing": return map.things;
    default: return null;
  }
}
