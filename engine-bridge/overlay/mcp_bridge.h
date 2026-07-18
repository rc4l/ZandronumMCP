//
// mcp_bridge.h -- minimal local IPC seam for the Zandronum dev MCP server.
//
// This is an OVERLAY file. It is copied into src/zandronum/src/ by
// engine-bridge/apply-bridge.mjs -- it is NOT committed to the Zandronum tree.
//
// The bridge is deliberately tiny and "dumb": bytes in -> AddCommandString,
// console output -> bytes out. All intelligence (correlation, parsing, every
// feature) lives in the TypeScript MCP server. See ../../PROTOCOL.md.
//
// It is opt-in: the listener only starts when the environment variable
// ZANDRONUM_BRIDGE_PORT is set, and it binds to 127.0.0.1 only.
//
#ifndef __MCP_BRIDGE_H__
#define __MCP_BRIDGE_H__

// Called once per frame from D_DoomLoop. Lazily starts the listener on the
// first call, then drains any queued inbound console commands.
void MCP_Bridge_Poll();

// Mirrors one line of console output to the connected MCP client (NDJSON).
void MCP_Bridge_TeeOutput(const char *text);

// Optional explicit shutdown (process exit also closes the socket).
void MCP_Bridge_Shutdown();

// Arm the crash-backtrace handler (implemented in mcp_crash.cpp). Idempotent and
// opt-in (only arms when ZANDRONUM_BRIDGE_PORT is set). Called early by the bridge.
void MCP_Crash_Init();

#endif // __MCP_BRIDGE_H__
