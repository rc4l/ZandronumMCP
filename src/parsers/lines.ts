/**
 * Shared line-matching for CCMD output parsers, so a new parser is a regex and
 * a mapper rather than another copy of the split-trim-match loop.
 */

/** Strip ZDoom console colour escapes (\x1c followed by a letter or [name]). */
export function stripColor(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1c(\[[^\]]*\]|.)/g, "");
}

// UZDoom's console_bar (hudmessages.cpp), printed above the level-start banner; Zandronum has none.
const CONSOLE_BAR = /^-{40}$/;

/**
 * Console output made readable as plain text: colour escapes, the separator-bar
 * glyphs (\x1d-\x1f) and UZDoom's 40-hyphen console bar removed, split into
 * lines, trailing whitespace trimmed, blank lines dropped.
 */
export function cleanConsoleLines(lines: string[]): string[] {
  return lines
    .flatMap((raw) => raw.split(/\r?\n/))
    // eslint-disable-next-line no-control-regex
    .map((line) => stripColor(line).replace(/[\x1d-\x1f]/g, "").trimEnd())
    .filter((line) => line.trim() !== "" && !CONSOLE_BAR.test(line.trim()));
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
 * Parse a `key=value ... name=<rest of line>` body: `name=` is last and keeps the rest of the
 * line as a string (names can hold spaces), every other numeric-looking value becomes a number.
 */
export function parseKv(body: string): KvRecord {
  const out: KvRecord = {};
  const nameAt = body.startsWith("name=") ? 0 : body.indexOf(" name=");
  const head = nameAt < 0 ? body : body.slice(0, nameAt);
  for (const [key, value] of kvPairs(head.split(/\s+/))) {
    out[key] = NUMERIC.test(value) ? Number(value) : value;
  }
  if (nameAt >= 0) out.name = body.slice(body.indexOf("name=", nameAt) + 5);
  return out;
}

/** Every `<tag> key=value ...` line, parsed with `parseKv`. */
export function parseKvLines(lines: string[], tag: string): KvRecord[] {
  return matchLines(lines, new RegExp(`^${tag} (.*)$`), (m) => parseKv(m[1]));
}

/** The message of the first `error <message>` line a CCMD printed, if any. */
export function firstError(lines: string[]): string | undefined {
  return matchLines(lines, /^error (.+)$/, (m) => m[1])[0];
}

/** Whether a CCMD printed its header line (e.g. `MCP_FOUND`), which it does whenever it ran. */
export function hasHeader(lines: string[], header: string): boolean {
  return matchLines(lines, new RegExp(`^${header}$`), () => true).length > 0;
}

/** What a command printed, as one string for an error message. */
export function outputText(lines: string[]): string {
  return lines.join("\n").trim() || "(no output)";
}

/** Why a CCMD gave no usable reply: its `error` line, else whatever it printed. */
export function failureText(lines: string[]): string {
  return firstError(lines) ?? outputText(lines);
}
