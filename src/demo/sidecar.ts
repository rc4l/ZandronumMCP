import path from "node:path";
import { z } from "zod";
import { CHECKPOINT_GROUPS, type Checkpoint, type CheckpointGroup } from "../parsers/checkpoint.js";

/** Version of the persisted `<name>.json` sidecar next to a demo's `.lmp`, bumped on any field change. */
export const SIDECAR_VERSION = 1;

const hashed = z.object({ path: z.string(), sha1: z.string().nullable() });
const fileEntry = hashed.extend({ git: z.object({ rev: z.string(), dirty: z.boolean() }).optional() });
const groups = z.object(Object.fromEntries(CHECKPOINT_GROUPS.map((g) => [g, z.string()])) as Record<CheckpointGroup, z.ZodString>);
const head = z.object({ maptime: z.number(), actors: z.number(), rng: z.string(), hash: z.string(), groups });

const checkpointsSchema = z.object({
  every: z.number().int().positive(),
  /** The engage maptime: the first checkpoint's. */
  start: z.number(),
  /** The maptime the step that reached `demo_end` stopped at. */
  end: z.number(),
  /** The last maptime a seek may ask for. */
  lastPlayable: z.number(),
  blessedAt: z.string(),
  lmpSha1: z.string(),
  /** The instance's files at bless time, the baseline a check reports changes against. */
  files: z.array(fileEntry),
  /** The rows file, next to the sidecar. */
  rows: z.string(),
  heads: z.array(head),
});

export const sidecarSchema = z.object({
  version: z.literal(SIDECAR_VERSION),
  engine: z.string(),
  bridge: z.string().nullable(),
  recordedAt: z.string().nullable(),
  /** Null until a clean quit wrote the take. */
  lmp: z.object({ file: z.string(), bytes: z.number(), sha1: z.string() }).nullable(),
  iwad: hashed.nullable(),
  files: z.array(fileEntry),
  map: z.string().nullable(),
  skill: z.number().nullable(),
  save: hashed.nullable(),
  checkpoints: checkpointsSchema.optional(),
});

export type Sidecar = z.infer<typeof sidecarSchema>;
export type SidecarCheckpoints = z.infer<typeof checkpointsSchema>;
export type CheckpointHead = Omit<Checkpoint, "rows">;
export type FileEntry = z.infer<typeof fileEntry>;

/** Where a demo's sidecar and blessed rows live, next to its `.lmp`. */
export function sidecarPaths(lmp: string): { json: string; rows: string } {
  const base = lmp.replace(/\.lmp$/i, "");
  return { json: `${base}.json`, rows: `${base}.rows.json.gz` };
}

/** A demo name as a `.lmp` path, refusing a relative path since the engine would resolve it from its own cwd. */
export function resolveDemoPath(name: string, dir: string): { path: string } | { error: string } {
  const withExt = /\.lmp$/i.test(name) ? name : `${name}.lmp`;
  if (path.isAbsolute(name)) return { path: withExt };
  if (name.includes("/") || name.includes("\\")) return { error: `demo name ${name}: give a bare name or an absolute path` };
  return { path: path.join(dir, withExt) };
}

/** A sidecar's text, or why it can't be used (an unknown version refuses rather than misreads). */
export function parseSidecar(text: string, file: string): { sidecar: Sidecar } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { error: `${file} is not JSON: ${(e as Error).message}` };
  }
  const version = (raw as { version?: unknown } | null)?.version;
  if (version !== SIDECAR_VERSION) return { error: `${file} has sidecar version ${String(version)}; this server reads ${SIDECAR_VERSION}` };
  const parsed = sidecarSchema.safeParse(raw);
  if (!parsed.success) return { error: `${file} is not a valid sidecar: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}` };
  return { sidecar: parsed.data };
}

export function serializeSidecar(s: Sidecar): string {
  return `${JSON.stringify(s, null, 2)}\n`;
}
