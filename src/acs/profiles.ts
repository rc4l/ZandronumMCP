import path from "node:path";
import { z } from "zod";
import { baseName } from "./symbols.js";

/** Per-project `run_acs` profiles, with defines in a prelude since `#import` drops `#define`s and `-D` only defines a name as 1. */

export interface RunAcsProfile {
  /** The profile file, absolute, which its relative paths resolve against. */
  file: string;
  imports: string[];
  includeDirs: string[];
  /** Puts `#pragma raw define on` ahead of the defines (zt-bcc only). */
  rawDefines: boolean;
  defineFiles: string[];
  defines: Record<string, string>;
}

/** Prelude text, and the `file:line` (or profile key) each of its lines came from. */
export interface Prelude {
  text: string;
  origin: string[];
}

// One line, not blank: a bare `#define X` breaks the next line, as an include guard does, and so does a trailing `\`.
const defineValue = z.string().regex(/^(?![^\r\n]*\\\s*$)[^\r\n]*\S[^\r\n]*$/, "a non-blank single line not ending in \\");

const ProfileSchema = z
  .object({
    imports: z.array(z.string().min(1)).min(1),
    includeDirs: z.array(z.string().min(1)).optional(),
    rawDefines: z.boolean().optional(),
    defineFiles: z.array(z.string().min(1)).optional(),
    defines: z.record(z.string().regex(/^[A-Za-z_]\w*$/, "an identifier"), defineValue).optional(),
  })
  .strict();

export function parseProfile(text: string, file: string): RunAcsProfile {
  const abs = path.resolve(file);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`run_acs profile ${abs}: not JSON (${(e as Error).message})`);
  }
  const parsed = ProfileSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`).join("; ");
    throw new Error(`run_acs profile ${abs}: ${why}`);
  }
  const p = parsed.data;
  const resolve = (list: string[] = []) => list.map((d) => path.resolve(path.dirname(abs), d));
  return {
    file: abs,
    imports: p.imports,
    includeDirs: resolve(p.includeDirs),
    rawDefines: p.rawDefines ?? false,
    defineFiles: resolve(p.defineFiles),
    defines: p.defines ?? {},
  };
}

/** The basenames, lowercased, of every library the source `#import`s. */
export function importsOf(source: string): string[] {
  return [...source.matchAll(/^\s*#import\s+"([^"]+)"/gim)].map((m) => baseName(m[1]).toLowerCase());
}

/** Every profile one of whose `imports` the source `#import`s (by basename, any case). */
export function profilesFor(source: string, profiles: RunAcsProfile[]): RunAcsProfile[] {
  const names = new Set(importsOf(source));
  return profiles.filter((p) => p.imports.some((i) => names.has(baseName(i).toLowerCase())));
}

/** A harvested define: its name, its physical lines (continuations kept) and its first line number. */
export interface HarvestedDefine {
  name: string;
  lines: string[];
  line: number;
}

const DIRECTIVE = /^\s*#\s*(\w+)\s*(.*)$/;
const DEFINE = /^\s*#\s*(?:lib)?define\s+(\w+)(\()?(.*)$/i;
const blankBody = (body: string) => body.replace(/\/\*.*?\*\/|\/\/.*$/g, "").trim() === "";

/** One physical line as the compiler's lexer sees it, block comments being transparent. */
interface LineView {
  /** The line with block comments blanked to a space and string literals kept whole. */
  view: string;
  /** Whether a directive may start the line: only whitespace and comments precede it since the last newline. */
  begins: boolean;
  /** Where the code starts, past any comment that closes before it. */
  codeAt: number;
  /** Whether the line ends inside an unclosed block comment. */
  open: boolean;
}

function viewLines(lines: string[]): LineView[] {
  let inComment = false;
  let beganBefore = true;
  return lines.map((line) => {
    const begins = inComment ? beganBefore : true;
    let view = "";
    let quote = "";
    let codeAt = 0;
    let seenCode = false;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (inComment) {
        if (c === "*" && line[j + 1] === "/") {
          inComment = false;
          view += " ";
          if (!seenCode) codeAt = j + 2;
          j++;
        }
      } else if (quote) {
        view += c;
        if (c === "\\") view += line.slice(++j, j + 1);
        else if (c === quote) quote = "";
      } else if (line.startsWith("/*", j)) {
        inComment = true;
        beganBefore = begins && !seenCode;
        j++;
      } else if (line.startsWith("//", j)) {
        view += line.slice(j);
        break;
      } else {
        if (c === '"' || c === "'") quote = c;
        if (c !== " " && c !== "\t") seenCode = true;
        view += c;
      }
    }
    return { view, begins, codeAt, open: inComment };
  });
}

/** The non-empty `#define`/`#libdefine` lines of a header with their continuations, refusing any it can't copy safely. */
export function harvestDefines(text: string, file: string): HarvestedDefine[] {
  const lines = text.split(/\r?\n/);
  const views = viewLines(lines);
  const out: HarvestedDefine[] = [];
  // One frame per open conditional; `guard` holds while it is an `#ifndef X` / `#define X` pair at the top.
  const stack: { guard: boolean; name?: string }[] = [];
  let pendingGuard: { guard: boolean; name?: string } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const { view, begins, codeAt } = views[i];
    const d = begins ? DIRECTIVE.exec(view) : null;
    if (!d) continue;
    const kind = d[1].toLowerCase();
    const guard = pendingGuard;
    pendingGuard = undefined;
    const def = DEFINE.exec(view);
    if (def) {
      const [, name, params, body] = def;
      const empty = !params && blankBody(body);
      if (guard?.name === name && empty) guard.guard = true;
      if (stack.length > 1 || (stack.length === 1 && !stack[0].guard)) {
        throw new Error(`${file}:${i + 1}: #define ${name} sits inside an #if block; run_acs can't harvest conditional defines`);
      }
      const first = i;
      while (lines[i].trimEnd().endsWith("\\") && i + 1 < lines.length) i++;
      // The prelude joins files, so a dangling `\` would swallow the next file's first line.
      if (lines[i].trimEnd().endsWith("\\")) {
        throw new Error(`${file}:${first + 1}: #define ${name} continues past the end of the file`);
      }
      if (views[i].open) {
        throw new Error(`${file}:${first + 1}: #define ${name} opens a /* comment that runs past its line; run_acs can't harvest it`);
      }
      // A comment ahead of the `#` (or the tail of one from an earlier line) is dropped.
      if (!empty) out.push({ name, lines: [lines[first].slice(codeAt), ...lines.slice(first + 1, i + 1)], line: first + 1 });
    } else if (kind === "if" || kind === "ifdef" || kind === "ifndef") {
      const frame = { guard: false, name: kind === "ifndef" && stack.length === 0 ? d[2].split(/\s/)[0] : undefined };
      stack.push(frame);
      if (frame.name) pendingGuard = frame;
    } else if (kind === "else" || kind === "elif") {
      if (stack.length > 0) stack[stack.length - 1].guard = false;
    } else if (kind === "endif") {
      stack.pop();
    }
  }
  return out;
}

