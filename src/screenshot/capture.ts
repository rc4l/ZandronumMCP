import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeClient } from "../bridge/transport.js";

export interface CaptureOptions {
  /** Directory the engine writes screenshots to (its working dir). */
  dir: string;
  /** Base name to use; defaults to a unique generated one. */
  name?: string;
  /** Max poll attempts for the file to appear. */
  attempts?: number;
  /** Delay between poll attempts, in ms. */
  intervalMs?: number;
  /** Timeout for the `screenshot` console command itself. Screenshots can be
   *  slower than the 5s default command timeout on a busy frame, so allow more. */
  commandTimeoutMs?: number;
}

export interface CaptureIo {
  readFile: (path: string) => Promise<Buffer>;
  unlink: (path: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
}

export interface Screenshot {
  name: string;
  path: string;
  base64: string;
}

const defaultIo: CaptureIo = {
  readFile: (path) => readFile(path),
  unlink: (path) => unlink(path),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let counter = 0;

export function screenshotName(seq: number): string {
  return `mcp_shot_${seq}`;
}

/**
 * Issue a `screenshot <name>` console command, wait for the PNG to land in the
 * engine's working dir, and return it base64-encoded.
 *
 * The engine ignores `screenshot_dir` for named screenshots (verified against
 * ZA_3.2.1), so the caller must point `dir` at the engine's working directory.
 */
export async function captureScreenshot(
  client: BridgeClient,
  options: CaptureOptions,
  io: CaptureIo = defaultIo,
): Promise<Screenshot> {
  const name = options.name ?? screenshotName(++counter);
  const path = join(options.dir, `${name}.png`);
  const attempts = options.attempts ?? 40;
  const intervalMs = options.intervalMs ?? 100;

  await client.runCommand(`screenshot ${name}`, options.commandTimeoutMs ?? 15000);

  for (let i = 0; i < attempts; i++) {
    let buf: Buffer;
    try {
      buf = await io.readFile(path);
    } catch {
      if (i < attempts - 1) await io.sleep(intervalMs);
      continue;
    }
    // Got the file — delete it so screenshots don't pile up, then return.
    try {
      await io.unlink(path);
    } catch {
      /* best-effort cleanup; ignore if it's already gone */
    }
    return { name, path, base64: buf.toString("base64") };
  }
  throw new Error(`screenshot ${name}.png did not appear in ${options.dir}`);
}
