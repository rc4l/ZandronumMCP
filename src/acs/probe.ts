import path from "node:path";
import { tmpdir } from "node:os";
import {
  arraySizes,
  chunkBytes,
  chunkTable,
  imageDigest,
  importedSlots,
  functionEntries,
  type AcsFormat,
  type ChunkTable,
  type ImageDigest,
} from "./bytecode.js";
import { compileFile, type CompileDeps } from "./compile.js";
import { ACS_CONTAINERS, type AcsModule } from "./collect.js";
import type { EngineAdapter } from "../adapter.js";

/** Resolves an unexported map var's slot by probe compile, failing closed since a wrong slot reads silently. */

/** A name, then constant `[index]` and `.member` parts, the only text ever appended to source. */
export const PROBE_EXPR = /^[A-Za-z_]\w*(\[\d+\]|\.[A-Za-z_]\w*)*$/;

// The engine's map var count (p_acs.h NUM_MAPVARS).
const NUM_MAPVARS = 128;

/** Probe `n`'s function name, as FNAM stores it (lowercased). */
export function probeName(n: number): string {
  return `__mcp_p_${n}`;
}

/** The text appended to the main source: one `raw` function per expression, probe `i` returning `exprs[i]`. */
export function probeSource(exprs: string[]): string {
  // The leading newline ends a last line that is a `//` comment.
  return "\n" + exprs.map((e, i) => `function raw ${probeName(i)}(void) { return ${e}; }\n`).join("");
}

/** Each probe's code address by probe number, from FUNC through its FNAM name, with the build's chunk table. */
export function probeAddresses(probe: Buffer, count: number): { addrs: number[]; table: ChunkTable } | { refused: string } {
  const table = chunkTable(probe);
  if (!table) return { refused: "the probe build isn't chunked ACSE/ACSe bytecode" };
  const fns = functionEntries(probe, table);
  const addrs: number[] = [];
  for (let i = 0; i < count; i++) {
    const fn = fns.find((f) => f.name === probeName(i));
    if (!fn) return { refused: `${probeName(i)} isn't among the probe build's named functions (FNAM)` };
    addrs.push(fn.address);
  }
  return { addrs, table };
}

// FUNC and FNAM gain the probes' entries; everything else must not move.
const PROBE_CHUNKS = new Set(["FUNC", "FNAM"]);

/** Why the probe build moved build A's layout, or undefined; the code must match too, since only it pins a hidden zero scalar's slot. */
export function checkNeutral(plain: Buffer, probe: Buffer, firstProbe: number): string | undefined {
  const a = chunkTable(plain);
  const b = chunkTable(probe);
  if (!a || !b) return "code: a build isn't chunked ACSE/ACSe bytecode";
  const as = a.chunks.filter((c) => !PROBE_CHUNKS.has(c.id));
  const bs = b.chunks.filter((c) => !PROBE_CHUNKS.has(c.id));
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const [x, y] = [as[i], bs[i]];
    // The bytes include the id, so this also catches the same chunks in another order.
    if (!x || !y || !chunkBytes(plain, x).equals(chunkBytes(probe, y))) return `chunk ${(x ?? y).id} differs`;
  }
  if (!plain.subarray(8, firstProbe).equals(probe.subarray(8, firstProbe))) {
    return `code: the builds differ before the first probe (at ${firstProbe})`;
  }
  const pad = plain.subarray(firstProbe, a.start);
  if (firstProbe > a.start || pad.length > 3 || pad.some((x) => x > 1)) {
    return `code: build A's code ends at ${a.start}, not within 3 padding bytes (0 or 1) after the first probe (at ${firstProbe})`;
  }
  return undefined;
}

/** A decoded probe: `MapVars[slot]`, or element `index` of the array in `slot`. */
export interface ProbeSlot {
  slot: number;
  index?: number;
}

// An operand's width by format, as p_acs.cpp reads it: NEXTWORD, NEXTBYTE, or PCD_PUSHBYTE's raw byte.
const WIDTH = { word: { ACSE: 4, ACSe: 4 }, byte: { ACSE: 4, ACSe: 1 }, u8: { ACSE: 1, ACSe: 1 } } as const;