/** The prelude for the matched profiles (each defineFile once), or undefined when they add nothing. */
export function buildPrelude(matched: RunAcsProfile[], read: (p: string) => string): Prelude | undefined {
  const text: string[] = [];
  const origin: string[] = [];
  const add = (line: string, from: string) => {
    text.push(line);
    origin.push(from);
  };
  const raw = matched.find((p) => p.rawDefines);
  if (raw) add("#pragma raw define on", `${raw.file} (rawDefines)`);

  const defines = new Map<string, { value: string; file: string }>();
  for (const p of matched) {
    for (const [name, value] of Object.entries(p.defines)) {
      const seen = defines.get(name);
      if (seen && seen.value !== value) {
        throw new Error(`run_acs profiles ${seen.file} and ${p.file} define ${name} differently`);
      }
      if (!seen) defines.set(name, { value, file: p.file });
    }
  }
  for (const [name, { value, file }] of defines) add(`#define ${name} ${value}`, `${file} (defines.${name})`);

  const files = new Map<string, string>();
  for (const p of matched) for (const f of p.defineFiles) if (!files.has(f)) files.set(f, p.file);
  for (const [f, owner] of files) {
    let src: string;
    try {
      src = read(f);
    } catch (e) {
      throw new Error(`run_acs profile ${owner}: can't read defineFile ${f} (${(e as Error).message})`);
    }
    for (const def of harvestDefines(src, f)) {
      const own = defines.get(def.name);
      if (own) {
        throw new Error(`run_acs profile ${own.file}: defines.${def.name} can't override the #define at ${f}:${def.line}`);
      }
      def.lines.forEach((line, k) => add(line, `${f}:${def.line + k}`));
    }
  }
  return text.length > 0 ? { text: text.join("\n") + "\n", origin } : undefined;
}
