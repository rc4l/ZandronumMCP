export interface ModuleInfo {
  id: number;
  name: string;
}

const MAPVAR_RE = /^mapvar (\S+) = (-?\d+)$/;
const MAPARRAY_RE = /^maparray (\S+)\[(\d+)\] = (-?\d+)$/;
const MODULE_RE = /^module (\d+) (.+)$/;

/** Parse a `getmapvar`/`setmapvar` result. Returns the value, or null if not found. */
export function parseMapVar(lines: string[]): number | null {
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(MAPVAR_RE);
      if (m) return Number(m[2]);
    }
  }
  return null;
}

/** Parse a `getmaparray`/`setmaparray` result. Returns the value, or null if not found. */
export function parseMapArray(lines: string[]): number | null {
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(MAPARRAY_RE);
      if (m) return Number(m[3]);
    }
  }
  return null;
}

/** Parse `dumpmodules` output into the loaded ACS modules. */
export function parseModules(lines: string[]): ModuleInfo[] {
  const out: ModuleInfo[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(MODULE_RE);
      if (m) out.push({ id: Number(m[1]), name: m[2] });
    }
  }
  return out;
}
