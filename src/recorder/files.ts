/** Where `mcp_rec dump` writes: one temp dir per server, made on first use, keeping the newest files. */
import path from "node:path";
import { tmpdir } from "node:os";
import type { ContextIo } from "../context.js";

/** Dump files kept per server; naming a new one deletes the oldest past this. */
export const REC_KEEP = 20;

/** Names each dump `mcp-rec-<instance>-<n>.txt` (the engine writes only `mcp-rec-*`), reading `io` per call. */
export function recDumpFiles(io: () => Pick<ContextIo, "mkdtemp" | "removeFile">, tmp: () => string = tmpdir) {
  let made: string | undefined;
  let n = 0;
  const named: string[] = [];
  const dir = () => (made ??= io().mkdtemp(path.join(tmp(), "mcp-rec-")));
  return {
    dir,
    next(instance: number): string {
      const file = path.join(dir(), `mcp-rec-${instance}-${++n}.txt`);
      named.push(file);
      for (const old of named.splice(0, Math.max(0, named.length - REC_KEEP))) io().removeFile(old);
      return file;
    },
  };
}
