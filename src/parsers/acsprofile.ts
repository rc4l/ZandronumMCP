export interface ProfileEntry {
  section: "script" | "function";
  module: string;
  name: string;
  total: number;
  runs: number;
  avg: number;
  min: number;
  max: number;
}

// Strip ZDoom console colour escapes (\x1c followed by a letter or [name]).
function stripColor(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1c(\[[^\]]*\]|.)/g, "");
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
