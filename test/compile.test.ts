import { describe, it, expect, vi } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileAcs,
  compileFile,
  consolePath,
  defaultCompileDeps,
  findOnPath,
  pathExts,
  removeDir,
  type CompileDeps,
} from "../src/acs/compile.js";
import { envName } from "../src/adapter.js";
import { engine } from "../src/engine.js";
import { abs } from "./fakes/paths.js";

// The next spawnSync result, once, in place of a real process.
const nextSpawn = vi.hoisted(() => ({ result: undefined as SpawnSyncReturns<Buffer> | undefined }));
vi.mock("node:child_process", async (orig) => {
  const cp = await orig<typeof import("node:child_process")>();
  const spawnSync = (...a: Parameters<typeof cp.spawnSync>) => {
    const r = nextSpawn.result;
    nextSpawn.result = undefined;
    return r ?? cp.spawnSync(...a);
  };
  return { ...cp, spawnSync };
});

const BCC_ENV = envName(engine, "BCC");
const ACC_ENV = envName(engine, "ACC");

/**
 * Runs `fn` with this Node binary as the compiler, every node it spawns preloading `body` (CommonJS
 * with `fs` and `args`, a relative first argument kept relative), so no shell script is needed.
 */
function withNodeStub<T>(dir: string, body: string, fn: (exe: string) => T): T {
  const stub = path.join(dir, "stub.cjs");
  writeFileSync(stub, `const fs = require("fs"), path = require("path");\nconst args = [path.relative(process.cwd(), process.argv[1]), ...process.argv.slice(2)];\n${body}\n`);
  const saved = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `--require "${stub.replace(/\\/g, "/")}"`;
  try {
    return fn(process.execPath);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = saved;
  }
}

// Not the real temp folder: a non-ASCII one on Windows would make every fake-deps compile refuse.
const DIR = abs("/tmp/mcp-runacs-x");
/** A file in the fake temp dir, joined the way compileAcs joins it on this OS. */
const at = (file: string) => path.join(DIR, file);

/**
 * Deps that record writes and exec calls: `fail` makes exec throw it, `files` are executables
 * unless listed in `plain`, `path` is PATH, and `links` maps a path to its realpath.
 */
function fakeDeps(
  opts: {
    dir?: string;
    fail?: unknown;
    /** What exec prints on success. */
    output?: string;
    path?: string[];
    files?: string[];
    plain?: string[];
    links?: Record<string, string>;
    exts?: string[];
    platform?: NodeJS.Platform;
  } = {},
) {
  const written = new Map<string, string>();
  const calls: Array<{ exe: string; args: string[]; cwd: string }> = [];
  const files = new Set((opts.files ?? []).map(abs));
  const plain = new Set((opts.plain ?? []).map(abs));
  const links = new Map(Object.entries(opts.links ?? {}).map(([k, v]) => [abs(k), abs(v)]));
  const deps: CompileDeps = {
    mkdtemp: () => opts.dir ?? DIR,
    writeFile: (p, text) => void written.set(p, text),
    exec: (exe, args, cwd) => {
      calls.push({ exe, args, cwd });
      if (opts.fail !== undefined) throw opts.fail;
      return opts.output ?? "";
    },
    pathEnv: () => opts.path?.map(abs).join(path.delimiter),
    exeExts: opts.exts ?? [""],
    isExec: (p) => files.has(p) && !plain.has(p),
    realpath: (p) => links.get(p) ?? p,
    exists: (p) => files.has(p),
    platform: opts.platform ?? process.platform,
  };
  return { deps, written, calls };
}

const BCC = { files: ["/opt/bcc"] };

