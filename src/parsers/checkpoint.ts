import { z } from "zod";
import { matchLines, parseKv } from "./lines.js";

/** `mcp_checkpoint`'s field groups, each an FNV-1a hash of its raw values (grammar: PROTOCOL.md). */
export const CHECKPOINT_GROUPS = ["pos", "vel", "angle", "health", "tics", "state", "inv"] as const;
export type CheckpointGroup = (typeof CHECKPOINT_GROUPS)[number];

/** One actor's raw values: position, velocity and angles as the engine's bits in hex, one width per engine; `h` hashes every group. */
export const checkpointRowSchema = z.object({
  i: z.number(),
  class: z.string(),
  h: z.string(),
  x: z.string(),
  y: z.string(),
  z: z.string(),
  vx: z.string(),
  vy: z.string(),
  vz: z.string(),
  angle: z.string(),
  pitch: z.string(),
  health: z.number(),
  tics: z.number(),
  sprite: z.string(),
  frame: z.string(),
});
export type CheckpointRow = z.infer<typeof checkpointRowSchema>;

/** A replay-stable playsim digest: every field compares as is across replays of one demo. */
export interface Checkpoint {
  maptime: number;
  actors: number;
  rng: string;
  hash: string;
  groups: Record<CheckpointGroup, string>;
  /** Present with `mcp_checkpoint rows`, in thinker order. */
  rows: CheckpointRow[];
}

// String keys per line kind: health and tics are group hashes on the head line, decimal in a row.
const HEAD_STRINGS = ["rng", "hash", ...CHECKPOINT_GROUPS];
const ROW_STRINGS = ["class", "h", "x", "y", "z", "vx", "vy", "vz", "angle", "pitch", "sprite", "frame"];

const kvOf = (lines: string[], tag: string, strings: string[]) =>
  matchLines(lines, new RegExp(`^${tag} (.*)$`), (m) => parseKv(m[1], strings));

/** The `MCP_CHECKPOINT` line and its rows among `lines`, or undefined when the CCMD didn't run or a row is malformed. */
export function parseCheckpoint(lines: string[]): Checkpoint | undefined {
  const head = kvOf(lines, "MCP_CHECKPOINT", HEAD_STRINGS)[0];
  const rows = z.array(checkpointRowSchema).safeParse(kvOf(lines, "MCP_CHECKPOINT_ROW", ROW_STRINGS));
  if (!head || !rows.success) return undefined;
  const groups = Object.fromEntries(CHECKPOINT_GROUPS.map((g) => [g, String(head[g])])) as Record<CheckpointGroup, string>;
  return {
    maptime: Number(head.maptime),
    actors: Number(head.actors),
    rng: String(head.rng),
    hash: String(head.hash),
    groups,
    rows: rows.data,
  };
}

/** Where two checkpoints differ: the groups, and with rows on both, the first differing actor's fields. */
export interface CheckpointDiff {
  equal: boolean;
  /** rng, hash, actors or maptime when those differ, then each differing group. */
  fields: string[];
  /** `only` names the side that has the row when the other lacks it (`fields` is then `["missing"]`). */
  firstRow?: { i: number; class: string; fields: string[]; only?: "a" | "b" };
}

const ROW_FIELDS = ["class", "x", "y", "z", "vx", "vy", "vz", "angle", "pitch", "health", "tics", "sprite", "frame"] as const;

export function diffCheckpoints(a: Checkpoint, b: Checkpoint): CheckpointDiff {
  const top = (["maptime", "actors", "rng", "hash"] as const).filter((k) => a[k] !== b[k]);
  const fields = [...top, ...CHECKPOINT_GROUPS.filter((g) => a.groups[g] !== b.groups[g])];
  const diff: CheckpointDiff = { equal: fields.length === 0, fields };
  if (a.rows.length === 0 || b.rows.length === 0) return diff;
  for (let i = 0; i < Math.max(a.rows.length, b.rows.length); i++) {
    const ra = a.rows[i];
    const rb = b.rows[i];
    if (ra?.h === rb?.h) continue;
    const at = (ra ?? rb)!;
    const differing = ra && rb ? ROW_FIELDS.filter((f) => ra[f] !== rb[f]) : ["missing"];
    // A row prints no inventory, so a hash change with every printed field equal is the inventory.
    diff.firstRow = { i: at.i, class: at.class, fields: differing.length > 0 ? differing : ["inv"] };
    if (!ra || !rb) diff.firstRow.only = ra ? "a" : "b";
    break;
  }
  return diff;
}
