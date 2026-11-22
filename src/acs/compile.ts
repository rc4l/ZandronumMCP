import path from "node:path";
import { tmpdir } from "node:os";
import { accessSync, constants, existsSync, mkdtempSync, realpathSync, statSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { envName, type EngineAdapter } from "../adapter.js";
import type { Prelude } from "./profiles.js";

/** Host-side compile of a `run_acs` snippet into a temp dir the engine can read. */

export type AcsCompiler = "bcc" | "acc";

export interface CompileRequest {
  compiler: AcsCompiler;
  /** Configured executable (<PREFIX>_BCC/<PREFIX>_ACC); unset searches PATH. */
  exe?: string;
  source: string;
  includeDirs?: string[];
  /** Defines compiled ahead of the snippet as `mcpdefs.acs`; `origin[i]` is where line i+1 came from. */
  prelude?: Prelude;
  engine: Pick<EngineAdapter, "envPrefix" | "ansiPaths">;
}

/** `token` is `object` as a console token; a failure names the executable that ran, if one was found. */
export type CompileResult =
  | { ok: true; dir: string; object: string; token: string }
  | { ok: false; dir: string; diagnostics: string; exe?: string };

/** Filesystem and process access, injectable so every branch is testable. */
export interface CompileDeps {
  mkdtemp: (prefix: string) => string;
  writeFile: (p: string, text: string) => void;
  /** Runs the compiler; throws (like execFileSync) on a nonzero exit. */
  exec: (exe: string, args: string[], cwd: string) => void;
  pathEnv: () => string | undefined;
  /** Suffixes tried on a name that has none (see pathExts). */
  exeExts: string[];
  isExec: (p: string) => boolean;
  /** Canonical path (symlinks resolved), or `p` itself if that fails. */
  realpath: (p: string) => string;
  exists: (p: string) => boolean;
  platform: NodeJS.Platform;
}

/** Executable suffixes to try; execFile won't run a .cmd/.bat wrapper. */
export function pathExts(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? [".exe"] : [""];
}

function withExts(p: string, exts: string[]): string[] {
  return path.extname(p) ? [p] : exts.map((e) => p + e);
}

export function findOnPath(
  name: string,
  envPath: string | undefined,
  exts: string[],
  isExec: (p: string) => boolean,
): string | undefined {
  for (const entry of (envPath ?? "").split(path.delimiter).filter(Boolean)) {
    // Unquoted (Windows PATH entries may be quoted) and resolved, since the compiler runs in the temp dir.
    const dir = entry.replace(/^"(.*)"$/, "$1");
    const hit = withExts(path.resolve(dir, name), exts).find(isExec);
    if (hit) return hit;
  }
  return undefined;
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

export const defaultCompileDeps: CompileDeps = {
  mkdtemp: (prefix) => mkdtempSync(prefix),
  writeFile: (p, text) => writeFileSync(p, text),
  exec: (exe, args, cwd) => {
    execFileSync(exe, args, { cwd, stdio: "pipe", timeout: 30_000 });
  },
  pathEnv: () => process.env.PATH,
  exeExts: pathExts(process.platform),
  isExec: isExecutable,
  realpath: (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  },
  exists: (p) => existsSync(p),
  platform: process.platform,
};

const LIBRARY = /^\s*#library\b/im;
const LIBRARY_NAME = /^[^\S\r\n]*#library[^\S\r\n]+"([^"]+)".*$/im;
// bcc's `mcpdefs.acs:N:C:` and acc's `mcpdefs.acs:N:`, either with a directory in front.
const PRELUDE_REF = /^(?:.*[\\/])?mcpdefs\.acs:(\d+)(?=:)/gm;
// acc's `Line N in file "mcpdefs.acs"`.
const ACC_PRELUDE_REF = /Line (\d+) in file "(?:[^"]*[\\/])?mcpdefs\.acs"/g;
// zt-bcc's and acc's own wording for a missing zcommon.acs.
const NO_ZCOMMON = /failed to load file: "zcommon\.acs"|Couldn't find include file "zcommon\.acs"/;
// zt-bcc first: Debian's `bcc` package is Bruce's C compiler, also installed as `bcc`.
const DEFAULT_NAMES: Record<AcsCompiler, string[]> = { bcc: ["zt-bcc", "bcc"], acc: ["acc"] };
const HOME: Record<AcsCompiler, string> = {
  bcc: "zt-bcc (https://github.com/zeta-group/zt-bcc)",
  acc: "acc (https://github.com/ZDoom/acc)",
};

