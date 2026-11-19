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

// Main-thread dispatch replies stay in the console/log/socket, not the notify area.
bool MCP_Bridge_ShowInNotify( const char *text );
void MCP_Bridge_ReplyBegin();
void MCP_Bridge_ReplyEnd();
class MCPBridgeReplyGuard
{
public:
	MCPBridgeReplyGuard() { MCP_Bridge_ReplyBegin(); }
	~MCPBridgeReplyGuard() { MCP_Bridge_ReplyEnd(); }
	MCPBridgeReplyGuard( const MCPBridgeReplyGuard & ) = delete;
	MCPBridgeReplyGuard &operator=( const MCPBridgeReplyGuard & ) = delete;
};

// Synchronous game code is game output, even when a bridge command started it.
class MCPBridgeReplySuspendGuard
{
	int depth;
public:
	MCPBridgeReplySuspendGuard();
	~MCPBridgeReplySuspendGuard();
	MCPBridgeReplySuspendGuard( const MCPBridgeReplySuspendGuard & ) = delete;
	MCPBridgeReplySuspendGuard &operator=( const MCPBridgeReplySuspendGuard & ) = delete;
};

// Restore reply filtering before the caller formats its result, including failed game calls.
template <class F> auto MCP_GameCall( F fn ) -> decltype( fn() )
{
	MCPBridgeReplySuspendGuard gameOutput;
	return fn();
}

// Writes text to the bridge logfile only: not the console, the HUD notify line or the socket.
void MCP_Bridge_LogLine(const char *text);

// Optional explicit shutdown (process exit also closes the socket).
void MCP_Bridge_Shutdown();

// Replaces the console player's ticcmd while an mcp_input timeline is armed (mcp_input.cpp),
// called from G_Ticker after the real cmd is copied in.
struct ticcmd_t;
void MCP_Input_Override(int player, ticcmd_t *cmd);

// A whole decimal token that fits an int, else false (implemented in mcp_actorstate.cpp).
bool MCP_ParseInt( const char *s, int &out );

// A whole finite number token, else false (implemented in mcp_actorstate.cpp).
bool MCP_ParseNum( const char *s, double &out );

// An ACS script number as written, else a script name's number (implemented in mcp_runacs.inc, in p_acs.cpp).
int MCP_ScriptNumber( const char *script );

// Arm the crash-backtrace handler (implemented in mcp_crash.cpp). Idempotent and
// opt-in (only arms when ZANDRONUM_BRIDGE_PORT is set). Called early by the bridge.
void MCP_Crash_Init();

#endif // __MCP_BRIDGE_H__
