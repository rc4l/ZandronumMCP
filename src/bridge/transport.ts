import net from "node:net";
import { EventEmitter } from "node:events";
import { NdjsonDecoder, encodeMessage } from "./framing.js";
import { makeSentinel, withSentinel } from "../correlation/sentinel.js";
import { collectUntilSentinel } from "../correlation/collector.js";
import { PROTOCOL_VERSION } from "../types.js";
import type { BridgeMessage, HelloMessage, OutputMessage } from "../types.js";

export interface BridgeClientOptions {
  host?: string;
  port: number;
  commandTimeoutMs?: number;
}

interface PendingCommand {
  sentinel: string;
  lines: string[];
  resolve: (lines: string[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Talks to one bridge-patched Zandronum instance over loopback TCP.
 *
 * NOTE: console output is a single shared stream, so commands are correlated by
 * a unique echo sentinel and MUST be issued serially per instance. Callers
 * should await each runCommand before sending the next.
 */
export class BridgeClient extends EventEmitter {
  private socket?: net.Socket;
  private readonly decoder = new NdjsonDecoder();
  private pending: PendingCommand[] = [];
  private capsSet = new Set<string>();
  private seq = 0;
  private readonly host: string;
  private readonly port: number;
  private readonly commandTimeoutMs: number;

  constructor(opts: BridgeClientOptions) {
    super();
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 5000;
  }

  connect(): Promise<HelloMessage> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this.socket = socket;
      socket.setEncoding("utf8");

      let settled = false;
      const onConnectError = (err: Error) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
      };
      socket.once("error", onConnectError);

      socket.on("data", (chunk: string) => {
        for (const msg of this.decoder.push(chunk)) {
          if (!settled && msg.t === "hello") {
            settled = true;
            socket.off("error", onConnectError);
            const hello = msg as HelloMessage;
            if (typeof hello.v === "number" && hello.v !== PROTOCOL_VERSION) {
              socket.destroy();
              reject(
                new Error(
                  `Bridge protocol v${hello.v} != client v${PROTOCOL_VERSION}. ` +
                    `Update the engine bridge or pin a matching mcp version.`,
                ),
              );
              return;
            }
            if (Array.isArray(hello.caps)) {
              this.capsSet = new Set(hello.caps);
            }
            resolve(hello);
          }
          this.dispatch(msg);
        }
      });

      socket.on("close", () => {
        this.failAllPending(new Error("Bridge connection closed"));
        this.emit("close");
      });
      // A post-connect socket error (e.g. the game process exiting) is always
      // followed by 'close', which fails pending commands and emits "close".
      // Swallow it here so an unhandled 'error' can't crash the MCP server when
      // the game goes away. (Connect-time errors are handled by onConnectError.)
      socket.on("error", () => {});
    });
  }

  private dispatch(msg: BridgeMessage): void {
    if (msg.t !== "out") return;
    const out = msg as OutputMessage;
    const text = out.text ?? "";
    const level = typeof out.level === "number" ? out.level : 0;
    this.emit("output", text, level);
    for (const cmd of this.pending) {
      cmd.lines.push(text);
    }
    this.checkPending();
  }

  private checkPending(): void {
    for (const cmd of [...this.pending]) {
      const result = collectUntilSentinel(cmd.lines, cmd.sentinel);
      if (result.complete) {
        clearTimeout(cmd.timer);
        this.pending = this.pending.filter((c) => c !== cmd);
        cmd.resolve(result.output);
      }
    }
  }

  runCommand(text: string): Promise<string[]> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("Not connected"));
    const id = (++this.seq).toString(36);
    const sentinel = makeSentinel(id);
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((c) => c.sentinel !== sentinel);
        reject(new Error(`Command timed out after ${this.commandTimeoutMs}ms: ${text}`));
      }, this.commandTimeoutMs);
      this.pending.push({ sentinel, lines: [], resolve, reject, timer });
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, t: "cmd", text: withSentinel(text, sentinel) }),
      );
    });
  }

  /** Whether the connected bridge advertised a capability in its hello. */
  supports(cap: string): boolean {
    return this.capsSet.has(cap);
  }

  /** Post a raw input event to the engine (fire-and-forget; no reply). */
  sendEvent(evtype: number, subtype: number, data1: number, data2 = 0): void {
    const socket = this.socket;
    if (!socket) throw new Error("Not connected");
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "event", evtype, subtype, data1, data2 }));
  }

  private failAllPending(err: Error): void {
    for (const cmd of this.pending) {
      clearTimeout(cmd.timer);
      cmd.reject(err);
    }
    this.pending = [];
  }

  close(): void {
    this.socket?.end();
  }
}