// p_acs.h opcodes a probe body is decoded or named by.
const OPS: Record<number, { name: string; arg?: keyof typeof WIDTH }> = {
  0: { name: "NOP" },
  1: { name: "TERMINATE" },
  3: { name: "PUSHNUMBER", arg: "word" },
  29: { name: "PUSHMAPVAR", arg: "byte" },
  30: { name: "PUSHWORLDVAR", arg: "byte" },
  167: { name: "PUSHBYTE", arg: "u8" },
  182: { name: "PUSHGLOBALVAR", arg: "byte" },
  206: { name: "RETURNVAL" },
  207: { name: "PUSHMAPARRAY", arg: "byte" },
  226: { name: "PUSHWORLDARRAY", arg: "byte" },
  235: { name: "PUSHGLOBALARRAY", arg: "byte" },
};
const [PUSHNUMBER, PUSHMAPVAR, PUSHBYTE, RETURNVAL, PUSHMAPARRAY] = [3, 29, 167, 206, 207];
const WORLD_GLOBAL = new Set([30, 182, 226, 235]);

interface Instruction {
  op: number;
  arg?: number;
  end: number;
}

/** Up to `max` instructions of `body`, stopping after an unknown opcode (ACSe's 2-byte form starts at 240, above every one here). */
function disassemble(body: Buffer, format: AcsFormat, max: number): Instruction[] {
  const wide = format === "ACSE";
  const out: Instruction[] = [];
  let at = 0;
  while (out.length < max && at + (wide ? 4 : 1) <= body.length) {
    const op = wide ? body.readUInt32LE(at) : body[at];
    at += wide ? 4 : 1;
    const def = OPS[op];
    if (!def?.arg) {
      out.push({ op, end: at });
      if (!def) break;
      continue;
    }
    const width = WIDTH[def.arg][format];
    if (at + width > body.length) break;
    out.push({ op, arg: width === 4 ? body.readUInt32LE(at) : body[at], end: at + width });
    at += width;
  }
  return out;
}

function listing(ins: Instruction[]): string {
  if (ins.length === 0) return "nothing decodable";
  return ins.map((i) => `${OPS[i.op]?.name ?? `opcode ${i.op}`}${i.arg !== undefined ? ` ${i.arg}` : ""}`).join("; ");
}

/** What a body that isn't one of the two accepted shapes reads as, for the refusal. */
function kindOf(ins: Instruction[]): string {
  if (ins.some((i) => WORLD_GLOBAL.has(i.op))) return "a world or global variable, not a map variable";
  const [a, b] = ins;
  if ((a?.op === PUSHNUMBER || a?.op === PUSHBYTE) && b?.op === RETURNVAL) return "a constant, not a variable";
  return "not a map variable or an element of a map array at a constant index";
}

/** Decode one probe body, where zt-bcc folds any constant index or member offset into the one push before PUSHMAPARRAY. */
function decodeBody(body: Buffer, format: AcsFormat, last: boolean): ProbeSlot | { refused: string } {
  const ins = disassemble(body, format, 3);
  const [a, b, c] = ins;
  const shape =
    a?.op === PUSHMAPVAR && a.arg !== undefined && b?.op === RETURNVAL
      ? { slot: { slot: a.arg }, length: 2 }
      : (a?.op === PUSHNUMBER || a?.op === PUSHBYTE) && a.arg !== undefined && b?.op === PUSHMAPARRAY && b.arg !== undefined && c?.op === RETURNVAL
        ? { slot: { slot: b.arg, index: a.arg }, length: 3 }
        : undefined;
  if (!shape) return { refused: `the probe body starts ${listing(ins)}: ${kindOf(ins)}` };
  const shown = ins.slice(0, shape.length);
  const rest = body.subarray(shown[shown.length - 1].end);
  if (rest.length > 0 && (!last || rest.length > 3 || rest.some((x) => x > 1))) {
    return { refused: `the probe body ${listing(shown)} is followed by ${rest.length} more byte(s)${last ? "" : " before the next probe"}` };
  }
  return shape.slot;
}

