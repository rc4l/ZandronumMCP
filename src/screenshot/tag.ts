import { randomBytes } from "node:crypto";

/** A capture basename's per-server namespace, PID plus a random token since PID-namespaced sandboxes share small PIDs. */
export function captureTag(pid: number = process.pid, token: Buffer = randomBytes(3)): string {
  return `${pid}_${token.toString("hex")}`;
}

/** This server's tag, fixed for the process like the PID it extends. */
export const CAPTURE_TAG = captureTag();
