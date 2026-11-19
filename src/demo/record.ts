import path from "node:path";
import type { ContextIo, LaunchArgs } from "../context.js";
import { SIDECAR_VERSION, parseSidecar, resolveDemoPath, serializeSidecar, sidecarPaths, type FileEntry, type Sidecar } from "./sidecar.js";

/** What resolving a launch's `record`/`save` needs to know. */
export interface RecordSetup {
  /** Where a bare `record` name lands. */
  demoDir: string;
  /** Where a bare `save` name lands; undefined refuses one. */
  saveDir: string | undefined;
  recordFromSave: boolean;
  /** The env var that sets `saveDir`, for the refusal text. */
  saveDirEnv: string;
}

/** Launch args with `record` and `save` made absolute ("" clears either), or why they can't launch; creates the demo dir. */
export function resolveRecordArgs(
  args: LaunchArgs,
  setup: RecordSetup,
  io: Pick<ContextIo, "existsSync" | "mkdirp">,
): { args: LaunchArgs } | { error: string } {
  const { record, save, ...rest } = args;
  const out: LaunchArgs = rest;
  if (save) {
    if (!path.isAbsolute(save) && setup.saveDir === undefined) {
      return { error: `save ${save}: give an absolute path, or set ${setup.saveDirEnv}` };
    }
    out.save = path.resolve(setup.saveDir ?? "/", save);
    if (!io.existsSync(out.save)) return { error: `save ${out.save} not found` };
  }
  if (record) {
    const lmp = resolveDemoPath(record, setup.demoDir);
    if ("error" in lmp) return lmp;
    if (io.existsSync(lmp.path)) return { error: `${lmp.path} already exists: pick a new record name` };
    if (out.save && !setup.recordFromSave) return { error: "this engine can't record a demo from a savegame: drop save, or record from a map" };
    io.mkdirp(path.dirname(lmp.path));
    out.record = lmp.path;
  }
  return { args: out };
}

type HashIo = Pick<ContextIo, "isDirSync" | "sha1Of" | "gitRevOf">;

function fileEntry(p: string, io: HashIo): FileEntry {
  const sha1 = io.isDirSync(p) ? null : io.sha1Of(p).sha1;
  const git = io.gitRevOf(p);
  return { path: p, sha1, ...(git && { git }) };
}

/** A recording's sidecar as launched: what it was recorded against, its take not written yet. */
export function launchSidecar(args: LaunchArgs, cwd: string, meta: { engine: string; bridge: string | undefined }, io: HashIo & Pick<ContextIo, "now">): Sidecar {
  const abs = (p: string) => path.resolve(cwd, p);
  return {
    version: SIDECAR_VERSION,
    engine: meta.engine,
    bridge: meta.bridge ?? null,
    recordedAt: io.now().toISOString(),
    lmp: null,
    iwad: args.iwad === undefined ? null : { path: abs(args.iwad), sha1: io.sha1Of(abs(args.iwad)).sha1 },
    files: (args.files ?? []).map((f) => fileEntry(abs(f), io)),
    map: args.map ?? null,
    skill: args.skill ?? null,
    save: args.save === undefined ? null : { path: args.save, sha1: io.sha1Of(args.save).sha1 },
  };
}

/** After the engine quit, the take's size and sha1 into its sidecar, trusting any `.lmp` there since launch refuses an existing one. */
export function finishRecording(
  lmp: string,
  bridge: string | undefined,
  io: Pick<ContextIo, "existsSync" | "sha1Of" | "readTextSync" | "writeFileAtomic">,
): string {
  if (!io.existsSync(lmp)) return `recording not written: ${lmp} (the engine didn't quit cleanly)`;
  const { sha1, bytes } = io.sha1Of(lmp);
  const line = `recorded ${lmp} (${bytes} bytes)`;
  const json = sidecarPaths(lmp).json;
  try {
    const parsed = parseSidecar(io.readTextSync(json), json);
    if ("error" in parsed) return `${line}; sidecar not updated: ${parsed.error}`;
    const s = parsed.sidecar;
    io.writeFileAtomic(json, serializeSidecar({ ...s, bridge: s.bridge ?? bridge ?? null, lmp: { file: path.basename(lmp), bytes, sha1 } }));
  } catch (e) {
    return `${line}; sidecar not updated: ${(e as Error).message}`;
  }
  return line;
}
