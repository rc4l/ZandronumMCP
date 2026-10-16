import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ServerContext, type ContextIo, type ServerConfig } from "../../src/context.js";
import { registerTools } from "../../src/tools.js";
import { InstanceRegistry } from "../../src/process/registry.js";

/**
 * Boots the real tool layer against an in-memory MCP transport, so tests drive
 * tools exactly as a client does (schema validation included) with no engine,
 * no clock and no filesystem behind them.
 */

/** ContextIo whose every member fails loudly unless a test opts into it. */
export function stubIo(overrides: Partial<ContextIo> = {}): ContextIo {
  const nope = (what: string) => () => {
    throw new Error(`unexpected ${what} in test`);
  };
  return {
    existsSync: () => false,
    readFileSync: nope("readFileSync"),
    readTextSync: nope("readTextSync"),
    readdirSync: nope("readdirSync"),
    stampOf: () => "stamp",
    mtimeOf: nope("mtimeOf"),
    sleep: () => Promise.resolve(), // tests never wait on real time
    // One deterministic tick instead of a real interval, so progress reporting
    // is exercised without the clock.
    every: (_ms, fn) => {
      fn();
      return () => {};
    },
    capture: (_client, dir, opts) =>
      Promise.resolve({ base64: "UE5H", path: `${dir}/${opts?.name ?? "mcp_shot"}.png` }),
    findFreePort: (start) => Promise.resolve(start),
    hasBridge: () => true,
    reap: () => Promise.resolve({ found: [], killed: [], survivors: [] }),
    launchIo: {
      spawn: nope("spawn"),
      waitForPort: () => Promise.resolve(),
      clearQuarantine: () => {},
    },
    compileAcs: nope("compileAcs"),
    removeDir: nope("removeDir"),
    ...overrides,
  };
}

export interface HarnessOptions {
  config?: Partial<ServerConfig>;
  io?: Partial<ContextIo>;
  registry?: InstanceRegistry;
}

export interface Harness {
  client: Client;
  ctx: ServerContext;
  /** Call a tool and return its first text content (or "" for non-text). */
  text: (name: string, args?: Record<string, unknown>) => Promise<string>;
  /** Call a tool and return its LAST text content block (or "" for none) — the
   *  engine-state note, when `registerLive` appends one, is always last. */
  tail: (name: string, args?: Record<string, unknown>) => Promise<string>;
  /** Call a tool and return the raw result. */
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  /** Call a tool, collecting the progress notifications it emits. */
  callWithProgress: (
    name: string,
    args?: Record<string, unknown>,
  ) => Promise<{ result: CallResult; progress: ProgressUpdate[] }>;
  close: () => Promise<void>;
}

export interface ProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export interface CallResult {
  isError?: boolean;
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  structuredContent?: Record<string, unknown>;
}

/** A tool handler as registerTools passes it to the server. */
export type ToolHandler = (
  args: Record<string, unknown>,
  extra: Record<string, unknown>,
) => Promise<CallResult>;

/**
 * Register the tools against a duck-typed server and hand back the raw
 * handlers. For the few cases that need to drive a handler's `extra` directly —
 * a client that has stopped listening for progress, say — which a real
 * client/server pair can't reproduce on demand.
 */
export function collectTools(ctx: ServerContext): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();
  const fakeServer = {
    registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
      handlers.set(name, handler);
    },
  };
  registerTools(fakeServer as unknown as McpServer, ctx);
  return handlers;
}

export async function startHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const config: ServerConfig = {
    host: "127.0.0.1",
    basePort: 7777,
    screenshotDir: "/shots",
    ...opts.config,
  };
  const ctx = new ServerContext(config, stubIo(opts.io), opts.registry ?? new InstanceRegistry());
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }) as Promise<CallResult>;

  return {
    client,
    ctx,
    call,
    callWithProgress: async (name, args = {}) => {
      const progress: ProgressUpdate[] = [];
      // Passing onprogress makes the SDK attach a progressToken to the request.
      const result = (await client.callTool({ name, arguments: args }, undefined, {
        onprogress: (p) => progress.push(p as ProgressUpdate),
      })) as CallResult;
      return { result, progress };
    },
    text: async (name, args) => {
      const result = await call(name, args);
      return result.content?.[0]?.text ?? "";
    },
    tail: async (name, args) => {
      const result = await call(name, args);
      const content = result.content ?? [];
      return content[content.length - 1]?.text ?? "";
    },
    close: async () => {
      ctx.registry.closeAll();
      await client.close();
      await server.close();
    },
  };
}
