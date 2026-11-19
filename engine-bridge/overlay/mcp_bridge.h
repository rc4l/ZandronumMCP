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
// returning a copy when overridden so the net slot keeps the real input.
struct ticcmd_t;
ticcmd_t *MCP_Input_Override(int player, ticcmd_t *cmd);

// A whole decimal token that fits an int, else false (implemented in mcp_actorstate.cpp).
bool MCP_ParseInt( const char *s, int &out );

// A whole finite number token, else false (implemented in mcp_actorstate.cpp).
bool MCP_ParseNum( const char *s, double &out );

// An ACS script number as written, else a script name's number (implemented in mcp_runacs.inc, in p_acs.cpp).
int MCP_ScriptNumber( const char *script );

// The nearest actor of a class (owned items skipped) or with a TID, never me; NULL if none
// (implemented in mcp_actorstate.cpp).
class AActor;
struct PClass;
AActor *MCP_NearestOfClass( AActor *me, const PClass *type );
AActor *MCP_NearestWithTid( AActor *me, int tid );

// Arm the crash-backtrace handler (implemented in mcp_crash.cpp). Idempotent and
// opt-in (only arms when ZANDRONUM_BRIDGE_PORT is set). Called early by the bridge.
void MCP_Crash_Init();

// The mcp_rec recorder's playsim hooks (mcp_actorstate.cpp), on forward-declared types only since
// this header lands right after a file's first include.
class AActor;
class FName;
class FCommandLine;
class FString;
struct MCPAcsRef { int kind; int num; int index; int module; const void *behavior; };
bool MCP_AcsRefParse( FCommandLine &argv, int first, MCPAcsRef &ref, FString &label, FString &err );
bool MCP_AcsRefRead( const MCPAcsRef &ref, int &value );
extern bool MCP_RecArmed;
void MCP_Rec_TickImpl();
void MCP_Rec_ResetImpl();
void MCP_Rec_PspriteSetImpl( AActor *body, const void *layerObj, int layer );
void MCP_Rec_PspriteClearImpl( AActor *body, int layer );
void MCP_Rec_SpawnImpl( AActor *actor );
void MCP_Rec_DestroyImpl( AActor *actor );
void MCP_Rec_StateImpl( AActor *actor );
void MCP_Rec_DamageImpl( AActor *target, AActor *inflictor, AActor *source, int damage, const FName &mod );
void MCP_Rec_DeathImpl( AActor *actor, AActor *source, AActor *inflictor );
void MCP_Rec_ScriptStartImpl( const void *script, int num, const char *module, AActor *activator );
void MCP_Rec_ScriptEndImpl( const void *script, int num );
inline void MCP_Rec_Tick() { if ( MCP_RecArmed ) MCP_Rec_TickImpl(); }
inline void MCP_Rec_Reset() { if ( MCP_RecArmed ) MCP_Rec_ResetImpl(); }
inline void MCP_Rec_PspriteSet( AActor *body, const void *layerObj, int layer )
{
	if ( MCP_RecArmed ) MCP_Rec_PspriteSetImpl( body, layerObj, layer );
}
inline void MCP_Rec_PspriteClear( AActor *body, int layer )
{
	if ( MCP_RecArmed ) MCP_Rec_PspriteClearImpl( body, layer );
}
inline void MCP_Rec_Spawn( AActor *actor ) { if ( MCP_RecArmed ) MCP_Rec_SpawnImpl( actor ); }
inline void MCP_Rec_Destroy( AActor *actor ) { if ( MCP_RecArmed ) MCP_Rec_DestroyImpl( actor ); }
inline void MCP_Rec_State( AActor *actor ) { if ( MCP_RecArmed ) MCP_Rec_StateImpl( actor ); }
inline void MCP_Rec_Damage( AActor *target, AActor *inflictor, AActor *source, int damage, const FName &mod )
{
	if ( MCP_RecArmed ) MCP_Rec_DamageImpl( target, inflictor, source, damage, mod );
}
inline void MCP_Rec_Death( AActor *actor, AActor *source, AActor *inflictor )
{
	if ( MCP_RecArmed ) MCP_Rec_DeathImpl( actor, source, inflictor );
}
inline void MCP_Rec_ScriptStart( const void *script, int num, const char *module, AActor *activator )
{
	if ( MCP_RecArmed ) MCP_Rec_ScriptStartImpl( script, num, module, activator );
}
inline void MCP_Rec_ScriptEnd( const void *script, int num ) { if ( MCP_RecArmed ) MCP_Rec_ScriptEndImpl( script, num ); }

// The frozen MCP clock (implemented in mcp_clock.cpp).
extern bool MCP_ClockFrozen;
extern bool MCP_ClockArmedDemo;
extern int MCP_ClockFracValue;
enum MCPFrameSlot { MCP_FRAME_FPS, MCP_FRAME_GLMS, MCP_FRAME_TICMS, MCP_FRAME_COUNT };
extern bool MCP_ClockFrameUsed;
unsigned int MCP_Clock_FrameTime( MCPFrameSlot slot, unsigned int real );
bool MCP_Clock_Hold();
inline void MCP_Clock_Clamp( int &counts ) { if ( ( MCP_ClockFrozen || MCP_ClockArmedDemo ) && counts > 1 ) counts = 1; }
void MCP_Clock_AfterDisplay();
// The bridge's setpause: while frozen it sets the pause the thaw restores.
void MCP_Clock_SetPause( int value );
void MCP_Clock_Thaw();
// The bridge's client disconnected: thaws (and disarms), since nobody is left to step the clock.
void MCP_Clock_ClientLost();
// Queues a capture of the next settled frame at frac 1; false when not frozen or the queue is full.
bool MCP_Clock_QueueShot( const char *name );

#endif // __MCP_BRIDGE_H__
