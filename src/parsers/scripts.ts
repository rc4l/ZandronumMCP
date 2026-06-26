export interface ScriptInfo {
  module: number;
  number: number;
  /** Script name for named scripts, null for numbered. */
  name: string | null;
  type: number;
  args: number;
}

export interface FunctionInfo {
  module: number;
  index: number;
  name: string;
}

const SCRIPT_RE = /^script (\d+) (-?\d+) (\S+) (\d+) (\d+)$/;
const FUNCTION_RE = /^function (\d+) (\d+) (.+)$/;

/** Parse `dumpscripts`: `script <module> <number> <name|-> <type> <args>`. */
export function parseScripts(lines: string[]): ScriptInfo[] {
  const out: ScriptInfo[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(SCRIPT_RE);
      if (m) {
        out.push({
          module: Number(m[1]),
          number: Number(m[2]),
          name: m[3] === "-" ? null : m[3],
          type: Number(m[4]),
          args: Number(m[5]),
        });
      }
    }
  }
  return out;
}

/** Parse `dumpfunctions`: `function <module> <index> <name>`. */
export function parseFunctions(lines: string[]): FunctionInfo[] {
  const out: FunctionInfo[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(FUNCTION_RE);
      if (m) out.push({ module: Number(m[1]), index: Number(m[2]), name: m[3] });
    }
  }
  return out;
}
