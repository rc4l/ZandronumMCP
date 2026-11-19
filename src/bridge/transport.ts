import net from "node:net";
import { EventEmitter } from "node:events";
import { NdjsonDecoder, encodeMessage } from "./framing.js";
import { makeSentinel, statusRequest, withSentinel, stripForeignSentinels } from "../correlation/sentinel.js";
import { collectUntilSentinel } from "../correlation/collector.js";
import { parseStatus, type EngineStatus } from "../parsers/status.js";
import { PROTOCOL_VERSION } from "../types.js";
import type { BridgeMessage, HelloMessage, OutputMessage } from "../types.js";

/** How long a bare status refresh may take before it's abandoned. Short and
 *  fixed — this is a between-commands cache-freshening probe, not a command a
 *  caller is waiting on, so it must never be the thing that makes a tool call
 *  slow. */
const STATUS_REFRESH_TIMEOUT_MS = 500;
/** Most idle-time output messages kept for the next status probe. */
const UNCLAIMED_MAX = 50;

/** One `readStatus` round trip: the parsed snapshot (undefined on a timeout,
 *  a disconnect or a capless bridge) plus any other output that arrived meanwhile. */
export interface StatusRead {
  status: EngineStatus | undefined;
  lines: string[];
}

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
 * Talks to one bridge-patched engine instance over loopback TCP.
 *
 * NOTE: console output is a single shared stream with no per-command framing —
 * correlation is by unique echo sentinel, which only works if exactly one
 * command is in flight at a time. Overlapping commands would let an earlier
 * command's output land in a later one's buffer (the later sentinel arrives
 * last, so it collects everything before it). MCP clients happily issue tool
 * calls in parallel, so `runCommand` serialises them here rather than trusting
 * callers to await in order.
 */
export class BridgeClient extends EventEmitter {
  private socket?: net.Socket;
  private readonly decoder = new NdjsonDecoder();
  /** The one command currently on the wire, if any. */
  private pending?: PendingCommand;
  /** Tail of the serialisation chain; the next command starts when it settles. */
  private queue: Promise<unknown> = Promise.resolve();
  private capsSet = new Set<string>();
  /** Count of commands sent on the wire, and the source of each one's
   *  correlation id. Starts at 0 (load-bearing: `registerLive` in tools.ts
   *  snapshots this before a handler runs and compares after, and "no client
   *  yet" vs. "client at its initial count" must be distinguishable from a
   *  client that has actually sent a command). */
  private seq = 0;
  /** Count of input events posted, so `registerLive` can tell an input tool. */
  private events = 0;
  private lastStatusValue: EngineStatus | undefined;
  /** Output that arrived with nothing on the wire since the last command
   *  started; the next status probe hands it back (bounded). */
  private unclaimed: string[] = [];
  private readonly host: string;
  private readonly port: number;
  private readonly commandTimeoutMs: number;
  private enginePidValue?: number;
  private engineNameValue?: string;

  constructor(opts: BridgeClientOptions) {
    super();
    this.host = opts.host ?? "127.0.0.1";
    this.port = opts.port;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 5000;
  }

  /** PID the engine advertised in its hello, or undefined on an older bridge.
   *  Lets the launcher verify it attached to the process it spawned, not a stale
   *  engine that happened to still hold the port. */
  get enginePid(): number | undefined {
    return this.enginePidValue;
  }

  /** Engine name the bridge advertised in its hello (the adapter's `id`), or undefined if it sent none. */
  get engineName(): string | undefined {
    return this.engineNameValue;
  }

  /** The engine-state fields from the most recent completed round trip (a real
   *  command's own sentinel line, or a bare `refreshStatus()` probe), or
   *  `undefined` if none has completed yet or the bridge has no `status` cap. */
  get lastStatus(): EngineStatus | undefined {
    return this.lastStatusValue;
  }

  /** Number of commands sent on the wire so far (0-based start — see the field
   *  comment). Public so `registerLive` can tell whether a tool handler ran a
   *  console command without having to track it itself. */
  get commandCount(): number {
    return this.seq;
  }

