import { describe, it, expect } from "vitest";
import path from "node:path";
import { collectAcsLumps, collectAcsModules, collectAcsModulesAt, pickModules, type DirWalkSkips } from "../src/acs/collect.js";
import { parseBehaviorNames } from "../src/acs/bytecode.js";
import { buildWad, buildZip } from "./fakes/wad-builder.js";
import { buildBehaviorAcse } from "./fakes/acs-builder.js";

describe("collectAcsLumps", () => {
  it("finds BEHAVIOR lumps in a plain WAD", () => {
    const wad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "BEHAVIOR", data: buildBehaviorAcse(["wadFunc"], []) },
    ]);
    const lumps = collectAcsLumps(wad);
    expect(lumps).toHaveLength(1);
    expect(parseBehaviorNames(lumps[0]).functions).toEqual(["wadFunc"]);
  });

  it("accepts a raw compiled ACS lump (a .o file) directly", () => {
    const lib = buildBehaviorAcse(["rawFunc"], []);
    const lumps = collectAcsLumps(lib);
    expect(lumps).toHaveLength(1);
    expect(parseBehaviorNames(lumps[0]).functions).toEqual(["rawFunc"]);
  });

  it("finds compiled library lumps and map BEHAVIORs inside a PK3", () => {
    const innerWad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "BEHAVIOR", data: buildBehaviorAcse(["mapFunc"], []) },
    ]);
    const pk3 = buildZip([
      { name: "decorate.txt", data: Buffer.from("actor X {}") }, // ignored
      { name: "acs/lib.o", data: buildBehaviorAcse(["libFunc"], ["libScript"]), method: 8 },
      { name: "maps/MAP01.wad", data: innerWad },
    ]);
    const lumps = collectAcsLumps(pk3);
    const names = lumps.flatMap((l) => parseBehaviorNames(l).functions);
    expect(names).toContain("libFunc"); // compiled library
    expect(names).toContain("mapFunc"); // map BEHAVIOR inside the inner wad
    expect(lumps).toHaveLength(2);
  });
});

describe("collectAcsModules", () => {
  const lib = buildBehaviorAcse(["f"], []);

  it("names a raw lump by the caller's name, defaulting to BEHAVIOR", () => {
    expect(collectAcsModules(lib, "lib.o").map((m) => m.name)).toEqual(["lib.o"]);
    expect(collectAcsModules(lib).map((m) => m.name)).toEqual(["BEHAVIOR"]);
  });

  it("names map BEHAVIORs by their map marker (binary or UDMF), else BEHAVIOR", () => {
    const wad = buildWad("PWAD", [
      { name: "MAP01" },
      { name: "THINGS" },
      { name: "BEHAVIOR", data: lib },
      { name: "MAP02" },
      { name: "TEXTMAP" },
      { name: "BEHAVIOR", data: lib },
      { name: "ENDMAP" },
    ]);
    expect(collectAcsModules(wad).map((m) => m.name)).toEqual(["MAP01", "MAP02"]);
    const bare = buildWad("PWAD", [{ name: "BEHAVIOR", data: lib }]);
    expect(collectAcsModules(bare).map((m) => m.name)).toEqual(["BEHAVIOR"]);
  });

  it("prefixes a pk3's map BEHAVIORs with the wad entry and names libraries by entry", () => {
    const inner = buildWad("PWAD", [{ name: "MAP01" }, { name: "THINGS" }, { name: "BEHAVIOR", data: lib }]);
    const pk3 = buildZip([
      { name: "acs/lib.o", data: lib },
      { name: "maps/MAP01.wad", data: inner },
    ]);
    expect(collectAcsModules(pk3).map((m) => m.name)).toEqual(["acs/lib.o", "maps/MAP01.wad:MAP01"]);
  });
});