/** The executable to run and its resolved file, or why there is none. */
function locate(req: CompileRequest, deps: CompileDeps): { exe: string; real: string } | { missing: string } {
  const env = envName(req.engine, req.compiler.toUpperCase());
  const exeOnly = deps.exeExts.includes(".exe") ? " Only .exe files run, not .cmd/.bat wrappers." : "";
  if (req.exe !== undefined) {
    // A bare name is looked up on PATH, as execFile would; anything else is a path.
    const bare = !req.exe.includes("/") && !req.exe.includes(path.sep);
    const p = path.resolve(req.exe);
    const exe = bare
      ? findOnPath(req.exe, deps.pathEnv(), deps.exeExts, deps.isExec)
      : withExts(p, deps.exeExts).find(deps.isExec);
    if (exe) return { exe, real: deps.realpath(exe) };
    const why = bare ? "not found on PATH" : deps.exists(p) ? "is not an executable file" : "not found";
    return { missing: `compiler ${req.exe} (set by ${env}) ${why}.${exeOnly}` };
  }
  for (const name of DEFAULT_NAMES[req.compiler]) {
    const exe = findOnPath(name, deps.pathEnv(), deps.exeExts, deps.isExec);
    if (exe) return { exe, real: deps.realpath(exe) };
  }
  return {
    missing:
      `no ACS compiler found: tried ${DEFAULT_NAMES[req.compiler].join(", ")} on PATH. ` +
      `run_acs needs ${HOME[req.compiler]}: put it on PATH or set ${env} to its path in the MCP server's env.${exeOnly}`,
  };
}

/**
 * zt-bcc's `lib/` beside the real binary or one folder above it (a binary in `build/`),
 * unless includeDirs already reaches zcommon.acs.
 */
function bccLibDir(real: string, includeDirs: string[], deps: CompileDeps): string | undefined {
  const has = (d: string) => deps.exists(path.join(d, "zcommon.acs"));
  if (includeDirs.some(has)) return undefined;
  const dir = path.dirname(real);
  return [path.join(dir, "lib"), path.join(dir, "..", "lib")].find(has);
}

/** `text` with each prelude line reference replaced by where that line came from. */
function rewritePreludeRefs(text: string, origin: string[]): string {
  const at = (n: string, whole: string) => origin[Number(n) - 1] ?? whole;
  return text.replace(PRELUDE_REF, (whole, n: string) => at(n, whole)).replace(ACC_PRELUDE_REF, (whole, n: string) => at(n, whole));
}

