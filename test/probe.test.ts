import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIGEST_CHUNKS, arraySizes, chunkTable, imageDigest, importedSlots, type ChunkTable } from "../src/acs/bytecode.js";
import {
  PROBE_EXPR,
  checkBounds,
  checkNeutral,
  decodeProbes,
  probeAddresses,
  probeSource,
  resolveMapSlot as resolveMapSlots,
  type MapSlotRequest,
  type ProbeIo,
} from "../src/acs/probe.js";
import { MAPSLOT_DIGESTS } from "./fixtures/mapslot/digests.js";
import { defaultCompileDeps, findOnPath, removeDir, type CompileDeps } from "../src/acs/compile.js";
import { engine } from "../src/engine.js";
import { buildObject, chunk, funcChunk, nameChunk, u32 } from "./fakes/acs-builder.js";
import { lf } from "./fakes/paths.js";

const resolveMapSlot = (req: MapSlotRequest, io: ProbeIo) => resolveMapSlots(req, io)[0];

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "mapslot");
const read = (p: string) => readFileSync(path.join(FIXTURE, p));

/** The expressions in each probe/ copy, in probe order; `q` is the library's name prefix. */
const EXPRS = (q: string) => [`${q}_pub`, `${q}_pub_arr[1]`, `${q}_hid`, `${q}_hid_zero`, `${q}_hid_arr[2]`, `${q}_hid_pts[1].y`];
// Both libraries share one layout: public array 0, untouched 1-2, ms_pub 3, hidden 4-5, shared array 6.
const SLOTS = [{ slot: 3 }, { slot: 0, index: 1 }, { slot: 4 }, { slot: 5 }, { slot: 6, index: 5 }, { slot: 6, index: 11 }];
const LIBS = [
  { lib: "mapslot", q: "ms", format: "ACSe" },
  { lib: "mapslotn", q: "mn", format: "ACSE" },
] as const;

/** A copy of `buf` with `byte` at `at`. */
function patched(buf: Buffer, at: number, byte: number): Buffer {
  const out = Buffer.from(buf);
  out[at] = byte;
  return out;
}

describe("the mapslot fixture (real zt-bcc output)", () => {
  for (const { lib, q, format } of LIBS) {
    describe(lib, () => {
      const plain = read(`res/acs/${lib}.o`);
      const probe = read(`probe/${lib}.o`);

      it("its probe/ copy is the source plus probeSource of the probe expressions", () => {
        expect(lf(read(`probe/${lib}.bcs`).toString("latin1"))).toBe(lf(read(`${lib}.bcs`).toString("latin1")) + probeSource(EXPRS(q)));
      });

      it("is the format its source asks for, with the indirect header", () => {
        expect(plain.toString("latin1", 0, 4)).toBe("ACS\0");
        expect(chunkTable(plain)?.format).toBe(format);
      });

      it("digests header plus code, then the layout chunks, as an independent implementation does", () => {
        expect(imageDigest(plain)).toEqual(MAPSLOT_DIGESTS[lib]);
      });

      it("its probe build is neutral, and every probe decodes to its slot within bounds", () => {
        const found = probeAddresses(probe, 6);
        if ("refused" in found) throw new Error(found.refused);
        expect(checkNeutral(plain, probe, Math.min(...found.addrs))).toBeUndefined();
        const slots = decodeProbes(probe, found.table, found.addrs);
        expect(slots).toEqual(SLOTS);
        for (const s of SLOTS) expect(checkBounds(s, arraySizes(plain))).toBeUndefined();
      });
    });
  }

  it("the digest covers the code and every layout chunk, and nothing else", () => {
    const plain = read("res/acs/mapslot.o");
    const table = chunkTable(plain)!;
    const base = (imageDigest(plain) as { md5: string }).md5;
    const md5At = (at: number) => (imageDigest(patched(plain, at, plain[at] ^ 0x40)) as { md5: string }).md5;
    // Header and code, then one byte inside each chunk's data.
    expect(md5At(0)).not.toBe(base);
    expect(md5At(20)).not.toBe(base);
    const covered = new Set(["ARAY", "MEXP", "MINI", "AINI"]);
    for (const c of table.chunks.filter((c) => c.size > 0)) {
      expect({ id: c.id, at: c.offset, moved: md5At(c.offset + 8) !== base }).toEqual({ id: c.id, at: c.offset, moved: covered.has(c.id) });
    }
    // Both AINI chunks count.
    expect(table.chunks.filter((c) => c.id === "AINI")).toHaveLength(2);
  });

  it("sizes the public array and the shared array", () => {
    expect(arraySizes(read("res/acs/mapslot.o"))).toEqual(new Map([[0, 4], [6, 14]]));
  });

  it("names the import pair's imported slots, a scalar (MIMP) and an array (AIMP), and sizes neither", () => {
    const obj = read("import/msimp.o");
    expect(importedSlots(obj)).toEqual(new Map([[1, "mil_v"], [2, "mil_arr"]]));
    expect(arraySizes(obj).get(2)).toBeUndefined();
    expect(importedSlots(read("res/acs/mapslot.o"))).toEqual(new Map());
  });
});