/** Decode each probe (`addrs` by probe number), a body running to the next probe's address or, for the last, the chunk start. */
export function decodeProbes(probe: Buffer, table: ChunkTable, addrs: number[]): Array<ProbeSlot | { refused: string }> {
  const sorted = [...addrs].sort((x, y) => x - y);
  return addrs.map((at) => {
    const next = sorted.find((x) => x > at);
    return decodeBody(probe.subarray(at, next ?? table.start), table.format, next === undefined);
  });
}

/** Why a decoded slot is out of bounds for the object's map vars and ARAY sizes, or undefined. */
export function checkBounds(slot: ProbeSlot, sizes: Map<number, number>): string | undefined {
  const size = sizes.get(slot.slot);
  if (slot.index === undefined) {
    if (slot.slot >= NUM_MAPVARS) return `scalar slot ${slot.slot} is past the engine's ${NUM_MAPVARS} map variables`;
    return size === undefined ? undefined : `slot ${slot.slot} holds an array of ${size}, not a scalar`;
  }
  if (size === undefined) return `slot ${slot.slot} isn't an array in the object's ARAY chunk`;
  return slot.index < size ? undefined : `index ${slot.index} is past the ${size} elements of the array in slot ${slot.slot}`;
}

export interface MapSlotRequest {
  /** The module's main source file. */
  sourceFile: string;
  /** Checked against PROBE_EXPR before anything is written. */
  exprs: string[];
  /** `<PREFIX>_BCC`; unset searches PATH. */
  exe?: string;
  /** After the source file's own dir. */
  includeDirs?: string[];
  /** The deployed modules, one of which build A must equal byte for byte. */
  deployed: AcsModule[];
  engine: Pick<EngineAdapter, "envPrefix">;
}

export interface MapSlot extends ProbeSlot {
  digest: ImageDigest;
  /** The deployed module build A equals. */
  module: AcsModule;
}

/** A refusal names the guard that failed. */
export type MapSlotResult = MapSlot | { refused: string; guard: string };

export interface ProbeIo {
  readFile: (p: string) => Buffer;
  /** The temp dir, the source copies and the compiler runs. */
  compile: CompileDeps;
  removeDir: (dir: string) => void;
}

/** Lines of compiler output, trimmed, blanks dropped. */
function outputLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Each part (`code`, or a chunk id) whose bytes differ between two chunked objects. */
function differingParts(a: Buffer, ta: ChunkTable, b: Buffer, tb: ChunkTable): string[] {
  const parts = a.subarray(8, ta.start).equals(b.subarray(8, tb.start)) ? [] : ["code"];
  const of = (buf: Buffer, t: ChunkTable, id: string) =>
    Buffer.concat(t.chunks.filter((c) => c.id === id).map((c) => chunkBytes(buf, c)));
  for (const id of new Set([...ta.chunks, ...tb.chunks].map((c) => c.id))) {
    if (!of(a, ta, id).equals(of(b, tb, id))) parts.push(id);
  }
  return parts.length > 0 ? parts : ["the header or the bytes after the chunks"];
}

/** Check 1's refusal: every deployed module with its size and, for the closest, which parts differ. */
function noMatch(plain: Buffer, deployed: AcsModule[]): string {
  const built = `build A of the source (${plain.length} bytes)`;
  if (deployed.length === 0) {
    return `${built} has nothing to match: the deployed files hold no ACS module this host can read (it reads ${ACS_CONTAINERS}; another archive format, 7z say, reads as none)`;
  }
  const ta = chunkTable(plain);
  const ranked = deployed.flatMap((m) => {
    const tm = ta && chunkTable(m.data);
    return tm ? [{ m, parts: differingParts(plain, ta, m.data, tm) }] : [];
  });
  const closest = ranked.reduce<(typeof ranked)[number] | undefined>((best, r) => (best && best.parts.length <= r.parts.length ? best : r), undefined);
  const list = deployed.map((m) => `${m.name} (${m.data.length} bytes)`).join(", ");
  const near = closest ? `; the closest, ${closest.m.name}, differs in ${closest.parts.join(", ")}` : "";
  return `${built} equals no deployed module: ${list}${near}. Pass the source the deployed object was built from (bcc, unchanged since)`;
}