/** The compiler's own words from an execFileSync failure, minus acc's banner. */
function diagnosticsOf(err: unknown, compiler: AcsCompiler, exe: string, prelude?: Prelude): string {
  const e = err as { code?: string; stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
  if (e.code === "ENOENT") return `couldn't start ${exe} (ENOENT: a broken link or a missing script interpreter?)`;
  let out = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() || String(e.message);
  const at = out.indexOf("**** ERROR ****");
  if (at >= 0) out = out.slice(at);
  if (NO_ZCOMMON.test(out)) {
    const where = compiler === "bcc" ? "zt-bcc's lib/ folder" : "acc's include folder";
    const auto = compiler === "bcc" ? ", or keep lib/ next to or one folder above the zt-bcc binary, where it's found automatically" : "";
    out += `\n(zcommon.acs is in ${where}: pass that folder in includeDirs${auto})`;
  }
  return prelude ? rewritePreludeRefs(out, prelude.origin) : out;
}

/**
 * `p` as one console token, or why not: a bare token ends at a byte <= 0x20 (UTF-8 too, where char is signed) and
 * expands a leading `$`, a quoted one reads `\"` `\\` `\c` as escapes, and Windows gets `/` separators and no
 * non-ASCII for an `ansiPaths` engine (ANSI fopen).
 */
export function consolePath(
  p: string,
  ansiPaths: boolean,
  platform: NodeJS.Platform = process.platform,
): { token: string } | { refused: string } {
  const s = platform === "win32" ? p.replaceAll("\\", "/") : p;
  // Control characters other than tab don't survive the bridge's JSON text decoding.
  const bad = /[";\x00-\x08\x0a-\x1f]/.exec(s);
  if (bad) return { refused: `it contains ${JSON.stringify(bad[0])}` };
  const wide = platform === "win32" && ansiPaths ? /[^\x00-\x7f]/u.exec(s) : null;
  if (wide) return { refused: `the engine can't open a non-ASCII path (${JSON.stringify(wide[0])}) on Windows` };
  if (!/[^\x21-\x7e]|^\$/.test(s)) return { token: s };
  if (s.includes("\\")) return { refused: "it needs quoting and has a \\, which the console reads as an escape" };
  return { token: `"${s}"` };
}

/** Compile `req.source`; the caller removes `dir` once the engine has read the object. */
export function compileAcs(req: CompileRequest, deps: CompileDeps = defaultCompileDeps): CompileResult {
  const dir = deps.mkdtemp(path.join(tmpdir(), "mcp-runacs-"));
  const object = path.join(dir, "snippet.o");
  const tok = consolePath(object, req.engine.ansiPaths, deps.platform);
  if ("refused" in tok) {
    return {
      ok: false,
      dir,
      diagnostics:
        `temp dir ${JSON.stringify(dir)} can't be passed as a console token: ${tok.refused}. ` +
        "Set TMPDIR (TEMP on Windows) in the MCP server's env to an existing folder without that; plain ASCII is safest.",
    };
  }
  const found = locate(req, deps);
  if ("missing" in found) return { ok: false, dir, diagnostics: found.missing };
  let main = "snippet.acs";
  if (req.prelude) {
    // acc wants #library first, so a library snippet lends the wrapper its name and its own line goes blank.
    const named = LIBRARY_NAME.exec(req.source);
    main = "wrap.acs";
    deps.writeFile(path.join(dir, "snippet.acs"), named ? req.source.replace(LIBRARY_NAME, "") : req.source);
    deps.writeFile(path.join(dir, "mcpdefs.acs"), req.prelude.text);
    deps.writeFile(path.join(dir, main), `#library "${named?.[1] ?? "mcpsnip"}"\n#include "mcpdefs.acs"\n#include "snippet.acs"\n`);
  } else {
    deps.writeFile(path.join(dir, "snippet.acs"), req.source);
    // A non-library object's string indices are untagged, so as module N > 0 its `Log(s:"...")` reads module 0's
    // strings (live-confirmed); the wrapper `#include`s the snippet, which keeps its line numbers in diagnostics.
    if (!LIBRARY.test(req.source)) {
      main = "wrap.acs";
      deps.writeFile(path.join(dir, main), '#library "mcpsnip"\n#include "snippet.acs"\n');
    }
  }
  // Resolved against the server's cwd, not the temp dir the compiler runs in.
  const dirs = (req.includeDirs ?? []).map((d) => path.resolve(d));
  const lib = req.compiler === "bcc" ? bccLibDir(found.real, dirs, deps) : undefined;
  if (lib !== undefined) dirs.push(lib);
  try {
    deps.exec(found.exe, [...dirs.flatMap((d) => ["-i", d]), main, object], dir);
  } catch (err) {
    return { ok: false, dir, diagnostics: diagnosticsOf(err, req.compiler, found.exe, req.prelude), exe: found.exe };
  }
  return { ok: true, dir, object, token: tok.token };
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