describe("imageDigest", () => {
  const layout = [chunk("MINI", u32(3, 101)), chunk("LOAD", Buffer.from("lib\0")), chunk("AIMP", u32(0)), chunk("MIMP", Buffer.alloc(4))];

  it("names STRE as the loader renames it, and digests AIMP, MIMP and LOAD too", () => {
    const obj = buildObject({ code: Buffer.from([1, 1, 1, 1]), chunks: [chunk("STRE", u32(0)), ...layout] });
    const d = imageDigest(obj) as { first: string; md5: string };
    expect(d.first).toBe("STRL");
    const loadAt = obj.indexOf("LOAD") + 8;
    const aimpAt = obj.indexOf("AIMP") + 8;
    const mimpAt = obj.indexOf("MIMP") + 8;
    for (const at of [loadAt, aimpAt, mimpAt]) expect((imageDigest(patched(obj, at, 0x7f)) as { md5: string }).md5).not.toBe(d.md5);
  });

  it("works on the direct header too", () => {
    expect(imageDigest(buildObject({ indirect: false, format: "ACSE", chunks: layout }))).toMatchObject({ len: 8, first: "MINI" });
  });

  it("covers the chunks the overlay's mcp_mapslot digests, in its order", () => {
    const inc = readFileSync(path.join(FIXTURE, "..", "..", "..", "engine-bridge", "overlay", "mcp_mapslot.inc"), "latin1");
    const list = /MCP_MapSlotChunks\[\] = \{([^}]*)\}/.exec(inc)?.[1] ?? "";
    const ids = [...list.matchAll(/MAKE_ID\('(.)','(.)','(.)','(.)'\)/g)].map((m) => m.slice(1).join(""));
    expect(ids).toEqual([...DIGEST_CHUNKS]);
  });

  it("refuses an object the engine couldn't be matched on", () => {
    expect(imageDigest(Buffer.from("ACS\0\x08\0\0\0"))).toEqual({ refused: "it isn't chunked ACSE/ACSe bytecode" });
    expect(imageDigest(buildObject({ indirect: false, chunks: [] }))).toEqual({ refused: 'its first chunk id "" isn\'t four ASCII letters' });
    expect(imageDigest(buildObject({ chunks: [chunk("MI1I", u32(0))] }))).toEqual({ refused: 'its first chunk id "MI1I" isn\'t four ASCII letters' });
    const over = buildObject({ indirect: false, chunks: [chunk("MINI", u32(3, 1))] });
    over.writeUInt32LE(99, 12);
    expect(imageDigest(over)).toEqual({ refused: "its MINI chunk at 8 runs past the chunk region" });
  });
});

describe("probeSource and PROBE_EXPR", () => {
  it("appends one raw function per expression after a newline", () => {
    expect(probeSource(["a", "b[1].c"])).toBe(
      "\nfunction raw __mcp_p_0(void) { return a; }\nfunction raw __mcp_p_1(void) { return b[1].c; }\n",
    );
  });

  it("takes a name with constant indices and members, nothing else", () => {
    for (const ok of ["x", "_x9", "sectors[3].pf_pit_checked", "a[1][2]", "p.q.r"]) expect(PROBE_EXPR.test(ok)).toBe(true);
    for (const bad of ["", "9x", "a[i]", "a[-1]", "a + 1", "a; }", "a.b[", "ns::v", "a[1]x"]) expect(PROBE_EXPR.test(bad)).toBe(false);
  });
});

describe("probeAddresses", () => {
  it("finds each probe by its FNAM name, or names the missing one or an unchunked build", () => {
    const probe = buildObject({ chunks: [funcChunk([40, 44]), nameChunk("FNAM", ["other", "__mcp_p_0"])] });
    expect(probeAddresses(probe, 1)).toEqual({ addrs: [44], table: chunkTable(probe) });
    expect(probeAddresses(probe, 2)).toEqual({ refused: "__mcp_p_1 isn't among the probe build's named functions (FNAM)" });
    expect(probeAddresses(Buffer.from("ACS\0\x08\0\0\0", "latin1"), 1)).toEqual({ refused: "the probe build isn't chunked ACSE/ACSe bytecode" });
  });
});

