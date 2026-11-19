import { describe, it, expect } from "vitest";
import { diffCheckpoints, parseCheckpoint, type Checkpoint } from "../src/parsers/checkpoint.js";

const HEAD = "MCP_CHECKPOINT maptime=71 actors=2 rng=0a1b2c3d hash=00000010 pos=11111111 vel=22222222 angle=33333333 health=44444444 tics=55555555 state=66666666 inv=77777777";
const row = (i: number, h: string, extra = "") =>
  `MCP_CHECKPOINT_ROW i=${i} class=DoomImp h=${h} x=00100000 y=fff00000 z=00000000 vx=00000000 vy=00000000 vz=00000000 angle=40000000 pitch=00000000 health=60 tics=8 sprite=TROO frame=A${extra}`;

const parse = (lines: string[]) => parseCheckpoint(lines)!;

describe("parseCheckpoint", () => {
  it("keeps every hash and raw value as its hex string, counts as numbers", () => {
    const cp = parse([HEAD, row(0, "00000001"), row(1, "00000002")]);
    expect(cp).toMatchObject({ maptime: 71, actors: 2, rng: "0a1b2c3d", hash: "00000010" });
    expect(cp.groups).toEqual({ pos: "11111111", vel: "22222222", angle: "33333333", health: "44444444", tics: "55555555", state: "66666666", inv: "77777777" });
    expect(cp.rows[0]).toEqual({
      i: 0, class: "DoomImp", h: "00000001", x: "00100000", y: "fff00000", z: "00000000", vx: "00000000", vy: "00000000",
      vz: "00000000", angle: "40000000", pitch: "00000000", health: 60, tics: 8, sprite: "TROO", frame: "A",
    });
  });

  it("is undefined without the header line, and has no rows without the rows form", () => {
    expect(parseCheckpoint(["error usage: mcp_checkpoint [rows]"])).toBeUndefined();
    expect(parse([HEAD]).rows).toEqual([]);
  });

  it("is undefined with a malformed row", () => {
    expect(parseCheckpoint([HEAD, row(0, "00000001").replace("health=60 ", "")])).toBeUndefined();
  });
});

describe("diffCheckpoints", () => {
  const base = parse([HEAD, row(0, "00000001"), row(1, "00000002")]);
  const edit = (f: (c: Checkpoint) => void) => {
    const c = structuredClone(base);
    f(c);
    return c;
  };

  it("finds nothing between equal checkpoints", () => {
    expect(diffCheckpoints(base, structuredClone(base))).toEqual({ equal: true, fields: [] });
  });

  it("names the differing top fields and groups, then the first differing row and its fields", () => {
    const b = edit((c) => {
      c.hash = "00000011";
      c.groups.state = "66666667";
      c.rows[1] = { ...c.rows[1], h: "00000003", frame: "B" };
    });
    expect(diffCheckpoints(base, b)).toEqual({ equal: false, fields: ["hash", "state"], firstRow: { i: 1, class: "DoomImp", fields: ["frame"] } });
  });

  it("reads a row hash change with equal printed fields as inventory, and an extra row as missing", () => {
    const inv = edit((c) => (c.rows[0] = { ...c.rows[0], h: "0000000f" }));
    expect(diffCheckpoints(base, inv).firstRow).toEqual({ i: 0, class: "DoomImp", fields: ["inv"] });
    const extra = edit((c) => c.rows.push({ ...c.rows[1], i: 2, h: "00000009" }));
    expect(diffCheckpoints(base, extra).firstRow).toEqual({ i: 2, class: "DoomImp", fields: ["missing"], only: "b" });
    expect(diffCheckpoints(extra, base).firstRow).toEqual({ i: 2, class: "DoomImp", fields: ["missing"], only: "a" });
  });

  it("names no row when either side has none", () => {
    const b = edit((c) => (c.rows = []));
    expect(diffCheckpoints(base, b)).toEqual({ equal: true, fields: [] });
  });
});
