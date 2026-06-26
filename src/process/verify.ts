import { readFileSync } from "node:fs";

/**
 * The string the engine bridge compiles into the binary — it reads this env var
 * to decide whether to start the listener (see
 * engine-bridge/overlay/mcp_bridge.cpp). It is present in every bridge-patched
 * build and absent from a stock Zandronum (and from GZDoom), so its presence is a
 * cheap, reliable way to tell a patched engine from one the MCP can't drive.
 */
export const BRIDGE_MARKER = "ZANDRONUM_BRIDGE_PORT";

/**
 * Whether the binary at `exePath` is a bridge-patched build (contains the marker).
 *
 * `read` is injectable for tests. A read failure propagates to the caller, which
 * should check the path exists first so it can report that distinctly.
 */
export function hasBridge(
  exePath: string,
  read: (p: string) => Buffer = (p) => readFileSync(p),
): boolean {
  return read(exePath).includes(BRIDGE_MARKER);
}