describe("checkNeutral", () => {
  const plain = read("res/acs/mapslot.o");
  const probe = read("probe/mapslot.o");
  const first = 44;
  const t = chunkTable(probe)!;
  const at = (id: string) => t.chunks.find((c) => c.id === id)!.offset;

  it("refuses a probe build in which a chunk other than FUNC and FNAM changed", () => {
    expect(checkNeutral(plain, patched(probe, at("MINI") + 12, 0x66), first)).toBe("chunk MINI differs");
    // FUNC and FNAM are allowed to differ.
    expect(checkNeutral(plain, patched(probe, at("FUNC") + 8, 9), first)).toBeUndefined();
  });

  it("refuses a chunk only one build has, or the same chunks in another order", () => {
    const code = Buffer.from([1, 1, 1, 1]);
    const [x, y] = [chunk("MINI", u32(3, 1)), chunk("ARAY", u32(6, 14))];
    const obj = (...chunks: Buffer[]) => buildObject({ code, chunks });
    expect(checkNeutral(obj(x), obj(x, y), 12)).toBe("chunk ARAY differs");
    expect(checkNeutral(obj(x, y), obj(x), 12)).toBe("chunk ARAY differs");
    expect(checkNeutral(obj(x, y), obj(y, x), 12)).toBe("chunk MINI differs");
    expect(checkNeutral(obj(x, y), obj(x, y), 12)).toBeUndefined();
  });

  it("refuses a build that isn't chunked bytecode", () => {
    expect(checkNeutral(plain, Buffer.from("not an object"), first)).toBe("code: a build isn't chunked ACSE/ACSe bytecode");
    expect(checkNeutral(Buffer.alloc(4), probe, first)).toBe("code: a build isn't chunked ACSE/ACSe bytecode");
  });

  it("refuses code that differs before the first probe, but not bytes 4-7 (the directory offset)", () => {
    expect(checkNeutral(plain, patched(probe, 20, 0x1e), first)).toBe("code: the builds differ before the first probe (at 44)");
    // The golden pair passes with different directory offsets.
    expect(plain.readUInt32LE(4)).not.toBe(probe.readUInt32LE(4));
  });

  it("allows build A up to 3 padding bytes of 0 or 1 past the first probe, no more and nothing else", () => {
    // mapslot.o's code ends ...f0 11 01 at 44: [43, 44) is one TERMINATE, [42, 44) holds 0x11.
    expect(checkNeutral(plain, probe, 43)).toBeUndefined();
    const why = (p: number) => `code: build A's code ends at 44, not within 3 padding bytes (0 or 1) after the first probe (at ${p})`;
    expect(checkNeutral(plain, probe, 42)).toBe(why(42));
    expect(checkNeutral(plain, probe, 40)).toBe(why(40));
    const padded = buildObject({ code: Buffer.from([0x1d, 1, 0, 1, 1, 0]), chunks: [chunk("MINI", u32(3, 1))] });
    const later = buildObject({ code: Buffer.from([0x1d, 1, 0, 1, 1, 0, 0x1d, 4, 0xce]), chunks: [chunk("MINI", u32(3, 1))] });
    expect(checkNeutral(padded, later, 11)).toBeUndefined();
    expect(checkNeutral(padded, later, 10)).toBe(why(10).replace("44", "14"));
  });

  it("refuses a first probe past build A's chunk start, even where the bytes agree", () => {
    const mini = chunk("MINI", u32(3, 1));
    const plainObj = buildObject({ indirect: false, format: "ACSE", code: u32(1), chunks: [mini] });
    // The probe build's code repeats build A's first chunk bytes, then has its own chunk.
    const probeObj = buildObject({ indirect: false, format: "ACSE", code: Buffer.concat([u32(1), mini.subarray(0, 4)]), chunks: [mini] });
    expect(checkNeutral(plainObj, probeObj, 16)).toBe("code: build A's code ends at 12, not within 3 padding bytes (0 or 1) after the first probe (at 16)");
  });
});

