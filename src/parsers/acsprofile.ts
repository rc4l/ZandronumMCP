import { stripColor } from "./lines.js";
import type { ModuleInfo } from "./mapvars.js";
import type { FunctionInfo, ScriptInfo } from "./scripts.js";

export interface ProfileEntry {
  section: "script" | "function";
  module: string;
  name: string;
  total: number;
  runs: number;
  avg: number;
  min: number;
  max: number;
  /** The printed name was cut at the engine's column and couldn't be resolved to one full name. */
  truncated?: boolean;
}

export type ProfileSort = "total" | "avg" | "min" | "max" | "runs";

/** The engine's own default rows per section, kept host-side. */
export const DEFAULT_PROFILE_LIMIT = 10;

// `ShowProfileData` prints into `char scriptname[21]`; module names (`ModuleName[9]`) always fit their column.
const NAME_WIDTH = 20;

/** Whether a row's name was cut at the engine's 20-character column (a quoted script name loses its closing quote). */
export function isTruncated(entry: ProfileEntry): boolean {
  if (entry.section === "function") return entry.name.length === NAME_WIDTH;
  return entry.name.startsWith('"') && !entry.name.endsWith('"');
}

/** Whether `full` starts with `prefix`, case-insensitively. */
function startsWithCi(full: string, prefix: string): boolean {
  return full.toLowerCase().startsWith(prefix.toLowerCase());
}

/** Replace each truncated row's name with the one full `dumpscripts`/`dumpfunctions` name it can be, else flag it `truncated`. */
export function resolveProfileNames(
  entries: ProfileEntry[],
  modules: ModuleInfo[],
  scripts: ScriptInfo[],
  functions: FunctionInfo[],
): ProfileEntry[] {
  return entries.map((e) => {
    if (!isTruncated(e)) return e;
    const ids = new Set(modules.filter((m) => m.name.toLowerCase() === e.module.toLowerCase()).map((m) => m.id));
    const isScript = e.section === "script";
    const named = isScript ? scripts : functions;
    const prefix = isScript ? e.name.slice(1) : e.name;
    const names = new Set(
      named.flatMap((s) => (s.name !== null && ids.has(s.module) && startsWithCi(s.name, prefix) ? [s.name] : [])),
    );
    if (names.size !== 1) return { ...e, truncated: true };
    const [full] = names;
    return { ...e, name: isScript ? `"${full}"` : full };
  });
}

export interface RankedProfile {
  entries: ProfileEntry[];
  /** Every row that ran, per section, before the limit. */
  profiled: { scripts: number; functions: number };
}

/** The top `limit` rows that ran per section, ranked host-side since the engine counts never-run rows and overflows `int`. */
export function rankProfile(entries: ProfileEntry[], sort: ProfileSort = "total", limit = DEFAULT_PROFILE_LIMIT): RankedProfile {
  const section = (s: ProfileEntry["section"]) =>
    entries.filter((e) => e.section === s && e.runs > 0).sort((a, b) => b[sort] - a[sort]);
  const scripts = section("script");
  const functions = section("function");
  return {
    entries: [...scripts.slice(0, limit), ...functions.slice(0, limit)],
    profiled: { scripts: scripts.length, functions: functions.length },
  };
}

// The five right-aligned numeric columns at the end of a data row.
const TRAIL = /\s(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/;

/**
 * Parse `acsprofile` output. Rows are fixed-width
 * (`Module  name  Total Runs Avg Min Max`), split into a scripts section and a
 * functions section. The trailing five numbers are matched from the end and the
 * remaining prefix is split into module (first token) + name (the rest, which
 * may contain spaces like `Function 5` or `"my script"`).
 */
export function parseAcsProfile(lines: string[]): ProfileEntry[] {
  const out: ProfileEntry[] = [];
  let section: "script" | "function" = "script";
  for (const raw of lines) {
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = stripColor(rawLine);
      const trimmed = line.trim();
      const sec = trimmed.match(/\b(scripts|functions):$/);
      if (sec) {
        section = sec[1] === "functions" ? "function" : "script";
        continue;
      }
      if (trimmed.startsWith("Module") || /^[-\s]+$/.test(trimmed)) continue;
      const m = line.match(TRAIL);
      if (!m) continue;
      const prefix = line.slice(0, line.length - m[0].length).trim();
      const sp = prefix.indexOf(" ");
      const module = sp >= 0 ? prefix.slice(0, sp) : prefix;
      const name = sp >= 0 ? prefix.slice(sp).trim() : "";
      out.push({
        section,
        module,
        name,
        total: Number(m[1]),
        runs: Number(m[2]),
        avg: Number(m[3]),
        min: Number(m[4]),
        max: Number(m[5]),
      });
    }
  }
  return out;
}
