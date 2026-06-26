// Static ACS source indexer: parse a mod's .acs files into a symbol index so a
// profiler "script 1017" can be resolved to its name + file:line. Pure — the
// server reads the files and feeds (path, text) pairs in.

export interface AcsSymbol {
  kind: "script" | "function";
  name: string | null;
  number: number | null;
  file: string;
  line: number;
  /** Script type keyword (OPEN/ENTER/...), if present. */
  type: string | null;
}

export interface AcsIndex {
  symbols: AcsSymbol[];
  defines: Record<string, number>;
}

const DEFINE_RE = /^\s*#(?:lib)?define\s+(\w+)\s+(-?\d+)\b/;
const SCRIPT_RE = /^\s*script\s+("[^"]*"|-?\d+|[A-Za-z_]\w*)\s*([A-Za-z_]\w*)?/i;
const FUNCTION_RE = /^\s*function\s+\w+\s+([A-Za-z_]\w*)\s*\(/i;

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1];
}

/** Parse `#define` / `#libdefine NAME <int>` lines into a name→number map. */
export function parseDefines(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(DEFINE_RE);
    if (m) out[m[1]] = Number(m[2]);
  }
  return out;
}

interface RawDecl {
  kind: "script" | "function";
  ref: string;
  type: string | null;
  line: number;
}

/** Parse `script <ref> [type]` and `function <ret> <name>(` declarations. */
export function parseDeclarations(text: string): RawDecl[] {
  const out: RawDecl[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].match(SCRIPT_RE);
    if (sm) {
      out.push({ kind: "script", ref: sm[1], type: sm[2] ?? null, line: i + 1 });
      continue;
    }
    const fm = lines[i].match(FUNCTION_RE);
    if (fm) out.push({ kind: "function", ref: fm[1], type: null, line: i + 1 });
  }
  return out;
}

/** Build a symbol index across files, resolving script names ↔ numbers via defines. */
export function buildIndex(files: Array<{ path: string; text: string }>): AcsIndex {
  const defines: Record<string, number> = {};
  for (const f of files) Object.assign(defines, parseDefines(f.text));
  // ACS identifiers are case-insensitive, so resolve define refs that way.
  const definesLower: Record<string, number> = {};
  const reverse: Record<number, string> = {};
  for (const [name, num] of Object.entries(defines)) {
    definesLower[name.toLowerCase()] = num;
    if (!(num in reverse)) reverse[num] = name;
  }

  const symbols: AcsSymbol[] = [];
  for (const f of files) {
    const file = baseName(f.path);
    for (const d of parseDeclarations(f.text)) {
      if (d.kind === "function") {
        symbols.push({ kind: "function", name: d.ref, number: null, file, line: d.line, type: null });
      } else if (d.ref.startsWith('"')) {
        symbols.push({ kind: "script", name: d.ref.slice(1, -1), number: null, file, line: d.line, type: d.type });
      } else if (/^-?\d+$/.test(d.ref)) {
        const n = Number(d.ref);
        symbols.push({ kind: "script", name: reverse[n] ?? null, number: n, file, line: d.line, type: d.type });
      } else {
        const key = d.ref.toLowerCase();
        const n = key in definesLower ? definesLower[key] : null;
        symbols.push({ kind: "script", name: d.ref, number: n, file, line: d.line, type: d.type });
      }
    }
  }
  return { symbols, defines };
}

/** Find symbols by script number or by name (case-insensitive). */
export function findSymbol(index: AcsIndex, ref: string): AcsSymbol[] {
  if (/^-?\d+$/.test(ref)) {
    const n = Number(ref);
    return index.symbols.filter((s) => s.number === n);
  }
  const lower = ref.toLowerCase();
  return index.symbols.filter((s) => s.name !== null && s.name.toLowerCase() === lower);
}
