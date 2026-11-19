import { describe, it, expect } from "vitest";
import { parseSidecar, resolveDemoPath, serializeSidecar, sidecarPaths, type Sidecar } from "../src/demo/sidecar.js";
import { norm } from "./fakes/paths.js";

const SIDECAR: Sidecar = {
  version: 1,
  engine: "zandronum",
  bridge: "0.16.0",
  recordedAt: "2026-11-09T12:00:00Z",
  lmp: { file: "route1.lmp", bytes: 3312, sha1: "aa" },
  iwad: { path: "/w/DOOM2.WAD", sha1: "bb" },
  files: [{ path: "/m/mod.pk3", sha1: "cc", git: { rev: "dd", dirty: false } }, { path: "/m/dir", sha1: null }],
  map: "MAP02",
  skill: 4,
  save: null,
  checkpoints: {
    every: 35,
    start: 1,
    end: 707,
    lastPlayable: 706,
    blessedAt: "2026-11-09T12:05:00Z",
    lmpSha1: "aa",
    files: [{ path: "/m/mod.pk3", sha1: "cc" }],
    rows: "route1.rows.json.gz",
    heads: [{ maptime: 1, actors: 190, rng: "r", hash: "h", groups: { pos: "1", vel: "2", angle: "3", health: "4", tics: "5", state: "6", inv: "7" } }],
  },
};

describe("demo sidecar", () => {
  it("round-trips through its text form", () => {
    expect(parseSidecar(serializeSidecar(SIDECAR), "f.json")).toEqual({ sidecar: SIDECAR });
  });

  it("refuses non-JSON, an unknown version and a malformed body, naming the file", () => {
    expect(parseSidecar("{", "f.json")).toMatchObject({ error: expect.stringMatching(/^f\.json is not JSON: /) });
    expect(parseSidecar('{"version":2}', "f.json")).toEqual({ error: "f.json has sidecar version 2; this server reads 1" });
    expect(parseSidecar("null", "f.json")).toEqual({ error: "f.json has sidecar version undefined; this server reads 1" });
    const bad = parseSidecar(JSON.stringify({ ...SIDECAR, skill: "hard" }), "f.json");
    expect(bad).toMatchObject({ error: expect.stringMatching(/^f\.json is not a valid sidecar: skill: /) });
  });

  it("resolves names under the demo dir and keeps absolute paths", () => {
    expect(resolveDemoPath("m1", "/demos")).toEqual({ path: norm("/demos/m1.lmp") });
    expect(resolveDemoPath("m1.LMP", "/demos")).toEqual({ path: norm("/demos/m1.LMP") });
    expect(resolveDemoPath("/abs/take", "/demos")).toEqual({ path: "/abs/take.lmp" });
    expect(resolveDemoPath("sub/m1", "/demos")).toEqual({ error: "demo name sub/m1: give a bare name or an absolute path" });
    expect(resolveDemoPath("sub\\m1", "/demos")).toMatchObject({ error: expect.any(String) });
  });

  it("puts the sidecar and rows next to the lmp", () => {
    expect(sidecarPaths("/d/route1.lmp")).toEqual({ json: "/d/route1.json", rows: "/d/route1.rows.json.gz" });
  });
});
