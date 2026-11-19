import path from "node:path";
import type { ContextIo } from "../../src/context.js";
import { PathMap } from "./paths.js";

/** An in-memory file tree for the demo tools' I/O, where a "dir" body is a directory, sha1 is
 *  `sha1(<body>)` and anything under /mod/ sits in a git work tree; keys match on resolved paths. */
export function memFs(initial: Record<string, string> = {}) {
  const files = new PathMap(Object.entries(initial));
  // Buffer writes (the gzipped rows file) as written; `files` holds a placeholder body for them.
  const blobs = new PathMap<Buffer>();
  const dirs: string[] = [];
  const read = (p: string) => {
    const body = files.get(p);
    if (body === undefined) throw new Error(`ENOENT: ${p}`);
    return body;
  };
  const io = {
    existsSync: (p: string) => files.has(p),
    isDirSync: (p: string) => files.get(p) === "dir",
    mkdirp: (d: string) => void dirs.push(d),
    sha1Of: (p: string) => {
      const body = read(p);
      return { sha1: `sha1(${body})`, bytes: body.length };
    },
    gitRevOf: (p: string) => (path.resolve(p).startsWith(path.resolve("/mod") + path.sep) ? { rev: files.get("/mod/.rev") ?? "abc123", dirty: true } : undefined),
    readTextSync: read,
    readFileSync: (p: string) => blobs.get(p) ?? Buffer.from(read(p)),
    writeFileAtomic: (p: string, data: string | Buffer) => {
      if (typeof data === "string") blobs.delete(p);
      else blobs.set(p, data);
      files.set(p, typeof data === "string" ? data : `<${data.length} bytes>`);
    },
    now: () => new Date("2026-11-09T12:00:00Z"),
  } satisfies Partial<ContextIo>;
  return { files, blobs, dirs, io };
}