describe("decodeProbes", () => {
  /** Decode `bodies` laid out back to back from offset 8 (last one up to the chunk start). */
  function decode(format: "ACSE" | "ACSe", ...bodies: number[][]) {
    const code = Buffer.from(bodies.flat());
    const probe = Buffer.concat([Buffer.alloc(8), code]);
    const table: ChunkTable = { format, start: probe.length, end: probe.length, chunks: [] };
    const addrs = bodies.map((_, i) => 8 + bodies.slice(0, i).flat().length);
    return decodeProbes(probe, table, addrs);
  }
  const w = (...v: number[]) => [...u32(...v)];

  it("decodes both shapes in both formats, PUSHNUMBER or PUSHBYTE", () => {
    expect(decode("ACSe", [0x1d, 4, 0xce], [0xa7, 5, 0xcf, 6, 0xce], [3, ...w(300), 0xcf, 6, 0xce])).toEqual([
      { slot: 4 },
      { slot: 6, index: 5 },
      { slot: 6, index: 300 },
    ]);
    // PUSHBYTE's operand is one byte in ACSE too, which leaves the next opcode unaligned.
    expect(decode("ACSE", w(29, 4, 206), w(3, 5, 207, 6, 206), [...w(167), 7, ...w(207, 0, 206)])).toEqual([
      { slot: 4 },
      { slot: 6, index: 5 },
      { slot: 0, index: 7 },
    ]);
  });

  it("sorts bodies by address, whatever the probe order", () => {
    const probe = Buffer.concat([Buffer.alloc(8), Buffer.from([0x1d, 4, 0xce, 0x1d, 5, 0xce])]);
    const table: ChunkTable = { format: "ACSe", start: 14, end: 14, chunks: [] };
    expect(decodeProbes(probe, table, [11, 8])).toEqual([{ slot: 5 }, { slot: 4 }]);
  });

  it("lets only the last body run on into up to 3 padding bytes of 0 or 1", () => {
    expect(decode("ACSe", [0x1d, 4, 0xce, 1, 0, 1])).toEqual([{ slot: 4 }]);
    expect(decode("ACSe", [0x1d, 4, 0xce, 1, 1, 1, 1])).toEqual([
      { refused: "the probe body PUSHMAPVAR 4; RETURNVAL is followed by 4 more byte(s)" },
    ]);
    expect(decode("ACSe", [0xa7, 1, 0xcf, 0, 0xce, 2])).toEqual([
      { refused: "the probe body PUSHBYTE 1; PUSHMAPARRAY 0; RETURNVAL is followed by 1 more byte(s)" },
    ]);
    expect(decode("ACSe", [0x1d, 4, 0xce, 1], [0x1d, 5, 0xce])).toEqual([
      { refused: "the probe body PUSHMAPVAR 4; RETURNVAL is followed by 1 more byte(s) before the next probe" },
      { slot: 5 },
    ]);
  });

  it("says what a refused body reads as", () => {
    const [world, global, array, constant, other, none, cut] = decode(
      "ACSe",
      [0x1e, 3, 0xce],
      [0xb6, 3, 0xce],
      [0xa7, 1, 0xe2, 2, 0xce],
      [0xa7, 5, 0xce],
      [0x0e, 0xce],
      [],
      [0x1d],
    );
    expect(world).toEqual({ refused: "the probe body starts PUSHWORLDVAR 3; RETURNVAL: a world or global variable, not a map variable" });
    expect(global).toEqual({ refused: "the probe body starts PUSHGLOBALVAR 3; RETURNVAL: a world or global variable, not a map variable" });
    expect(array).toEqual({ refused: "the probe body starts PUSHBYTE 1; PUSHWORLDARRAY 2; RETURNVAL: a world or global variable, not a map variable" });
    expect(constant).toEqual({ refused: "the probe body starts PUSHBYTE 5; RETURNVAL: a constant, not a variable" });
    const notMap = "not a map variable or an element of a map array at a constant index";
    expect(other).toEqual({ refused: `the probe body starts opcode 14: ${notMap}` });
    expect(none).toEqual({ refused: `the probe body starts nothing decodable: ${notMap}` });
    expect(cut).toEqual({ refused: `the probe body starts nothing decodable: ${notMap}` });
    expect(decode("ACSE", w(3, 9, 235, 1, 206), w(3, 9, 206), [1, 0])).toEqual([
      { refused: "the probe body starts PUSHNUMBER 9; PUSHGLOBALARRAY 1; RETURNVAL: a world or global variable, not a map variable" },
      { refused: "the probe body starts PUSHNUMBER 9; RETURNVAL: a constant, not a variable" },
      { refused: `the probe body starts nothing decodable: ${notMap}` },
    ]);
    // A shape cut off, its last operand missing.
    expect(decode("ACSe", [0xa7, 1, 0xcf, 0, 0xa7])).toEqual([
      { refused: `the probe body starts PUSHBYTE 1; PUSHMAPARRAY 0: ${notMap}` },
    ]);
    expect(decode("ACSe", [0x1d, 1, 0x1d])).toEqual([{ refused: `the probe body starts PUSHMAPVAR 1: ${notMap}` }]);
    // A computed index: an element at a map var's value.
    expect(decode("ACSe", [0x1d, 2, 0xcf, 6, 0xce])).toEqual([{ refused: `the probe body starts PUSHMAPVAR 2; PUSHMAPARRAY 6; RETURNVAL: ${notMap}` }]);
  });
});