/** Both builds compile a same-named copy of the main file in one temp dir, so path-dependent bytes agree and the mod stays untouched. */
export function resolveMapSlot(req: MapSlotRequest, io: ProbeIo): MapSlotResult[] {
  if (req.exprs.length === 0) return [];
  const refuse = (guard: string, refused: string): MapSlotResult[] => req.exprs.map(() => ({
    guard, refused: req.exprs.length === 1 ? refused : `${req.exprs.join(", ")}: ${refused}`,
  }));
  const invalid = req.exprs.find((expr) => !PROBE_EXPR.test(expr));
  if (invalid !== undefined) {
    return refuse("expression", `${JSON.stringify(invalid)} isn't a name followed by constant [index] and .member parts`);
  }
  let source: Buffer;
  try {
    source = io.readFile(req.sourceFile);
  } catch (e) {
    return refuse("source", `can't read ${req.sourceFile}: ${(e as Error).message}`);
  }
  const dir = io.compile.mkdtemp(path.join(tmpdir(), "mcp-mapslot-"));
  try {
    const main = path.basename(req.sourceFile);
    const includeDirs = [path.dirname(path.resolve(req.sourceFile)), ...(req.includeDirs ?? [])];
    const build = (text: Buffer, name: string) => {
      const object = path.join(dir, name);
      io.compile.writeFile(path.join(dir, main), text);
      const r = compileFile({ compiler: "bcc", exe: req.exe, main, cwd: dir, includeDirs, object, purpose: "sourceFile", engine: req.engine }, io.compile);
      return { ...r, object };
    };
    const a = build(source, "plain.o");
    if (!a.ok) return refuse("compile", `build A of ${req.sourceFile} failed:\n${a.diagnostics}`);
    const plain = io.readFile(a.object);
    // Of byte-equal copies (a symlinked dir walked twice, a stale copy), name one the engine loads as a module.
    const equal = req.deployed.filter((m) => m.data.equals(plain));
    const module = equal.find((m) => m.map !== undefined || /^acs\//i.test(m.name)) ?? equal[0];
    if (!module) return refuse("deployed", noMatch(plain, req.deployed));
    const digest = imageDigest(plain);
    if ("refused" in digest) return refuse("digest", `${module.name} can't be matched in the engine: ${digest.refused}`);
    const b = build(Buffer.concat([source, Buffer.from(probeSource(req.exprs), "latin1")]), "probe.o");
    if (!b.ok) return refuse("compile", `the probe build failed (is ${req.exprs.join(", ")} a map variable ${main} can see?):\n${b.diagnostics}`);
    const seen = new Set(outputLines(a.output));
    const added = outputLines(b.output).filter((l) => !seen.has(l));
    if (added.length > 0) return refuse("diagnostics", `the probe build printed what build A didn't:\n${added.join("\n")}`);
    const probe = io.readFile(b.object);
    const found = probeAddresses(probe, req.exprs.length);
    if ("refused" in found) return refuse("probe", found.refused);
    const { addrs, table } = found;
    const neutral = checkNeutral(plain, probe, Math.min(...addrs));
    if (neutral) return refuse("neutrality", `the probe moved the module's layout: ${neutral}`);
    const imports = importedSlots(plain);
    const sizes = arraySizes(plain);
    return decodeProbes(probe, table, addrs).map((slot) => {
      if ("refused" in slot) return { guard: "decode", refused: slot.refused };
      // The digest proves the importing module, not that the import bound when it loaded.
      const imported = imports.get(slot.slot);
      if (imported !== undefined) return {
        guard: "import",
        refused: `${imported} is imported from a library: slot ${slot.slot} of ${module.name} is that library's var only if the library loaded and has the name. ` +
          "Pass that library's source, or use its exported name without sourceFile",
      };
      const bounds = checkBounds(slot, sizes);
      if (bounds) return { guard: "bounds", refused: bounds };
      return { ...slot, digest, module };
    });
  } finally {
    io.removeDir(dir);
  }
}
