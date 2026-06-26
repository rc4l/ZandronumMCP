/** Wire protocol version. Bump ONLY when the NDJSON contract changes. */
export const PROTOCOL_VERSION = 1;

/** Base shape of every NDJSON message on the bridge. */
export interface BridgeMessage {
  v: number;
  t: string;
  [key: string]: unknown;
}

/** Sent by the engine immediately on connect. */
export interface HelloMessage extends BridgeMessage {
  t: "hello";
  engine?: string;
  mode?: string;
  bridge?: string;
  pid?: number;
  /** Capabilities the bridge supports, e.g. ["cmd", "event"]. */
  caps?: string[];
}

/** A line of console output, streamed asynchronously by the engine. */
export interface OutputMessage extends BridgeMessage {
  t: "out";
  text: string;
  level?: number;
}

/** A console command, sent by the MCP server to the engine. */
export interface CommandMessage extends BridgeMessage {
  t: "cmd";
  text: string;
}

/** One row parsed from the `dumpactors` console command. */
export interface ActorClassInfo {
  name: string;
  edNum: number;
  spawnId: number;
  filter: string;
  source: string;
}

/** One running script parsed from the `scriptstat` console command. */
export interface RunningScript {
  /** Script number, or null for a named script. */
  number: number | null;
  /** Script name, or null for a numbered script. */
  name: string | null;
  /** Execution state, e.g. "Running", "Delayed", "Suspended". */
  state: string;
}
