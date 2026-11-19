import path from "node:path";
import { resolveDemoPath, type FileEntry, type Sidecar } from "./sidecar.js";

/** What `play_demo { name }` plays: an absolute path, else `<dir>/<name>.lmp` if it exists, else a sidecar-less WAD lump like `DEMO1`. */
export function resolvePlayTarget(name: string, dir: string | undefined, exists: (p: string) => boolean): { file: string } | { lump: string } {
  if (path.isAbsolute(name)) return { file: /\.lmp$/i.test(name) ? name : `${name}.lmp` };
  const r = dir === undefined ? undefined : resolveDemoPath(name, dir);
  return r && "path" in r && exists(r.path) ? { file: r.path } : { lump: name };
}

/** A demo the server started on an instance, so `seek_demo` can replay it to rewind. */
export interface PlayedDemo {
  /** What the reply calls it: the file, or the lump name. */
  name: string;
  /** The console line that starts it: `[load <save> ;] playdemo <lmp>`. */
  start: string;
  /** From a blessed sidecar: the last maptime a seek may ask for. */
  lastPlayable?: number;
  end?: number;
}

/** A file that differs between a baseline file list and now. */
export interface FileChange {
  path: string;
  kind: "changed" | "gone" | "new";
  /** For a change seen in a git work tree: `old -> new`, short. */
  rev?: string;
}

/** Files whose sha1 or git rev changed, that went away, or that appeared since `was`. */
export function diffFiles(was: FileEntry[], now: FileEntry[]): FileChange[] {
  const cur = new Map(now.map((f) => [f.path, f]));
  const out: FileChange[] = [];
  for (const f of was) {
    const c = cur.get(f.path);
    cur.delete(f.path);
    if (c === undefined) {
      out.push({ path: f.path, kind: "gone" });
      continue;
    }
    // A directory has no sha1, so its work tree's rev is the only change it shows.
    const rev = f.git && c.git && f.git.rev !== c.git.rev ? `${f.git.rev.slice(0, 9)} -> ${c.git.rev.slice(0, 9)}` : undefined;
    if (c.sha1 !== f.sha1 || rev) out.push({ path: f.path, kind: "changed", ...(rev && { rev }) });
  }
  for (const p of cur.keys()) out.push({ path: p, kind: "new" });
  return out;
}

/** Why a demo can't play on this instance, and the files changed since its bless (else its recording). */
export function checkSidecar(recorded: Sidecar, engine: string, current: Sidecar | undefined): { refuse?: string; notes: string[]; changes: FileChange[] } {
  if (recorded.engine !== engine) return { refuse: `recorded on ${recorded.engine}, not ${engine}: its replay can't match`, notes: [], changes: [] };
  if (current === undefined) return { notes: ["(no launch options for this instance, so its iwad and files weren't compared with the recording's)"], changes: [] };
  if (recorded.iwad && current.iwad && recorded.iwad.sha1 !== current.iwad.sha1) {
    return { refuse: `recorded against iwad ${recorded.iwad.path} (sha1 ${recorded.iwad.sha1}), but the instance runs ${current.iwad.path} (sha1 ${current.iwad.sha1}): relaunch with that iwad`, notes: [], changes: [] };
  }
  const blessed = recorded.checkpoints;
  const when = blessed ? "blessing" : "recording";
  const changes = diffFiles(blessed?.files ?? recorded.files, current.files);
  const text: Record<FileChange["kind"], (c: FileChange) => string> = {
    changed: (c) => `${c.path} changed since ${when}${c.rev ? ` (git ${c.rev})` : ""}`,
    gone: (c) => `${c.path} was loaded when ${when}, not now`,
    new: (c) => `${c.path} is loaded now, not when ${when}`,
  };
  return { notes: changes.map((c) => text[c.kind](c)), changes };
}
