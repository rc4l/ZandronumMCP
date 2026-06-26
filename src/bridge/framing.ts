import type { BridgeMessage } from "../types.js";

/** Serialize a message to a single NDJSON line (newline-terminated). */
export function encodeMessage(msg: BridgeMessage): string {
  return JSON.stringify(msg) + "\n";
}

/**
 * Streaming NDJSON decoder. Feed it raw socket chunks; it returns whole
 * messages and buffers any trailing partial line until the rest arrives.
 *
 * Pure and I/O-free — this is the most-tested unit in the bridge layer.
 */
export class NdjsonDecoder {
  private buffer = "";

  push(chunk: string): BridgeMessage[] {
    this.buffer += chunk;
    const messages: BridgeMessage[] = [];
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) continue;
      const parsed = tryParse(line);
      if (parsed) messages.push(parsed);
    }
    return messages;
  }

  /** Bytes buffered but not yet terminated by a newline. */
  get pending(): number {
    return this.buffer.length;
  }
}

function tryParse(line: string): BridgeMessage | null {
  try {
    const obj: unknown = JSON.parse(line);
    if (obj && typeof obj === "object" && typeof (obj as BridgeMessage).t === "string") {
      return obj as BridgeMessage;
    }
    return null;
  } catch {
    return null;
  }
}
