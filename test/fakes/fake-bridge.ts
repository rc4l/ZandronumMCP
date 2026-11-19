import net from "node:net";
import { NdjsonDecoder, encodeMessage } from "../../src/bridge/framing.js";
import { PROTOCOL_VERSION } from "../../src/types.js";
import type { BridgeMessage } from "../../src/types.js";

/**
 * A real TCP server that speaks the bridge NDJSON protocol, standing in for a
 * patched engine binary. Lets us integration-test the entire MCP server with no
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

/** The all-normal `mcp_status` snapshot a fake bridge returns by default. */
const DEFAULT_STATUS: Record<string, string> = {
  paused: "0",
  menu: "off",
  console: "up",
  gamestate: "level",
  player: "alive",
  spectating: "0",
  demo: "0",
  automap: "0",
  health: "100",
  armor: "0",
  cheats: "0",
  maptime: "0",
};

export class FakeBridge {
  private readonly server: net.Server;
  private readonly sockets: net.Socket[] = [];
  private readonly handlers: Array<{ match: string; lines: string[]; after: string[] }> = [];
  /** One-shot overrides, each merged into the next `mcp_status` reply only. */
  private readonly statusQueue: Array<Record<string, string>> = [];
  private probesToSwallow = 0;
  private readonly rawHandlers: Array<{ match: string; messages: Record<string, unknown>[] }> = [];
  private readonly swallowed: string[] = [];
  private readonly commandHooks: Array<{ match: string; run: (command: string) => void }> = [];
  /** Every message the client sent — lets tests assert fire-and-forget sends. */
  readonly received: Array<{ t?: string; text?: string }> = [];
  private readonly swallowCommands: boolean;
  private readonly hello?: Record<string, unknown>;
  private readonly eventWaiters: Array<(e: RecordedEvent) => void> = [];
  private readonly pauseWaiters: Array<(v: number) => void> = [];
  readonly events: RecordedEvent[] = [];
  readonly pauses: number[] = [];
  /** Fields echoed back on the mcp_status correlator line. Override with `setStatus`. */
  private status: Record<string, string | undefined> = DEFAULT_STATUS;
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

  /** Reply to any command containing `match` with these output lines; `after`
   *  lines follow the sentinel, like engine output printed a tic later. */
  respondTo(match: string, lines: string[], after: string[] = []): this {
    this.handlers.push({ match, lines, after });
    return this;
  }

  /** Leave the next `count` bare status probes unanswered (a busy engine). */
  swallowProbes(count: number): this {
    this.probesToSwallow = count;
    return this;
  }

  /** Queue one-shot status overrides, consumed one per `mcp_status` reply. */
  queueStatus(...snapshots: Array<Record<string, string>>): this {
    this.statusQueue.push(...snapshots);
    return this;
  }

  /** Run `run` whenever a command containing `match` arrives, before the reply
   *  is built, so a test can model a command's side effect (e.g. a cheat
   *  toggling the status snapshot). */
  onCommand(match: string, run: (command: string) => void): this {
    this.commandHooks.push({ match, run });
    return this;
  }

  /** Accept commands containing `match` but never reply — a deterministic
   *  per-command timeout, without swallowing every other command too. */
  swallow(match: string): this {
    this.swallowed.push(match);
    return this;
  }

  /** Reply with arbitrary (possibly partial) out messages — e.g. missing text/level. */
  respondToRaw(match: string, messages: Record<string, unknown>[]): this {
    this.rawHandlers.push({ match, messages });
    return this;
  }

  /** Push console output nobody asked for — the engine chatters continuously. */
  push(text: string): void {
    for (const s of this.sockets) {
      s.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", text, level: 0 }));
    }
  }

  /** Override/merge fields in the `mcp_status` snapshot this fake returns. */
  setStatus(fields: Record<string, string | undefined>): this {
    this.status = { ...this.status, ...fields };
    return this;
  }

  /** Empty the status line to a bare sentinel, so the client's snapshot comes back undefined. */
  blankStatus(): this {
    this.status = {};
    return this;
  }

  /** Reset the received-message log, so a test can count only the wire traffic
   *  from the call it's actually asserting on — after setup traffic (e.g.
   *  `live()`'s own `attach_instance` refresh) has already landed. */
  clearReceived(): void {
    this.received.length = 0;
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
        this.received.push(msg as { t?: string; text?: string });
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
        } else if (msg.t === "setpause") {
          const v = Number(msg.paused);
          this.pauses.push(v);
          for (const w of this.pauseWaiters.splice(0)) w(v);
        }
      }
    });
    socket.on("error", () => {
      /* ignore client-side resets during teardown */
    });
  }

  private handleCommand(socket: net.Socket, text: string): void {
    if (this.swallowCommands) return;
    // The MCP appends either "; echo <sentinel>" (legacy) or "; mcp_status
    // <sentinel>" (status-capable bridge) to a real command, or sends a bare
    // "mcp_status <sentinel>" with no host command at all (a refreshStatus()
    // probe). Recover the real command (empty for a bare probe) + sentinel.
    const statusMatch = text.match(/^(?:(.+?)\s*;\s*)?mcp_status\s+(\S+)\s*$/);
    const echoMatch = text.match(/^(.*?)\s*;\s*echo\s+(\S+)\s*$/);
    const command = (statusMatch ? (statusMatch[1] ?? "") : echoMatch ? echoMatch[1] : text).trim();
    const sentinel = statusMatch ? statusMatch[2] : echoMatch ? echoMatch[2] : null;
    if (this.swallowed.some((m) => command.includes(m))) return;
    if (statusMatch && !command && this.probesToSwallow > 0) {
      this.probesToSwallow--;
      return;
    }
    for (const h of this.commandHooks) if (command.includes(h.match)) h.run(command);

    const raw = this.rawHandlers.find((h) => command.includes(h.match));
    const handler = raw ? undefined : this.handlers.find((h) => command.includes(h.match));
    if (raw) {
      for (const msg of raw.messages) {
        socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", ...msg }));
      }
    } else {
      for (const line of handler ? handler.lines : []) {
        socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", text: line, level: 0 }));
      }
    }

    if (statusMatch && sentinel) {
      const fields = Object.entries({ ...this.status, ...this.statusQueue.shift() })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      socket.write(
        encodeMessage({ v: PROTOCOL_VERSION, t: "out", text: `${sentinel} ${fields}`, level: 0 }),
      );
    } else if (sentinel) {
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", text: sentinel, level: 0 }));
    }
    for (const line of handler ? handler.after : []) {
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "out", text: line, level: 0 }));
    }
  }

  /** Resolve with the next input event the client posts. */
  waitForEvent(): Promise<RecordedEvent> {
    return new Promise((resolve) => this.eventWaiters.push(resolve));
  }

  /** Resolve with the next setpause value (0/1) the client posts. */
  waitForPause(): Promise<number> {
    return new Promise((resolve) => this.pauseWaiters.push(resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