describe("checkBounds", () => {
  const sizes = new Map([[6, 14]]);

  it("passes a scalar under 128 that isn't an array, and an element inside its array", () => {
    expect(checkBounds({ slot: 127 }, sizes)).toBeUndefined();
    expect(checkBounds({ slot: 6, index: 13 }, sizes)).toBeUndefined();
  });

  it("refuses everything else", () => {
    expect(checkBounds({ slot: 128 }, sizes)).toBe("scalar slot 128 is past the engine's 128 map variables");
    expect(checkBounds({ slot: 6 }, sizes)).toBe("slot 6 holds an array of 14, not a scalar");
    expect(checkBounds({ slot: 5, index: 0 }, sizes)).toBe("slot 5 isn't an array in the object's ARAY chunk");
    expect(checkBounds({ slot: 6, index: 14 }, sizes)).toBe("index 14 is past the 14 elements of the array in slot 6");
  });
});

describe("resolveMapSlot", () => {
  // A synthetic library: code `PUSHMAPVAR 4; TERMINATE` padded to 4, MINI, ARAY and MEXP.
  const CODE = Buffer.from([0x1d, 4, 1, 1]);
  const LAYOUT = [chunk("MINI", u32(3, 101, 103)), chunk("ARAY", u32(0, 4, 6, 14)), nameChunk("MEXP", ["arr", "a", "b", "pub"])];
  const PLAIN = buildObject({ code: CODE, chunks: LAYOUT });
  /** Build B for one probe `body`: the code plus the body and its padding, FUNC and FNAM first. */
  const probeBuild = (body: number[], layout = LAYOUT) => {
    const pad = (4 - (body.length % 4)) % 4;
    const code = Buffer.concat([CODE, Buffer.from(body), Buffer.alloc(pad, 1)]);
    return buildObject({ code, chunks: [funcChunk([8 + CODE.length]), nameChunk("FNAM", ["__mcp_p_0"]), ...layout] });
  };
  const SRC = path.resolve("/mods/src/lib.bcs");
  const DEPLOYED = [{ name: "acs/other.o", data: buildObject({ code: CODE, chunks: [chunk("MINI", u32(3, 7))] }) }, { name: "acs/lib.o", data: PLAIN }];

  /** ProbeIo over an in-memory filesystem whose compiler outputs `probe` for a source with a probe
   *  appended and `plain` otherwise, printing `probeOut`/`plainOut`. */
  function fakeIo(opts: { plain?: Buffer; probe?: Buffer; plainOut?: string; probeOut?: string; failPlain?: boolean; failProbe?: boolean } = {}) {
    const files = new Map<string, Buffer>([[SRC, Buffer.from("#library \"lib\"\nint pub = 101;\n")]]);
    const calls: Array<{ args: string[]; cwd: string; source: string }> = [];
    const removed: string[] = [];
    const compile: CompileDeps = {
      ...defaultCompileDeps,
      mkdtemp: () => "/tmp/mcp-mapslot-x",
      writeFile: (p, data) => void files.set(p, Buffer.from(data)),
      exec: (_exe, args, cwd) => {
        const source = files.get(path.join(cwd, args[args.length - 2]))!.toString("latin1");
        calls.push({ args, cwd, source });
        const probed = source.includes("__mcp_p_0");
        if (probed ? opts.failProbe : opts.failPlain) throw { stderr: "lib.bcs:3:1: error: `nope` not found\n" };
        files.set(args[args.length - 1], probed ? (opts.probe ?? probeBuild([0x1d, 4, 0xce])) : (opts.plain ?? PLAIN));
        return (probed ? opts.probeOut : opts.plainOut) ?? "";
      },
      // No suffix, so the fake isExec's /opt/bcc still matches on Windows.
      exeExts: [""],
      isExec: (p) => p === path.resolve("/opt/bcc"),
      realpath: (p) => p,
      exists: () => false,
    };
    const io: ProbeIo = {
      readFile: (p) => {
        const f = files.get(p);
        if (!f) throw new Error(`ENOENT: ${p}`);
        return f;
      },
      compile,
      removeDir: (d) => void removed.push(d),
    };
    return { io, calls, removed };
  }
  const req = ({ expr, ...over }: Partial<MapSlotRequest> & { expr?: string } = {}): MapSlotRequest => ({
    sourceFile: SRC,
    exprs: [expr ?? "hid"],
    exe: "/opt/bcc",
    deployed: DEPLOYED,
    engine,
    ...over,
  });

  it("resolves a scalar from two builds of a temp copy, the source dir first on the include path", () => {
    const f = fakeIo();
    const res = resolveMapSlot(req({ includeDirs: ["/inc"] }), f.io);
    expect(res).toEqual({ slot: 4, digest: imageDigest(PLAIN), module: DEPLOYED[1] });
    const copy = "/tmp/mcp-mapslot-x";
    const args = ["-i", path.resolve("/mods/src"), "-i", path.resolve("/inc"), "lib.bcs"];
    expect(f.calls.map((c) => ({ args: c.args, cwd: c.cwd }))).toEqual([
      { args: [...args, path.join(copy, "plain.o")], cwd: copy },
      { args: [...args, path.join(copy, "probe.o")], cwd: copy },
    ]);
    expect(f.calls[1].source).toBe(f.calls[0].source + probeSource(["hid"]));
    expect(f.removed).toEqual([copy]);
  });

  it("names the copy the engine loads as a module among byte-equal ones: under acs/ or a map's BEHAVIOR, else the first", () => {
    const pick = (deployed: MapSlotRequest["deployed"]) => (resolveMapSlot(req({ deployed }), fakeIo().io) as { module: { name: string } }).module.name;
    // `aaa_link` is a symlink to acs/, walked first.
    expect(pick([{ name: "aaa_link/lib.o", data: PLAIN }, { name: "acs/lib.o", data: PLAIN }])).toBe("acs/lib.o");
    expect(pick([{ name: "old/lib.o", data: PLAIN }, { name: "ACS/lib.o", data: PLAIN }])).toBe("ACS/lib.o");
    expect(pick([{ name: "copy/X.o", data: PLAIN }, { name: "maps/X.WAD:X", data: PLAIN, map: "X" }])).toBe("maps/X.WAD:X");
    expect(pick([{ name: "b/lib.o", data: PLAIN }, { name: "a/lib.o", data: PLAIN }])).toBe("b/lib.o");
  });

  it("resolves an element", () => {
    const f = fakeIo({ probe: probeBuild([0xa7, 5, 0xcf, 6, 0xce]) });
    expect(resolveMapSlot(req({ expr: "hid_arr[2]" }), f.io)).toMatchObject({ slot: 6, index: 5 });
  });

  it("batches two expressions in exactly two builds and refuses only the out-of-bounds ref", () => {
    const bodies = [0x1d, 4, 0xce, 0xa7, 14, 0xcf, 6, 0xce];
    const probe = buildObject({ code: Buffer.concat([CODE, Buffer.from(bodies)]), chunks: [
      funcChunk([12, 15]), nameChunk("FNAM", ["__mcp_p_0", "__mcp_p_1"]), ...LAYOUT,
    ] });
    const f = fakeIo({ probe });
    const results = resolveMapSlots(req({ exprs: ["hid", "arr[14]"] }), f.io);
    expect(f.calls).toHaveLength(2);
    expect(results).toEqual([
      { slot: 4, digest: imageDigest(PLAIN), module: DEPLOYED[1] },
      { guard: "bounds", refused: "index 14 is past the 14 elements of the array in slot 6" },
    ]);
    expect(f.calls[1].source).toBe(f.calls[0].source + probeSource(["hid", "arr[14]"]));
  });

  it("names every expression in build-wide refusals and validates all before compiling", () => {
    const f = fakeIo({ failPlain: true });
    const results = resolveMapSlots(req({ exprs: ["hid", "arr[1]"] }), f.io);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ guard: "compile", refused: expect.stringContaining("hid, arr[1]: build A") });
    const invalid = fakeIo();
    expect(resolveMapSlots(req({ exprs: ["hid", "arr + 1"] }), invalid.io)).toHaveLength(2);
    expect(invalid.calls).toHaveLength(0);
    expect(resolveMapSlots(req({ exprs: [] }), invalid.io)).toEqual([]);
  });

  it("refuses an expression outside the grammar before reading anything", () => {
    const f = fakeIo();
    expect(resolveMapSlot(req({ expr: "hid + 1" }), f.io)).toEqual({
      guard: "expression",
      refused: '"hid + 1" isn\'t a name followed by constant [index] and .member parts',
    });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses an unreadable source", () => {
    expect(resolveMapSlot(req({ sourceFile: "/nope.bcs" }), fakeIo().io)).toEqual({ guard: "source", refused: "can't read /nope.bcs: ENOENT: /nope.bcs" });
  });

  it("refuses when either build fails, and still removes the temp dir", () => {
    const a = fakeIo({ failPlain: true });
    expect(resolveMapSlot(req(), a.io)).toEqual({ guard: "compile", refused: `build A of ${SRC} failed:\nlib.bcs:3:1: error: \`nope\` not found` });
    expect(a.removed).toHaveLength(1);
    expect(resolveMapSlot(req(), fakeIo({ failProbe: true }).io)).toEqual({
      guard: "compile",
      refused: "the probe build failed (is hid a map variable lib.bcs can see?):\nlib.bcs:3:1: error: `nope` not found",
    });
  });

  it("refuses when build A equals no deployed module, listing them and what differs in the closest", () => {
    const f = fakeIo({ plain: buildObject({ code: Buffer.from([0x1d, 5, 1, 1]), chunks: LAYOUT }) });
    const odd = { name: "maps/X.WAD:X", data: Buffer.from("ACS\0 not chunked at all, just bytes") };
    const res = resolveMapSlot(req({ deployed: [odd, ...DEPLOYED] }), f.io);
    expect(res).toEqual({
      guard: "deployed",
      refused:
        "build A of the source (108 bytes) equals no deployed module: maps/X.WAD:X (35 bytes), acs/other.o (40 bytes), acs/lib.o (108 bytes); " +
        "the closest, acs/lib.o, differs in code. Pass the source the deployed object was built from (bcc, unchanged since)",
    });
    expect(f.removed).toHaveLength(1);
  });

  it("names chunks in the diagnosis, the first of equally close modules, or the bytes outside them", () => {
    const swapped = buildObject({ code: CODE, chunks: [chunk("MINI", u32(3, 103, 101)), ...LAYOUT.slice(1)] });
    const two = [{ name: "a.o", data: swapped }, { name: "b.o", data: swapped }];
    expect((resolveMapSlot(req({ deployed: two }), fakeIo().io) as { refused: string }).refused).toMatch(/the closest, a\.o, differs in MINI\./);
    const trailer = Buffer.concat([PLAIN, Buffer.from([0])]);
    expect((resolveMapSlot(req({ deployed: [{ name: "t.o", data: trailer }] }), fakeIo().io) as { refused: string }).refused).toMatch(
      /differs in the header or the bytes after the chunks\./,
    );
  });

  it("names no closest module when build A or every deployed module isn't chunked", () => {
    const flat = Buffer.from("ACS\0 a flat old-format object, 32+");
    const res = resolveMapSlot(req({ deployed: [{ name: "o.o", data: flat }] }), fakeIo({ plain: Buffer.from("ACS\0 another flat one, long enough") }).io);
    expect((res as { refused: string }).refused).toMatch(/equals no deployed module: o\.o \(34 bytes\)\. Pass/);
    expect(resolveMapSlot(req({ deployed: [] }), fakeIo().io)).toEqual({
      guard: "deployed",
      refused:
        "build A of the source (108 bytes) has nothing to match: the deployed files hold no ACS module this host can read " +
        "(it reads WADs, PK3/zips, directories and raw ACS objects; another archive format, 7z say, reads as none)",
    });
  });

  it("refuses a deployed object the engine can't match by digest", () => {
    const flat = Buffer.from("ACS\0 a flat old-format object, 32+");
    const res = resolveMapSlot(req({ deployed: [{ name: "o.o", data: flat }] }), fakeIo({ plain: flat }).io);
    expect(res).toEqual({ guard: "digest", refused: "o.o can't be matched in the engine: it isn't chunked ACSE/ACSe bytecode" });
  });

  it("refuses a diagnostic only the probe build printed", () => {
    const warn = "lib.bcs:9:3: warning: index out-of-bounds";
    expect(resolveMapSlot(req(), fakeIo({ plainOut: "note: same\n", probeOut: `note: same\n\n${warn}\n` }).io)).toEqual({
      guard: "diagnostics",
      refused: `the probe build printed what build A didn't:\n${warn}`,
    });
    expect(resolveMapSlot(req(), fakeIo({ plainOut: "note: same\r\n", probeOut: "  note: same\n" }).io)).toMatchObject({ slot: 4 });
  });

  it("refuses a probe build without the probe, one that moved the layout, an odd body or an out-of-bounds slot", () => {
    const noProbe = buildObject({ code: CODE, chunks: LAYOUT });
    expect(resolveMapSlot(req(), fakeIo({ probe: noProbe }).io)).toEqual({ guard: "probe", refused: "__mcp_p_0 isn't among the probe build's named functions (FNAM)" });
    const moved = probeBuild([0x1d, 4, 0xce], [chunk("MINI", u32(3, 101, 104)), ...LAYOUT.slice(1)]);
    expect(resolveMapSlot(req(), fakeIo({ probe: moved }).io)).toEqual({ guard: "neutrality", refused: "the probe moved the module's layout: chunk MINI differs" });
    expect(resolveMapSlot(req(), fakeIo({ probe: probeBuild([0xa7, 5, 0xce]) }).io)).toEqual({
      guard: "decode",
      refused: "the probe body starts PUSHBYTE 5; RETURNVAL; TERMINATE: a constant, not a variable",
    });
    expect(resolveMapSlot(req(), fakeIo({ probe: probeBuild([0xa7, 14, 0xcf, 6, 0xce]) }).io)).toEqual({
      guard: "bounds",
      refused: "index 14 is past the 14 elements of the array in slot 6",
    });
  });

  it("refuses a slot the module imports, scalar (MIMP) or array (AIMP), and still resolves its own", () => {
    const imports = [
      ...LAYOUT,
      chunk("MIMP", Buffer.concat([u32(1), Buffer.from("lv\0")])),
      chunk("AIMP", Buffer.concat([u32(1, 2, 3), Buffer.from("la\0")])),
    ];
    const plain = buildObject({ code: CODE, chunks: imports });
    const deployed = [{ name: "acs/main.o", data: plain }];
    const run = (expr: string, body: number[]) => resolveMapSlot(req({ expr, deployed }), fakeIo({ plain, probe: probeBuild(body, imports) }).io);
    const why = (name: string, slot: number) => ({
      guard: "import",
      refused:
        `${name} is imported from a library: slot ${slot} of acs/main.o is that library's var only if the library loaded and has the name. ` +
        "Pass that library's source, or use its exported name without sourceFile",
    });
    expect(run("lv", [0x1d, 1, 0xce])).toEqual(why("lv", 1));
    expect(run("la[1]", [0xa7, 1, 0xcf, 2, 0xce])).toEqual(why("la", 2));
    expect(run("hid", [0x1d, 4, 0xce])).toEqual({ slot: 4, digest: imageDigest(plain), module: deployed[0] });
  });
});

