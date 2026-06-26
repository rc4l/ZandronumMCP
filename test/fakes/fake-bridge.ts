import net from "node:net";
import { NdjsonDecoder, encodeMessage } from "../../src/bridge/framing.js";
import { PROTOCOL_VERSION } from "../../src/types.js";
import type { BridgeMessage } from "../../src/types.js";

/**
 * A real TCP server that speaks the bridge NDJSON protocol, standing in for a
 * patched zandronum.exe. Lets us integration-test the entire MCP server with no
 * game running: register canned responses per command substring, and the fake
 * replays them followed by the echoed sentinel so correlation completes.
 *
 * This is test-only code (not counted in coverage), so it carries extra hooks
 * — custom hello, raw out messages, graceful/abrupt teardown — purely to drive
 * the client's edge-case branches deterministically.
 */
export interface FakeBridgeOptions {
  /** Accept commands but never reply (not even the sentinel) — forces a client timeout. */
  swallowCommands?: boolean;
  /** Override the hello message sent on connect (e.g. a mismatched/absent version). */
  hello?: Record<string, unknown>;
}

export interface RecordedEvent {
  evtype: number;
  subtype: number;
  data1: number;
  data2: number;
}

export class FakeBridge {
  private readonly server: net.Server;
  private readonly sockets: net.Socket[] = [];
  private readonly handlers: Array<{ match: string; lines: string[] }> = [];
  private readonly rawHandlers: Array<{ match: string; messages: Record<string, unknown>[] }> = [];
  private readonly swallowCommands: boolean;
  private readonly hello?: Record<string, unknown>;
  private readonly eventWaiters: Array<(e: RecordedEvent) => void> = [];
  readonly events: RecordedEvent[] = [];
  port = 0;

  private constructor(server: net.Server, opts: FakeBridgeOptions) {
    this.server = server;
    this.swallowCommands = opts.swallowCommands ?? false;
    this.hello = opts.hello;
  }

  static start(opts: FakeBridgeOptions = {}): Promise<FakeBridge> {
    return new Promise((resolve) => {
      const server = net.createServer();
      const fake = new FakeBridge(server, opts);
      server.on("connection", (socket) => fake.handleConnection(socket));
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") fake.port = addr.port;
        resolve(fake);
      });
    });
  }

  /** Reply to any command containing `match` with these output lines. */
  respondTo(match: string, lines: string[]): this {
    this.handlers.push({ match, lines });
    return this;
  }

  /** Reply with arbitrary (possibly partial) out messages — e.g. missing text/level. */
  respondToRaw(match: string, messages: Record<string, unknown>[]): this {
    this.rawHandlers.push({ match, messages });
    return this;
  }

  /** Gracefully FIN every open connection (client sees a clean close). */
  endClients(): void {
    for (const s of this.sockets) s.end();
  }

  /** Abruptly reset every open connection (client sees an error). */
  resetClients(): void {
    for (const s of this.sockets) s.resetAndDestroy();
  }

  private handleConnection(socket: net.Socket): void {
    this.sockets.push(socket);
    socket.setEncoding("utf8");
    const hello: BridgeMessage = (this.hello as BridgeMessage) ?? {
      v: PROTOCOL_VERSION,
      t: "hello",
      engine: "fake",
      mode: "single",
      bridge: "0.0.0-test",
    };
    socket.write(encodeMessage(hello));
    const decoder = new NdjsonDecoder();
    socket.on("data", (chunk: string) => {
      for (const msg of decoder.push(chunk)) {
        if (msg.t === "cmd" && typeof msg.text === "string") {
          this.handleCommand(socket, msg.text);
        } else if (msg.t === "event") {
          const ev: RecordedEvent = {
            evtype: Number(msg.evtype),
            subtype: Number(msg.subtype),
            data1: Number(msg.data1),
            data2: Number(msg.data2),
          };
          this.events.push(ev);
          for (const w of this.eventWaiters.splice(0)) w(ev);
        }
      }
    });
    socket.on("error", () => {
      /* ignore client-side resets during teardown */
    });
  }

  private handleCommand(socket: net.Socket, text: string): void {
    if (this.swallowCommands) return;
    // The MCP appends "; echo <sentinel>"; recover the real command + sentinel.
    const echoMatch = text.match(/^(.*?)\s*;\s*echo\s+(\S+)\s*$/);
    const command = (echoMatch ? echoMatch[1] : text).trim();
    const sentinel = echoMatch ? echoMatch[2] : null;

    const raw = this.rawHandlers.find((h) => command.includes(h.match));
    if (raw) {
      for (const msg of raw.messages) {
        socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", ...msg }));
      }
    } else {
      const handler = this.handlers.find((h) => command.includes(h.match));
      for (const line of handler ? handler.lines : []) {
        socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", text: line, level: 0 }));
      }
    }

    if (sentinel) {
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", text: sentinel, level: 0 }));
    }
  }

  /** Resolve with the next input event the client posts. */
  waitForEvent(): Promise<RecordedEvent> {
    return new Promise((resolve) => this.eventWaiters.push(resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
