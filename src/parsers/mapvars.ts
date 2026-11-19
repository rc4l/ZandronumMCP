import { firstError, matchLines } from "./lines.js";

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

export interface MapSlotReply {
  /** The module's index, numbered as `dumpmodules` numbers them. */
  module: number;
  slot: number;
  index?: number;
  value: number;
  name: string;
}

const MAPSLOT_RE = /^MCP_MAPSLOT module=(\d+) slot=(\d+)(?: index=(\d+))? value=(-?\d+) name=(.*)$/;

/** Parse an `mcp_mapslot` reply, or undefined without one. */
export function parseMapSlot(lines: string[]): MapSlotReply | undefined {
  return matchLines(lines, MAPSLOT_RE, (m) => {
    const reply = { module: Number(m[1]), slot: Number(m[2]), value: Number(m[4]), name: m[5] };
    return m[3] === undefined ? reply : { ...reply, index: Number(m[3]) };
  })[0];
}

/** The digest guard's refusal (`mcp_mapslot` found no loaded module matching): the map and how many modules it has. */
export function parseMapSlotNoMatch(lines: string[]): { map: string; modules: number } | undefined {
  const m = /^no module matches map=(\S*) modules=(\d+)/.exec(firstError(lines) ?? "");
  return m ? { map: m[1], modules: Number(m[2]) } : undefined;
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