  /** Number of input events posted so far (`sendEvent`). */
  get eventCount(): number {
    return this.events;
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
            if (typeof hello.pid === "number") {
              this.enginePidValue = hello.pid;
            }
            if (typeof hello.engine === "string") {
              this.engineNameValue = hello.engine;
            }
            resolve(hello);
          }
          this.dispatch(msg);
        }
      });

      socket.on("close", () => {
        this.failPending(new Error("Bridge connection closed"));
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
    const cmd = this.pending;
    if (!cmd) {
      // e.g. a load error printed a tic after `load` returned, before the next probe.
      this.unclaimed.push(text);
      if (this.unclaimed.length > UNCLAIMED_MAX) this.unclaimed.shift();
      return;
    }
    // A timed-out status probe's reply can land late, inside the next command.
    const own = stripForeignSentinels(text, cmd.sentinel);
    if (own === undefined) return;
    cmd.lines.push(own);
    const result = collectUntilSentinel(cmd.lines, cmd.sentinel);
    if (result.complete) {
      clearTimeout(cmd.timer);
      this.pending = undefined;
      // `text` is the just-arrived line, which is the one that made
      // `collectUntilSentinel` complete (an earlier sentinel-bearing line would
      // already have resolved `cmd` on a prior dispatch, so `cmd` would be
      // undefined here). Cached unconditionally: a legacy bare-echo line parses
      // to `undefined` and simply leaves the previous value alone -- the
      // engine's own `echo` CCMD (c_console.cpp) prints a single argument as
      // exactly that argument plus a newline, so a bare `echo <sentinel>` line
      // is never anything but the sentinel on its own.
      const status = parseStatus(text, cmd.sentinel);
      if (status) this.lastStatusValue = status;
      cmd.resolve(result.output);
    }
  }

  /**
   * Run a console command and resolve with the output it produced.
   *
   * Queued behind any command already in flight on this client, so overlapping
   * callers (parallel MCP tool calls) can't cross-contaminate each other's
   * output. The timeout covers the command's own run, not its wait in the queue.
   */
  runCommand(text: string, timeoutMs?: number): Promise<string[]> {
    return this.enqueue(() => this.execCommand(text, timeoutMs));
  }

  /**
   * Chain `exec` behind whatever is already queued, regardless of how that
   * settled, so overlapping callers (parallel MCP tool calls, or a status
   * refresh landing between them) can't cross-contaminate each other's output.
   * Shared by `runCommand` and `refreshStatus` — a refresh probe is still one
   * command on the wire and must obey the same one-at-a-time invariant.
   */
  private enqueue<T>(exec: () => Promise<T>): Promise<T> {
    const result = this.queue.then(exec, exec);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private execCommand(text: string, timeoutMs?: number): Promise<string[]> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error("Not connected"));
    const id = (++this.seq).toString(36);
    const sentinel = makeSentinel(id);
    const effectiveTimeout = timeoutMs ?? this.commandTimeoutMs;
    this.unclaimed = [];
    return new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Serialised, so whatever is pending at this point is this command.
        this.pending = undefined;
        reject(new Error(`Command timed out after ${effectiveTimeout}ms: ${text}`));
      }, effectiveTimeout);
      this.pending = { sentinel, lines: [], resolve, reject, timer };
      socket.write(
        encodeMessage({
          v: PROTOCOL_VERSION,
          t: "cmd",
          text: withSentinel(text, sentinel, this.supports("status")),
        }),
      );
    });
  }

  /**
   * Refresh `lastStatus` between commands — e.g. after an input-only tool call
   * (mouse move, menu key) that ran no console command, so the cached state
   * doesn't predate whatever that call just did. A no-op on a bridge without
   * the `status` cap: MUST return before touching the queue or the socket, or
   * every tool call on a capless bridge would pay for a probe that can never
   * complete.
   *
   * Best-effort bookkeeping, never something a tool call should fail over:
   * a 500 ms `readStatus` whose result is dropped.
   */
  refreshStatus(): Promise<void> {
    return this.readStatus(STATUS_REFRESH_TIMEOUT_MS).then(() => undefined);
  }

  /**
   * One exact status read: the parsed snapshot, or `status: undefined` when it
   * timed out (e.g. the engine is busy loading a map) or the connection dropped;
   * never a rejection. Also returns any other output collected while waiting,
   * and since the last command finished (minus late foreign sentinel lines).
   * Clears `lastStatus` first so a failed read yields no note rather than a stale
   * one. A capless bridge resolves at once without touching the queue or socket.
   */
  readStatus(timeoutMs: number): Promise<StatusRead> {
    if (!this.supports("status")) return Promise.resolve({ status: undefined, lines: [] });
    this.lastStatusValue = undefined;
    return this.enqueue(() => this.execStatusOnly(timeoutMs)).catch(() => ({
      status: undefined,
      lines: [],
    }));
  }

  /**
   * The bare `mcp_status <sentinel>` probe: unlike `execCommand`, the sentinel
   * IS the entire wire text (no host command riding alongside it) — the line
   * is self-correlating, so this needs no no-op command and makes no
   * assumption about any other CCMD's zero-argument behavior.
   *
   * No `!socket` guard: unlike `execCommand`, this is only ever reached via
   * `readStatus`, which already gated on `supports("status")` — a cap that
   * is only ever set from a `hello` on a socket that has already connected.
   */
  private execStatusOnly(timeoutMs: number): Promise<StatusRead> {
    const socket = this.socket!;
    const id = (++this.seq).toString(36);
    const sentinel = makeSentinel(id);
    const lines = this.unclaimed.flatMap((t) => stripForeignSentinels(t, sentinel) ?? []);
    this.unclaimed = [];
    return new Promise<StatusRead>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        resolve({ status: undefined, lines });
      }, timeoutMs);
      // `dispatch` caches the status line's fields just before resolving.
      const done = (output: string[]) => resolve({ status: this.lastStatusValue, lines: output });
      this.pending = { sentinel, lines, resolve: done, reject, timer };
      socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "cmd", text: statusRequest(sentinel) }));
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
    this.events++;
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "event", evtype, subtype, data1, data2 }));
  }

  /**
   * Set the engine's master pause flag directly (fire-and-forget; requires the
   * "time" cap). Unpausing lets a backgrounded window keep advancing tics, which
   * single-player otherwise freezes on focus loss. Callers should gate on
   * `supports("time")` and degrade gracefully on older bridges.
   */
  setPause(paused: boolean): void {
    const socket = this.socket;
    if (!socket) throw new Error("Not connected");
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "setpause", paused: paused ? 1 : 0 }));
  }

  /**
   * Send a console command without waiting for a reply. `runCommand` correlates
   * output with an echoed sentinel, which can never come back for a command that
   * ends the process — so shutdown commands (`quit`) must go out fire-and-forget.
   */
  sendCommand(text: string): void {
    const socket = this.socket;
    if (!socket) throw new Error("Not connected");
    socket.write(encodeMessage({ v: PROTOCOL_VERSION, t: "cmd", text }));
  }

  private failPending(err: Error): void {
    const cmd = this.pending;
    if (!cmd) return;
    clearTimeout(cmd.timer);
    this.pending = undefined;
    cmd.reject(err);
  }

  close(): void {
    this.socket?.end();
  }
}
