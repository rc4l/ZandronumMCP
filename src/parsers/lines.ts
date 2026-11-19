/**
 * Shared line-matching for CCMD output parsers, so a new parser is a regex and
 * a mapper rather than another copy of the split-trim-match loop.
 */

/** Strip ZDoom console colour escapes (\x1c followed by a letter or [name]). */
export function stripColor(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1c(\[[^\]]*\]|.)/g, "");
}

/** Console output as trimmed plain-text lines, minus colour escapes, bar glyphs (\x1d-\x1f), blanks and `bar` lines. */
export function cleanConsoleLines(lines: string[], bar?: RegExp): string[] {
  return lines
    .flatMap((raw) => raw.split(/\r?\n/))
    // eslint-disable-next-line no-control-regex
    .map((line) => stripColor(line).replace(/[\x1d-\x1f]/g, "").trimEnd())
    .filter((line) => line.trim() !== "" && !bar?.test(line.trim()));
}

/** Map every console line (split on newlines, trimmed) that matches `re`. */
export function matchLines<T>(lines: string[], re: RegExp, map: (m: RegExpMatchArray) => T): T[] {
  const out: T[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(re);
      if (m) out.push(map(m));
    }
  }
  return out;
}

export type KvRecord = Record<string, string | number>;

const NUMERIC = /^-?\d+(?:\.\d+)?$/;

/** The `[key, value]` of every `key=value` token, skipping tokens with no key. */
export function kvPairs(tokens: string[]): [string, string][] {
  return tokens.flatMap((tok): [string, string][] => {
    const eq = tok.indexOf("=");
    return eq <= 0 ? [] : [[tok.slice(0, eq), tok.slice(eq + 1)]];
  });
}

/**
 * Parse a `key=value ... name=<rest of line>` body: `name=` (or the `rest` key) is last and keeps the rest of the line
 * as a string (names can hold spaces), every other numeric-looking value becomes a number unless its key is in `strings`.
 */
export function parseKv(body: string, strings: readonly string[] = [], rest = "name"): KvRecord {
  const out: KvRecord = {};
  const restKey = `${rest}=`;
  const nameAt = body.startsWith(restKey) ? 0 : body.indexOf(` ${restKey}`);
  const head = nameAt < 0 ? body : body.slice(0, nameAt);
  for (const [key, value] of kvPairs(head.split(/\s+/))) {
    out[key] = NUMERIC.test(value) && !strings.includes(key) ? Number(value) : value;
  }
  if (nameAt >= 0) out[rest] = body.slice(body.indexOf(restKey, nameAt) + restKey.length);
  return out;
}

/** Every `<tag> key=value ...` line, parsed with `parseKv`. */
export function parseKvLines(lines: string[], tag: string): KvRecord[] {
  return matchLines(lines, new RegExp(`^${tag} (.*)$`), (m) => parseKv(m[1]));
}

/** The first `<tag>` line carrying `key`: a status line among a command's other replies. */
export function statusRow(lines: string[], tag: string, key: string): KvRecord | undefined {
  return parseKvLines(lines, tag).find((r) => r[key] !== undefined);
}

/** `keys` of `row` as numbers. */
export function kvNumbers<K extends string>(row: KvRecord, keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, Number(row[k])])) as Record<K, number>;
}

/** The message of the first `error <message>` line a CCMD printed, if any. */
export function firstError(lines: string[]): string | undefined {
  return matchLines(lines, /^error (.+)$/, (m) => m[1])[0];
}

/** Whether a CCMD printed its header line (e.g. `MCP_FOUND`), which it does whenever it ran. */
export function hasHeader(lines: string[], header: string): boolean {
  return matchLines(lines, new RegExp(`^${header}$`), () => true).length > 0;
}

/** ` (a, b)` naming each of `keys` the reply set to 1, e.g. ` (died, removed)`; "" for none. */
export function markerText(rec: KvRecord, keys: string[]): string {
  const set = keys.filter((k) => rec[k] === 1);
  return set.length > 0 ? ` (${set.join(", ")})` : "";
}

/** What a command printed, as one string for an error message. */
export function outputText(lines: string[]): string {
  return lines.join("\n").trim() || "(no output)";
}

/** Why a CCMD gave no usable reply: its `error` line, else whatever it printed. */
export function failureText(lines: string[]): string {
  return firstError(lines) ?? outputText(lines);
}