// The real compiler on the real fixture, end to end: skipped where zt-bcc isn't installed.
const BCC = findOnPath("zt-bcc", process.env.PATH, defaultCompileDeps.exeExts, defaultCompileDeps.isExec) ??
  findOnPath("bcc", process.env.PATH, defaultCompileDeps.exeExts, defaultCompileDeps.isExec);
describe.skipIf(BCC === undefined)("resolveMapSlot with the real compiler", () => {
  const io: ProbeIo = { readFile: (p) => readFileSync(p), compile: defaultCompileDeps, removeDir };
  const deployed = ["mapslot", "mapslotn"].map((lib) => ({ name: `acs/${lib}.o`, data: read(`res/acs/${lib}.o`) }));
  const resolve = (lib: string, expr: string, over: Partial<MapSlotRequest> = {}) =>
    resolveMapSlot({ sourceFile: path.join(FIXTURE, `${lib}.bcs`), exprs: [expr], deployed, engine, ...over }, io);

  it("resolves every kind of var in both formats", () => {
    for (const { lib, q } of LIBS) {
      EXPRS(q).forEach((expr, i) => expect(resolve(lib, expr)).toMatchObject({ ...SLOTS[i], module: { name: `acs/${lib}.o` } }));
    }
  });

  it("refuses an out-of-range constant index (a warning, exit 0), an unknown name and another module's source", () => {
    expect(resolve("mapslot", "ms_hid_arr[5]")).toMatchObject({ guard: "diagnostics", refused: expect.stringMatching(/index out-of-bounds/) });
    expect(resolve("mapslot", "ms_nope")).toMatchObject({ guard: "compile", refused: expect.stringMatching(/ms_nope/) });
    expect(resolve("mapslot", "ms_hid", { deployed: deployed.slice(1) })).toMatchObject({ guard: "deployed" });
  });

  it("refuses a var the source imports from a library, scalar or array, and resolves the module's own", () => {
    const importer = [{ name: "acs/msimp.o", data: read("import/msimp.o") }];
    const imp = (expr: string) => resolve("import/msimp", expr, { deployed: importer });
    expect(imp("mil_v")).toMatchObject({ guard: "import", refused: expect.stringMatching(/^mil_v is imported from a library: slot 1 of acs\/msimp\.o /) });
    expect(imp("mil_arr[1]")).toMatchObject({ guard: "import", refused: expect.stringMatching(/^mil_arr is imported from a library: slot 2 of acs\/msimp\.o /) });
    expect(imp("mi_own[1]")).toMatchObject({ slot: 0, index: 1, module: importer[0] });
  });
});
