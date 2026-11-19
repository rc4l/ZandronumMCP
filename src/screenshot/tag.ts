import { randomBytes } from "node:crypto";

/**
 * A capture basename's per-server namespace: the PID plus a random token. A sandbox that
 * unshares the PID namespace gives every session the same small PID, while their engines
 * still write into one shared directory, so the PID alone would let them collide.
 */
export function captureTag(pid: number = process.pid, token: Buffer = randomBytes(3)): string {
  return `${pid}_${token.toString("hex")}`;
}

/** This server's tag, fixed for the process like the PID it extends. */
export const CAPTURE_TAG = captureTag();