describe("collectAcsModulesAt", () => {
  const lib = buildBehaviorAcse(["f"], []);
  const inner = buildWad("PWAD", [{ name: "MAP01" }, { name: "THINGS" }, { name: "BEHAVIOR", data: lib }]);
  // A launch directory, listed out of order.
  const files = new Map<string, Buffer>([
    [path.join("/mod", "LOADACS"), Buffer.from("lib\n")],
    [path.join("/mod", "acs", "lib.o"), lib],
    [path.join("/mod", "acs", "notes.txt"), Buffer.from("x")],
    [path.join("/mod", "maps", "MAP01.WAD"), inner],
  ]);
  const dirs = new Map<string, string[]>([
    [path.join("/mod"), ["maps", "LOADACS", "acs"]],
    [path.join("/mod", "acs"), ["notes.txt", "lib.o"]],
    [path.join("/mod", "maps"), ["MAP01.WAD"]],
  ]);
  const io = {
    isDirSync: (p: string) => dirs.has(p),
    readdirSync: (p: string) => dirs.get(p)!,
    readFileSync: (p: string) => files.get(p)!,
    readHeadSync: (p: string, bytes: number) => files.get(p)!.subarray(0, bytes),
    realpathSync: (p: string) => p,
  };
  const keepAll: DirWalkSkips = () => false;

  it("walks a directory as the engine loads one: libraries and map WADs by relative path, `/`-separated, sorted", () => {
    expect(collectAcsModulesAt(path.join("/mod"), io, keepAll).map((m) => [m.name, m.map])).toEqual([
      ["acs/lib.o", undefined],
      ["maps/MAP01.WAD:MAP01", "MAP01"],
    ]);
  });

  it("reads a walked file whole only if it could hold modules: a .wad by name, else bytecode by its head", () => {
    const files = new Map<string, Buffer>([
      ["BEHAVIOR", lib], // bytecode under a name with no extension
      ["big.pack", Buffer.alloc(1 << 20, 0x78)], // a .git pack, say
      ["inner.pk3", buildZip([{ name: "acs/lib.o", data: lib }])], // one lump in a dir walk, not opened
      ["MAP01.wad", inner],
      ["plain.lmp", inner], // a WAD without the name isn't opened either
      ["tiny", Buffer.from("AC")], // shorter than the magic
      ["fake.wad", lib], // bytecode wins over the name
    ]);
    const root = path.join("/res");
    const whole: string[] = [];
    const io = {
      isDirSync: (p: string) => p === root,
      readdirSync: () => [...files.keys()],
      readFileSync: (p: string) => (whole.push(path.basename(p)), files.get(path.basename(p))!),
      readHeadSync: (p: string, bytes: number) => files.get(path.basename(p))!.subarray(0, bytes),
      realpathSync: (p: string) => p,
    };
    expect(collectAcsModulesAt(root, io, keepAll).map((m) => [m.name, m.map])).toEqual([
      ["BEHAVIOR", undefined],
      ["MAP01.wad:MAP01", "MAP01"],
      ["fake.wad", undefined],
    ]);
    expect(whole).toEqual(["BEHAVIOR", "MAP01.wad", "fake.wad"]);
  });

  /** Walk a fake /mod tree (`tree` dir to entries, `links` symlink to target) under the engine's `skips` policy. */
  const walkTree = (tree: Record<string, string[]>, links: Record<string, string> = {}, skips = keepAll) => {
    const root = path.join("/mod");
    const at = (rel: string) => (rel ? path.join(root, rel) : root);
    const dirs = new Map(Object.entries(tree).map(([rel, names]) => [at(rel), names]));
    const reals = new Map(Object.entries(links).map(([rel, target]) => [at(rel), at(target)]));
    const asked: string[] = [];
    const io = {
      isDirSync: (p: string) => dirs.has(p),
      readdirSync: (p: string) => dirs.get(p)!,
      readFileSync: () => lib,
      readHeadSync: (_p: string, bytes: number) => lib.subarray(0, bytes),
      realpathSync: (p: string) => reals.get(p) ?? p,
    };
    const names = collectAcsModulesAt(root, io, (name, isDir) => (asked.push(`${name}${isDir ? "/" : ""}`), skips(name, isDir))).map((m) => m.name);
    return { names, asked };
  };

  it("skips each entry the engine's policy skips, by name and kind, at any depth", () => {
    // A dot-dir skip (Zandronum's fts walk) at the top level and below; dot-files stay.
    const dotDirs: DirWalkSkips = (name, isDir) => isDir && name.startsWith(".");
    const tree = { "": ["acs", ".git", ".lib.o"], ".git": ["lib.o"], acs: [".old", "lib.o"], "acs/.old": ["lib.o"] };
    const { names, asked } = walkTree(tree, {}, dotDirs);
    expect(names).toEqual([".lib.o", "acs/lib.o"]);
    expect(asked).toEqual([".git/", ".lib.o", "acs/", ".old/", "lib.o"]);
  });

  it("walks every dir the policy keeps, dot-dirs included, and drops the files it skips", () => {
    // A backup-file skip (UZDoom's) with no dot-dir skip.
    const backups: DirWalkSkips = (name, isDir) => !isDir && name.includes(".bak");
    const tree = { "": [".git", "acs"], ".git": ["lib.o"], acs: [".old", "lib.o.bak", "lib.o"], "acs/.old": ["lib.o"] };
    expect(walkTree(tree, {}, backups).names).toEqual([".git/lib.o", "acs/.old/lib.o", "acs/lib.o"]);
  });

  it("cuts a symlink back into a parent", () => {
    // `again` is a symlink to `acs`, `loop` one to the root.
    const tree = { "": ["loop", "acs", "again"], acs: ["lib.o"], again: ["lib.o"], loop: ["acs"] };
    expect(walkTree(tree, { again: "acs", loop: "" }).names).toEqual(["acs/lib.o", "again/lib.o"]);
  });

  it("walks a dir again through a sibling symlink sorting before it, keeping the dir's own entries", () => {
    const tree = { "": ["acs", "aaa_link"], acs: ["mapslot.o"], aaa_link: ["mapslot.o"] };
    expect(walkTree(tree, { aaa_link: "acs" }).names).toEqual(["aaa_link/mapslot.o", "acs/mapslot.o"]);
  });

  it("reads a file as collectAcsModules does, named after itself", () => {
    expect(collectAcsModulesAt(path.join("/mod", "acs", "lib.o"), io, keepAll).map((m) => m.name)).toEqual(["lib.o"]);
    expect(collectAcsModulesAt(path.join("/mod", "maps", "MAP01.WAD"), io, keepAll).map((m) => m.name)).toEqual(["MAP01"]);
    const pk3 = buildZip([{ name: "acs/lib.o", data: lib }]);
    expect(collectAcsModulesAt("/mods/x.pk3", { ...io, readFileSync: () => pk3 }, keepAll).map((m) => m.name)).toEqual(["acs/lib.o"]);
  });

  it("finds none in a file the engine loads as a lone lump, where parseWad would throw", () => {
    for (const text of ["Patch File for DeHackEd v3.0\n", "ab"]) {
      expect(collectAcsModulesAt("/mods/x.deh", { ...io, readFileSync: () => Buffer.from(text) }, keepAll)).toEqual([]);
    }
  });
});

describe("pickModules", () => {
  const modules = ["acs/MyMod.o", "maps/MAP01.wad:MAP01"].map((name) => ({ name, data: Buffer.alloc(0) }));
  const names = (lump?: string) => pickModules(modules, lump).map((m) => m.name);

  it("keeps every module without a lump", () => {
    expect(names()).toHaveLength(2);
  });

  it("matches a full name or an extension-less basename, case-insensitively", () => {
    expect(names("mymod")).toEqual(["acs/MyMod.o"]);
    expect(names("ACS/MYMOD.O")).toEqual(["acs/MyMod.o"]);
    expect(names("maps/map01.wad:map01")).toEqual(["maps/MAP01.wad:MAP01"]);
    expect(names("other")).toEqual([]);
  });
});
