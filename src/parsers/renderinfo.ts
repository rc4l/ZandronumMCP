/**
 * Parse `dumprenderer` output: one `key=value` per line (value is the rest of
 * the line, so vendor strings with spaces survive). Numeric values become
 * numbers. Lines without `=` (the header) are skipped. Generic — new keys added
 * to the CCMD appear automatically.
 */
export function parseRenderInfo(lines: string[]): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      const eq = t.indexOf("=");
      if (eq <= 0) continue;
      const key = t.slice(0, eq);
      const value = t.slice(eq + 1);
      const n = Number(value);
      out[key] = value !== "" && !Number.isNaN(n) ? n : value;
    }
  }
  return out;
}

/** Return only the listed keys that are present. */
export function pick(
  rec: Record<string, string | number>,
  keys: string[],
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    if (k in rec) out[k] = rec[k];
  }
  return out;
}