describe("compileAcs", () => {
  it("wraps a non-library snippet as a library and compiles the wrapper", () => {
    const { deps, written, calls } = fakeDeps(BCC);
    const res = compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "script 1 (void) {}", includeDirs: ["/a", "/b"] }, deps);
    expect(res).toEqual({ ok: true, dir: DIR, object: at("snippet.o"), ...consolePath(at("snippet.o"), engine.ansiPaths) });
    expect(written.get(at("snippet.acs"))).toBe("script 1 (void) {}");
    expect(written.get(at("wrap.acs"))).toBe('#library "mcpsnip"\n#include "snippet.acs"\n');
    expect(calls).toEqual([
      { exe: abs("/opt/bcc"), args: ["-i", abs("/a"), "-i", abs("/b"), "wrap.acs", at("snippet.o")], cwd: DIR },
    ]);
  });

  it("compiles a snippet that is already a #library directly", () => {
    const { deps, written, calls } = fakeDeps({ files: ["/opt/acc"] });
    compileAcs({ engine, compiler: "acc", exe: "/opt/acc", source: '  #LIBRARY "mine"\nscript 1 (void) {}' }, deps);
    expect(written.has(at("wrap.acs"))).toBe(false);
    expect(calls[0].args).toEqual(["snippet.acs", at("snippet.o")]);
  });

  const PRELUDE = { text: "#pragma raw define on\n#define A 1\n", origin: ["/p.json (rawDefines)", "/h.acs:3"] };
  const PRELUDE_WRAP = (name: string) => `#library "${name}"\n#include "mcpdefs.acs"\n#include "snippet.acs"\n`;

  it("with a prelude, wraps a plain snippet under either compiler: library, then mcpdefs.acs, then the snippet", () => {
    for (const compiler of ["bcc", "acc"] as const) {
      const { deps, written, calls } = fakeDeps(BCC);
      compileAcs({ engine, compiler, exe: "/opt/bcc", source: "script 1 (void) {}", prelude: PRELUDE }, deps);
      expect(written.get(at("snippet.acs"))).toBe("script 1 (void) {}");
      expect(written.get(at("mcpdefs.acs"))).toBe(PRELUDE.text);
      expect(written.get(at("wrap.acs"))).toBe(PRELUDE_WRAP("mcpsnip"));
      expect(calls[0].args).toEqual(["wrap.acs", at("snippet.o")]);
    }
  });

  it("with a prelude, a #library snippet names the wrapper and its own #library line goes blank, keeping line numbers", () => {
    for (const compiler of ["bcc", "acc"] as const) {
      const { deps, written, calls } = fakeDeps(BCC);
      const source = '// mine\n  #Library "mylib" // the lib\n#import "osacs.acs"\nscript 1 (void) {}';
      compileAcs({ engine, compiler, exe: "/opt/bcc", source, prelude: PRELUDE }, deps);
      expect(written.get(at("snippet.acs"))).toBe('// mine\n\n#import "osacs.acs"\nscript 1 (void) {}');
      expect(written.get(at("wrap.acs"))).toBe(PRELUDE_WRAP("mylib"));
      expect(calls[0].args).toEqual(["wrap.acs", at("snippet.o")]);
    }
  });

  it("refuses a temp dir that can't travel as one console token, naming why and the remedy", () => {
    const { deps, calls } = fakeDeps({ ...BCC, dir: "/tmp/semi;colon" });
    const res = compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, deps);
    expect(res).toMatchObject({
      ok: false,
      dir: "/tmp/semi;colon",
      diagnostics: expect.stringMatching(/console token: it contains ";"\. Set TMPDIR \(TEMP on Windows\)/),
    });
    expect(calls).toHaveLength(0);
  });

  it("passes a temp dir with a space as a quoted token, keeping the real object path", () => {
    const dir = abs("/tmp/has space/mcp-runacs-x");
    const { deps, calls } = fakeDeps({ ...BCC, dir });
    const res = compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, deps);
    const object = path.join(dir, "snippet.o");
    expect(res).toMatchObject({ ok: true, object, token: `"${object.replaceAll("\\", "/")}"` });
    expect(calls[0].args.at(-1)).toBe(object);
  });

  it("searches PATH for zt-bcc before bcc whatever the PATH order, and for acc", () => {
    const only = fakeDeps({ path: ["/usr/bin"], files: ["/usr/bin/bcc"] });
    compileAcs({ engine, compiler: "bcc", source: "x" }, only.deps);
    expect(only.calls[0].exe).toBe(abs("/usr/bin/bcc"));
    const both = fakeDeps({ path: ["/usr/bin", "/usr/local/bin"], files: ["/usr/bin/bcc", "/usr/local/bin/zt-bcc"] });
    compileAcs({ engine, compiler: "bcc", source: "x" }, both.deps);
    expect(both.calls[0].exe).toBe(abs("/usr/local/bin/zt-bcc"));
    const acc = fakeDeps({ path: ["/usr/bin"], files: ["/usr/bin/acc"] });
    compileAcs({ engine, compiler: "acc", source: "x" }, acc.deps);
    expect(acc.calls[0].exe).toBe(abs("/usr/bin/acc"));
  });

  it("resolves relative paths and includeDirs against the server's cwd, not the temp dir the compiler runs in", () => {
    const abs = path.resolve("tools/zt-bcc");
    const { deps, calls } = fakeDeps({ files: [abs] });
    compileAcs({ engine, compiler: "bcc", exe: "tools/zt-bcc", source: "x", includeDirs: ["mods"] }, deps);
    expect(calls[0]).toMatchObject({ exe: abs, args: ["-i", path.resolve("mods"), "wrap.acs", expect.any(String)] });
  });

  it("looks a configured bare name up on PATH", () => {
    const { deps, calls } = fakeDeps({ path: ["/opt/zt"], files: ["/opt/zt/zt-bcc"] });
    compileAcs({ engine, compiler: "bcc", exe: "zt-bcc", source: "x" }, deps);
    expect(calls[0].exe).toBe(abs("/opt/zt/zt-bcc"));
    expect(compileAcs({ engine, compiler: "acc", exe: "acc", source: "x" }, deps)).toMatchObject({
      diagnostics: `compiler acc (set by ${ACC_ENV}) not found on PATH.`,
    });
  });

  it("adds the platform's executable suffix to a configured path without one", () => {
    const { deps, calls } = fakeDeps({ files: ["/tools/zt-bcc.exe", "/tools/acc.exe"], exts: [".exe"] });
    compileAcs({ engine, compiler: "bcc", exe: "/tools/zt-bcc", source: "x" }, deps);
    compileAcs({ engine, compiler: "acc", exe: "/tools/acc.exe", source: "x" }, deps);
    expect(calls.map((c) => c.exe)).toEqual([abs("/tools/zt-bcc.exe"), abs("/tools/acc.exe")]);
  });

  it("says what to install and set when no compiler is found, without writing or running anything", () => {
    const none = fakeDeps({ files: ["/opt/zt-bcc/lib/zcommon.acs", "/opt/zt-bcc/zt-bcc"], plain: ["/opt/zt-bcc/zt-bcc"] });
    expect(compileAcs({ engine, compiler: "bcc", source: "x" }, none.deps)).toEqual({
      ok: false,
      dir: DIR,
      diagnostics:
        "no ACS compiler found: tried zt-bcc, bcc on PATH. run_acs needs zt-bcc (https://github.com/zeta-group/zt-bcc): " +
        `put it on PATH or set ${BCC_ENV} to its path in the MCP server's env.`,
    });
    expect(compileAcs({ engine, compiler: "acc", source: "x" }, none.deps)).toMatchObject({
      diagnostics: expect.stringMatching(
        new RegExp(String.raw`^no ACS compiler found: tried acc on PATH\. run_acs needs acc \(https://github\.com/ZDoom/acc\): .* set ${ACC_ENV} `),
      ),
    });
    expect(compileAcs({ engine, compiler: "acc", exe: "/no/acc", source: "x" }, none.deps)).toMatchObject({
      diagnostics: `compiler /no/acc (set by ${ACC_ENV}) not found.`,
    });
    expect(compileAcs({ engine, compiler: "bcc", exe: "/opt/zt-bcc/zt-bcc", source: "x" }, none.deps)).toMatchObject({
      diagnostics: `compiler /opt/zt-bcc/zt-bcc (set by ${BCC_ENV}) is not an executable file.`,
    });
    expect(none.calls).toHaveLength(0);
    expect(none.written.size).toBe(0);
  });

  it("tells Windows users only .exe files run", () => {
    const { deps } = fakeDeps({ exts: [".exe"] });
    expect(compileAcs({ engine, compiler: "bcc", source: "x" }, deps)).toMatchObject({
      diagnostics: expect.stringMatching(/env\. Only \.exe files run, not \.cmd\/\.bat wrappers\.$/),
    });
    expect(compileAcs({ engine, compiler: "bcc", exe: "/x/zt-bcc.cmd", source: "x" }, deps)).toMatchObject({
      diagnostics: `compiler /x/zt-bcc.cmd (set by ${BCC_ENV}) not found. Only .exe files run, not .cmd/.bat wrappers.`,
    });
  });

  it("names the binary when it can't start", () => {
    const { deps } = fakeDeps({ path: ["/usr/bin"], files: ["/usr/bin/bcc"], fail: { code: "ENOENT" } });
    expect(compileAcs({ engine, compiler: "bcc", source: "x" }, deps)).toMatchObject({
      diagnostics: `couldn't start ${abs("/usr/bin/bcc")} (ENOENT: a broken link or a missing script interpreter?)`,
      exe: abs("/usr/bin/bcc"),
    });
  });

  it("adds zt-bcc's lib/ found beside or one above the real binary, after the caller's dirs", () => {
    const beside = fakeDeps({
      path: ["/usr/local/bin"],
      files: ["/usr/local/bin/zt-bcc", "/src/zt-bcc/lib/zcommon.acs"],
      links: { "/usr/local/bin/zt-bcc": "/src/zt-bcc/zt-bcc" },
    });
    compileAcs({ engine, compiler: "bcc", source: "x", includeDirs: ["/mod"] }, beside.deps);
    expect(beside.calls[0]).toMatchObject({
      exe: abs("/usr/local/bin/zt-bcc"),
      args: ["-i", abs("/mod"), "-i", abs("/src/zt-bcc/lib"), "wrap.acs", expect.any(String)],
    });
    // A configured link is followed too.
    const above = fakeDeps({
      files: ["/usr/local/bin/zt-bcc", "/src/zt-bcc/lib/zcommon.acs"],
      links: { "/usr/local/bin/zt-bcc": "/src/zt-bcc/build/zt-bcc" },
    });
    compileAcs({ engine, compiler: "bcc", exe: "/usr/local/bin/zt-bcc", source: "x" }, above.deps);
    expect(above.calls[0]).toMatchObject({ exe: abs("/usr/local/bin/zt-bcc"), args: ["-i", abs("/src/zt-bcc/lib"), "wrap.acs", expect.any(String)] });
    const both = fakeDeps({ files: ["/src/zt-bcc/build/zt-bcc", "/src/zt-bcc/build/lib/zcommon.acs", "/src/zt-bcc/lib/zcommon.acs"] });
    compileAcs({ engine, compiler: "bcc", exe: "/src/zt-bcc/build/zt-bcc", source: "x" }, both.deps);
    expect(both.calls[0].args.slice(0, 2)).toEqual(["-i", abs("/src/zt-bcc/build/lib")]);
  });

  it("adds no lib/ when includeDirs already reaches zcommon.acs, when there is none, or for acc", () => {
    const files = ["/src/zt-bcc/zt-bcc", "/src/zt-bcc/lib/zcommon.acs", "/mine/zcommon.acs", "/src/acc/acc", "/src/acc/lib/zcommon.acs"];
    const { deps, calls } = fakeDeps({ files });
    compileAcs({ engine, compiler: "bcc", exe: "/src/zt-bcc/zt-bcc", source: "x", includeDirs: ["/mine"] }, deps);
    compileAcs({ engine, compiler: "acc", exe: "/src/acc/acc", source: "x" }, deps);
    const bare = fakeDeps(BCC);
    compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, bare.deps);
    expect(calls[0].args.slice(0, 3)).toEqual(["-i", abs("/mine"), "wrap.acs"]);
    expect(calls[1].args[0]).toBe("wrap.acs");
    expect(bare.calls[0].args[0]).toBe("wrap.acs");
  });

  it("returns the compiler's diagnostics and which binary ran, dropping acc's banner", () => {
    const bcc = { stdout: "", stderr: Buffer.from("snippet.acs:1:30: syntax error\n") };
    expect(compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, fakeDeps({ ...BCC, fail: bcc }).deps)).toEqual({
      ok: false,
      dir: DIR,
      diagnostics: "snippet.acs:1:30: syntax error",
      exe: abs("/opt/bcc"),
    });
    const acc = { stdout: "Original ACC Version 1.10\n**** ERROR ****\nsnippet.acs:1: Missing semicolon.\n" };
    expect(compileAcs({ engine, compiler: "acc", exe: "/opt/bcc", source: "x" }, fakeDeps({ ...BCC, fail: acc }).deps)).toMatchObject({
      diagnostics: "**** ERROR ****\nsnippet.acs:1: Missing semicolon.",
    });
    const bare = new Error("spawnSync bcc ETIMEDOUT");
    expect(compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, fakeDeps({ ...BCC, fail: bare }).deps)).toMatchObject({
      diagnostics: "spawnSync bcc ETIMEDOUT",
    });
  });

  it("explains where zcommon.acs lives only when the compiler couldn't load it", () => {
    const bcc = { stderr: 'snippet.acs:1:9: error: failed to load file: "zcommon.acs"\n' };
    expect(compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, fakeDeps({ ...BCC, fail: bcc }).deps)).toMatchObject({
      diagnostics:
        'snippet.acs:1:9: error: failed to load file: "zcommon.acs"\n' +
        "(zcommon.acs is in zt-bcc's lib/ folder: pass that folder in includeDirs, or keep lib/ next to or one folder above the zt-bcc binary, where it's found automatically)",
    });
    const acc = { stdout: '**** ERROR ****\nsnippet.acs:1: Couldn\'t find include file "zcommon.acs".\n' };
    expect(compileAcs({ engine, compiler: "acc", exe: "/opt/bcc", source: "x" }, fakeDeps({ ...BCC, fail: acc }).deps)).toMatchObject({
      diagnostics: expect.stringMatching(/"zcommon\.acs"\.\n\(zcommon\.acs is in acc's include folder: pass that folder in includeDirs\)$/),
    });
    const twice = { stderr: "snippet.acs:2:9: error: #including zcommon.acs file multiple times\n" };
    expect(compileAcs({ engine, compiler: "bcc", exe: "/opt/bcc", source: "x" }, fakeDeps({ ...BCC, fail: twice }).deps)).toMatchObject({
      diagnostics: "snippet.acs:2:9: error: #including zcommon.acs file multiple times",
    });
  });

  it("points prelude errors at the profile or defineFile line they came from, keeping the column", () => {
    const origin = ["/p.json (rawDefines)", "/os/osdefs.acs:12", "/os/osdefs.acs:64", "/tmp/bad.acs:1"];
    const prelude = { text: "x\n", origin };
    const run = (compiler: "bcc" | "acc", fail: object) =>
      compileAcs({ engine, compiler, exe: "/opt/bcc", source: "x", prelude }, fakeDeps({ ...BCC, fail }).deps);
    // zt-bcc's verbatim lines: a bad define body, a redefinition pair, and an absolute main file.
    expect(run("bcc", { stderr: "mcpdefs.acs:4:9: error: invalid digit in decimal literal\nIn file #included from wrap.acs:2:\n" })).toMatchObject({
      diagnostics: "/tmp/bad.acs:1:9: error: invalid digit in decimal literal\nIn file #included from wrap.acs:2:",
    });
    expect(
      run("bcc", { stderr: "mcpdefs.acs:3:8: error: macro `X` redefined\nmcpdefs.acs:2:8: macro previously defined here\nIn file #included from wrap.acs:2:\n" }),
    ).toMatchObject({
      diagnostics: "/os/osdefs.acs:64:8: error: macro `X` redefined\n/os/osdefs.acs:12:8: macro previously defined here\nIn file #included from wrap.acs:2:",
    });
    expect(run("bcc", { stderr: "/tmp/mcp-runacs-x/mcpdefs.acs:2:8: error: x\nsnippet.acs:2:8: error: y\n" })).toMatchObject({
      diagnostics: "/os/osdefs.acs:12:8: error: x\nsnippet.acs:2:8: error: y",
    });
    // acc's two forms, relative and absolute; a line past the prelude stays as it is.
    expect(run("acc", { stdout: 'ACC\n**** ERROR ****\nLine 4 in file "mcpdefs.acs" ...\nmcpdefs.acs:4: Invalid identifier.\n> #define 9B\n' })).toMatchObject({
      diagnostics: "**** ERROR ****\n/tmp/bad.acs:1 ...\n/tmp/bad.acs:1: Invalid identifier.\n> #define 9B",
    });
    expect(run("acc", { stdout: '**** ERROR ****\nLine 1 in file "C:\\tmp\\x\\mcpdefs.acs" ...\nC:\\tmp\\x\\mcpdefs.acs:1: Invalid directive.\nmcpdefs.acs:9: z\n' })).toMatchObject({
      diagnostics: "**** ERROR ****\n/p.json (rawDefines) ...\n/p.json (rawDefines): Invalid directive.\nmcpdefs.acs:9: z",
    });
  });

  it("on Windows refuses a non-ASCII temp dir only for an engine with ANSI paths", () => {
    const opts = { ...BCC, dir: "/tmp/José", platform: "win32" as const };
    const req = { compiler: "bcc" as const, exe: "/opt/bcc", source: "x" };
    expect(compileAcs({ ...req, engine: { ...engine, ansiPaths: true } }, fakeDeps(opts).deps)).toMatchObject({
      ok: false,
      diagnostics: expect.stringMatching(/can't open a non-ASCII path \("é"\) on Windows/),
    });
    expect(compileAcs({ ...req, engine: { ...engine, ansiPaths: false } }, fakeDeps(opts).deps)).toMatchObject({ ok: true });
  });

  // A non-ASCII temp folder can't be a console token on an ansiPaths engine.
  const tempRefused = "refused" in consolePath(path.join(tmpdir(), "x"), engine.ansiPaths);

  it.skipIf(tempRefused)("uses the real filesystem and process by default", () => {
    const res = compileAcs({ engine, compiler: "bcc", exe: "/no/such/bcc", source: "script 1 (void) {}" });
    // Windows appends the .exe-only hint.
    expect(res).toMatchObject({ ok: false, diagnostics: expect.stringMatching(new RegExp(String.raw`^compiler /no/such/bcc \(set by ${BCC_ENV}\) not found\.`)) });
    expect(existsSync(res.dir)).toBe(true);
    removeDir(res.dir);
    expect(existsSync(res.dir)).toBe(false);
  });

  it.skipIf(tempRefused)("runs a real compiler process by default", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "mcp-fakebcc-"));
    const ran = withNodeStub(bin, 'fs.writeSync(2, `wrap.acs:1:1: error: ${args[0]} ${args[1]}\\n`); process.exit(1);', (exe) =>
      compileAcs({ engine, compiler: "bcc", exe, source: "x" }),
    );
    expect(ran).toMatchObject({ ok: false, diagnostics: "wrap.acs:1:1: error: wrap.acs " + path.join(ran.dir, "snippet.o") });
    removeDir(ran.dir);
    removeDir(bin);
  });

  it("the default exec returns stdout then stderr on success, and names a signal or a missing binary", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "mcp-fakebcc-"));
    const ok = withNodeStub(bin, 'fs.writeSync(1, "out\\n"); fs.writeSync(2, `${args[0]}: warning: w\\n`); process.exit(0);', (exe) =>
      defaultCompileDeps.exec(exe, ["x.bcs"], bin),
    );
    expect(ok).toBe("out\nx.bcs: warning: w\n");
    // Only the spawning process sees a signal on Windows, so the killed run is a spawn result.
    nextSpawn.result = { pid: 1, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, signal: "SIGKILL" };
    expect(() => defaultCompileDeps.exec(path.join(bin, "killed"), [], bin)).toThrow(/killed exited with SIGKILL/);
    expect(() => defaultCompileDeps.exec(path.join(bin, "missing"), [], bin)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    removeDir(bin);
  });

  it("removeDir is a no-op on a missing dir and removes a full one", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mcp-rm-"));
    writeFileSync(path.join(dir, "f"), "x");
    removeDir(dir);
    removeDir(dir);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("compileFile", () => {
  const req = { compiler: "bcc" as const, exe: "/opt/bcc", main: "lib.bcs", cwd: "/work", object: "/work/a.o", purpose: "sourceFile", engine };

  it("compiles a file in place with the shared include path, keeping what a successful compiler printed", () => {
    const { deps, calls, written } = fakeDeps({ ...BCC, output: "lib.bcs:3:1: warning: w\n" });
    expect(compileFile({ ...req, includeDirs: ["/src", "inc"] }, deps)).toEqual({ ok: true, output: "lib.bcs:3:1: warning: w\n" });
    expect(calls).toEqual([{ exe: abs("/opt/bcc"), args: ["-i", abs("/src"), "-i", abs("inc"), "lib.bcs", "/work/a.o"], cwd: "/work" }]);
    expect(written.size).toBe(0);
  });

  it("returns the diagnostics and the binary on failure, and names its purpose when there is no compiler", () => {
    const fail = { stderr: "lib.bcs:1:1: error: e\n" };
    expect(compileFile(req, fakeDeps({ ...BCC, fail }).deps)).toEqual({ ok: false, diagnostics: "lib.bcs:1:1: error: e", exe: abs("/opt/bcc") });
    expect(compileFile({ ...req, exe: undefined }, fakeDeps().deps)).toEqual({
      ok: false,
      diagnostics: `no ACS compiler found: tried zt-bcc, bcc on PATH. sourceFile needs zt-bcc (https://github.com/zeta-group/zt-bcc): put it on PATH or set ${BCC_ENV} to its path in the MCP server's env.`,
    });
  });
});

describe("consolePath", () => {
  const ok = (token: string) => ({ token });
  const refused = { refused: expect.any(String) };

  it("leaves a plain POSIX path as-is and quotes one with a space or non-ASCII", () => {
    expect(consolePath("/tmp/mcp-runacs-x/snippet.o", true, "linux")).toEqual(ok("/tmp/mcp-runacs-x/snippet.o"));
    expect(consolePath("/tmp/a b/snippet.o", true, "linux")).toEqual(ok('"/tmp/a b/snippet.o"'));
    expect(consolePath("/srv/José/snippet.o", true, "linux")).toEqual(ok('"/srv/José/snippet.o"'));
    expect(consolePath("$HOME/x.o", true, "linux")).toEqual(ok('"$HOME/x.o"'));
    // Bare, the console keeps `\` literally; quoted, `\c` would become a colour escape.
    expect(consolePath("/tmp/odd\\cname/x.o", true, "linux")).toEqual(ok("/tmp/odd\\cname/x.o"));
    expect(consolePath("/tmp/a b\\cname/x.o", true, "linux")).toEqual(refused);
  });

  it("gives Windows paths / separators, quoted only when they have a space", () => {
    expect(consolePath("C:\\Users\\First Last\\AppData\\Local\\Temp\\mcp-runacs-x\\snippet.o", true, "win32")).toEqual(
      ok('"C:/Users/First Last/AppData/Local/Temp/mcp-runacs-x/snippet.o"'),
    );
    expect(consolePath("C:\\Temp\\mcp-runacs-x\\snippet.o", true, "win32")).toEqual(ok("C:/Temp/mcp-runacs-x/snippet.o"));
    expect(consolePath("C:\\Users\\a b\\cache\\x.o", true, "win32")).toEqual(ok('"C:/Users/a b/cache/x.o"'));
    expect(consolePath("\\\\srv\\share\\t\\x.o", true, "win32")).toEqual(ok("//srv/share/t/x.o"));
  });

  it("refuses quotes, semicolons and control characters but tab anywhere", () => {
    expect(consolePath("/tmp/a\tb/x.o", true, "linux")).toEqual(ok('"/tmp/a\tb/x.o"'));
    for (const p of ['/tmp/a"b/x.o', "/tmp/a;b/x.o", "/tmp/a\nb/x.o", "/tmp/a\rb/x.o", "/tmp/a\x01b/x.o", "/tmp/a\x1fb/x.o"]) {
      expect(consolePath(p, true, "linux")).toEqual(refused);
      expect(consolePath(p, true, "win32")).toEqual(refused);
    }
  });

  it("refuses non-ASCII on Windows only for an engine that opens paths with ANSI fopen", () => {
    expect(consolePath("C:\\Users\\José\\x.o", true, "win32")).toEqual({ refused: expect.stringMatching(/non-ASCII path \("é"\) on Windows/) });
    expect(consolePath("C:\\Users\\José\\x.o", false, "win32")).toEqual(ok('"C:/Users/José/x.o"'));
  });

  it("defaults to this platform", () => {
    expect(consolePath("x.o", true)).toEqual(ok("x.o"));
  });
});

describe("compiler lookup", () => {
  /** A temp dir holding an executable `fake-bcc`, both realpathed. */
  const whichDir = () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mcp-which-")));
    const exe = path.join(dir, "fake-bcc");
    writeFileSync(exe, "#!/bin/sh\n");
    chmodSync(exe, 0o755);
    return { dir, exe };
  };

  it("findOnPath walks PATH in order, trying each suffix and skipping empty entries", () => {
    const seen: string[] = [];
    const isExec = (p: string) => (seen.push(p), p === path.resolve("/b", "zt-bcc.exe"));
    const envPath = ["", "/a", "/b"].join(path.delimiter);
    expect(findOnPath("zt-bcc", envPath, ["", ".exe"], isExec)).toBe(path.resolve("/b", "zt-bcc.exe"));
    expect(seen).toEqual(["/a/zt-bcc", "/a/zt-bcc.exe", "/b/zt-bcc", "/b/zt-bcc.exe"].map((p) => path.resolve(p)));
    expect(findOnPath("zt-bcc", undefined, [""], isExec)).toBeUndefined();
  });

  it("findOnPath takes a name that already has a suffix as-is, and resolves a relative PATH entry", () => {
    const seen: string[] = [];
    findOnPath("zt-bcc.exe", "bin", [".exe"], (p) => (seen.push(p), false));
    expect(seen).toEqual([path.resolve("bin", "zt-bcc.exe")]);
  });

  it("pathExts only tries .exe on Windows, where execFile can't run a .cmd wrapper", () => {
    expect(pathExts("win32")).toEqual([".exe"]);
    expect(pathExts("linux")).toEqual([""]);
  });

  it("findOnPath strips the quotes a Windows PATH entry may carry", () => {
    const seen: string[] = [];
    findOnPath("zt-bcc", '"/Program Files/zt"', [""], (p) => (seen.push(p), false));
    expect(seen).toEqual([path.resolve("/Program Files/zt", "zt-bcc")]);
  });

  it("the default deps see files, PATH and missing paths", () => {
    const { dir, exe } = whichDir();
    mkdirSync(path.join(dir, "subdir"));
    expect(defaultCompileDeps.isExec(exe)).toBe(true);
    expect(defaultCompileDeps.isExec(path.join(dir, "subdir"))).toBe(false);
    expect(defaultCompileDeps.isExec(path.join(dir, "missing"))).toBe(false);
    expect(defaultCompileDeps.realpath(exe)).toBe(exe);
    expect(defaultCompileDeps.realpath(path.join(dir, "missing"))).toBe(path.join(dir, "missing"));
    expect(defaultCompileDeps.exists(exe)).toBe(true);
    expect(defaultCompileDeps.pathEnv()).toBe(process.env.PATH);
    expect(defaultCompileDeps.exeExts).toEqual(pathExts(process.platform));
    expect(defaultCompileDeps.platform).toBe(process.platform);
    removeDir(dir);
  });

  // Windows has no execute bit, and its symlinks need a privilege.
  it.skipIf(process.platform === "win32")("the default deps see the execute bit and symlinks", () => {
    const { dir, exe } = whichDir();
    writeFileSync(path.join(dir, "plain"), "x");
    symlinkSync(exe, path.join(dir, "link"));
    expect(defaultCompileDeps.isExec(path.join(dir, "plain"))).toBe(false);
    expect(defaultCompileDeps.realpath(path.join(dir, "link"))).toBe(exe);
    removeDir(dir);
  });
});
