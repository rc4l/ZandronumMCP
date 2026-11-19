//
// mcp_clock.cpp -- the MCP-owned frozen clock (overlay file).
//
// Holds the tic clock at a virtual (tic, frac) pair with the sim unpaused, so the main loop keeps
// redrawing one mid-tic frame through the normal interpolation code.
//
#include "doomtype.h"
#include "basictypes.h"
#include "c_dispatch.h"
#include "c_console.h"
#include "c_cvars.h"
#include "cl_demo.h"
#include "d_event.h"
#include "doomstat.h"
#include "g_level.h"
#include "i_system.h"
#include "m_misc.h"
#include "r_utility.h"
#include "v_video.h"
#include "network.h"
#include "mcp_bridge.h"
#include <stdlib.h>
#include <string.h>
#include <chrono>
#include <deque>
#include <string>
#include <thread>

EXTERN_CVAR( Bool, cl_capfps )
EXTERN_CVAR( Bool, screenshot_quiet )

#define MCP_CLOCK_MAX_JOBS 256
// A shot renders this many frames at its frac before the capture, so a read after the buffer
// swap returns a frame at that frac whatever the swap model.
#define MCP_CLOCK_SETTLE_FRAMES 3
#define MCP_CLOCK_STALL_MS 1000
#define MCP_CLOCK_IDLE_SLEEP_MS 10

bool MCP_ClockFrozen = false;
bool MCP_ClockArmedDemo = false; // `freeze demo`: freezes once an offline demo has run its first tic
int MCP_ClockFracValue = FRACUNIT;

struct MCPClockJob
{
	bool        shot;
	int         left;  // tics a step still runs
	int         k, n;  // a shot's frac, k/n
	std::string name;
};

static int ( *g_origGetTime )( bool ) = NULL;
static int ( *g_origWaitForTic )( int ) = NULL;
static int g_vtic = 0;   // the held tic while frozen
static int g_offset = 0; // real minus virtual while thawed
static int g_restorePaused = 0;
static std::deque<MCPClockJob> g_jobs;
static int g_fracK = 1, g_fracN = 1;
static int g_steps = 0, g_shots = 0;
static const char *g_reason = "-";
// A step tic let through by MCP_Clock_Hold that the frame hasn't settled yet.
static bool g_pending = false;
static int g_pendGametic = 0, g_pendMaptime = 0;
static bool g_pendLoad = false; // a level or save load runs at the top of that tic
static unsigned int g_pendSince = 0;
// Frames the head shot still renders at its frac, 0 while it hasn't started.
static int g_settle = 0;
// A demo played while frozen, so the stepped tic that ends it ends the job with demo_end.
static bool g_sawDemo = false;
static bool g_restoreSkipped = false;

bool MCP_ClockFrameUsed = false;
static bool g_frameTime = false;
static bool g_rebaseTicMS = false;
struct MCPFrameClock
{
	unsigned int offset, anchor, tic, last;
	bool held, rebase;
};
static MCPFrameClock g_frameClocks[MCP_FRAME_COUNT] = {};

unsigned int MCP_Clock_FrameTime( MCPFrameSlot slot, unsigned int real )
{
	if ( !MCP_ClockFrameUsed ) return real;
	MCPFrameClock &clock = g_frameClocks[slot];
	if ( clock.rebase )
	{
		clock.offset = real - clock.last;
		clock.rebase = false;
	}
	if ( g_frameTime )
	{
		// Anchor on the first held source read, never in the CCMD.
		if ( !clock.held )
		{
			clock.anchor = real - clock.offset;
			clock.tic = (unsigned int)g_vtic;
			clock.held = true;
		}
		clock.last = clock.anchor + (unsigned long long)( (unsigned int)g_vtic - clock.tic ) * 1000 / TICRATE;
		if ( slot == MCP_FRAME_TICMS ) g_rebaseTicMS = true;
	}
	else clock.last = real - clock.offset;
	return clock.last;
}

static void MCP_Clock_SetFrameTime( bool held )
{
	if ( held == g_frameTime ) return;
	g_frameTime = held;
	if ( held ) MCP_ClockFrameUsed = true;
	else for ( MCPFrameClock &clock : g_frameClocks )
	{
		if ( clock.held ) clock.rebase = true;
		clock.held = false;
	}
}

// Real minus the offset, so time resumes at the held tic after a thaw and never runs backwards.
static int MCP_Clock_GetTime( bool saveMS )
{
	if ( MCP_ClockFrozen ) return g_vtic;
	const int time = g_origGetTime( saveMS ) - g_offset;
	// TicStart resumes only on a live saved read, even if frame time was already released.
	if ( saveMS && g_rebaseTicMS )
	{
		g_frameClocks[MCP_FRAME_TICMS].rebase = true;
		g_rebaseTicMS = false;
	}
	return time;
}

// Only reached frozen on a step, when the held tic is already past prevtic.
static int MCP_Clock_WaitForTic( int prevtic )
{
	if ( MCP_ClockFrozen ) return g_vtic;
	return g_origWaitForTic( prevtic + g_offset ) - g_offset;
}

static void MCP_Clock_Install()
{
	if ( g_origGetTime != NULL ) return;
	// The first call picks the timer (I_SelectTimer), which rewrites all three pointers.
	I_GetTime( false );
	g_origGetTime = I_GetTime;
	g_origWaitForTic = I_WaitForTic;
	I_GetTime = MCP_Clock_GetTime;
	I_WaitForTic = MCP_Clock_WaitForTic;
}

static void MCP_Clock_SetFrac( int k, int n )
{
	g_fracK = k;
	g_fracN = n;
	MCP_ClockFracValue = int( (long long)k * FRACUNIT / n );
}

static bool MCP_Clock_Interp()
{
	return !r_NoInterpolate && !cl_capfps;
}

static void MCP_Clock_Abort( const char *reason )
{
	g_jobs.clear();
	g_pending = false;
	g_settle = 0;
	MCP_Clock_SetFrac( 1, 1 );
	g_reason = reason;
}

static void MCP_Clock_PopJob()
{
	g_jobs.pop_front();
	if ( g_jobs.empty() ) g_reason = "done";
}

static bool MCP_Clock_MenuOrConsole()
{
	return menuactive != MENU_Off || ConsoleState != c_up;
}

// A game action G_Ticker runs at the top of the next tic that changes or reloads the level, not
// ga_newgame2 (`map`), whose tic only turns it into ga_newgame and runs on the old level.
static bool MCP_Clock_LoadPending()
{
	switch ( gameaction )
	{
		case ga_loadlevel: case ga_newgame: case ga_loadgame: case ga_loadgamehidecon:
		case ga_loadgameplaydemo: case ga_autoloadgame: case ga_playdemo: case ga_completed: case ga_worlddone:
			return true;
		default:
			return false;
	}
}

// Why a capture can't be queued now (D_Display presents nothing under -nodraw or without a screen), or NULL.
static const char *MCP_Clock_ShotRefusal()
{
	if ( !MCP_ClockFrozen ) return "not frozen";
	if ( gamestate != GS_LEVEL ) return "not in a level";
	if ( nodrawers || screen == NULL ) return "no display";
	return NULL;
}

static bool MCP_Clock_QueueJob( const MCPClockJob &job )
{
	if ( g_jobs.size() >= MCP_CLOCK_MAX_JOBS ) return false;
	g_jobs.push_back( job );
	g_reason = "-";
	return true;
}

static void MCP_Clock_PrintStatus()
{
	FString line;
	line.Format( "MCP_CLOCK frozen=%d gametic=%d maptime=%d frac=%d/%d interp=%d", MCP_ClockFrozen ? 1 : 0, gametic,
		level.maptime, g_fracK, g_fracN, MCP_Clock_Interp() ? 1 : 0 );
	if ( !MCP_Clock_Interp() ) line.AppendFormat( " nointerp=%s", cl_capfps ? "cl_capfps" : "r_NoInterpolate" );
	line.AppendFormat( " jobs=%u steps=%d shots=%d reason=%s", (unsigned)g_jobs.size(), g_steps, g_shots, g_reason );
	line.AppendFormat( " frametime=%d framems=%u armed=%s", g_frameTime ? 1 : 0, g_frameClocks[MCP_FRAME_FPS].last,
		MCP_ClockArmedDemo ? "demo" : "0" );
	Printf( "%s\n", line.GetChars() );
}

// Client demos replay server messages, not inputs, so holding the clock can't hold one.
static const char *MCP_Clock_ArmRefusal()
{
	if ( NETWORK_GetState() == NETSTATE_SERVER || NETWORK_InClientMode() ) return "netgame";
	if ( CLIENTDEMO_IsPlaying() ) return "client demo playback";
	if ( singletics ) return "singletics";
	return NULL;
}

static const char *MCP_Clock_FreezeRefusal()
{
	const char *why = MCP_Clock_ArmRefusal();
	if ( why != NULL ) return why;
	if ( gamestate != GS_LEVEL ) return "not in a level";
	if ( gameaction != ga_nothing ) return "a game action is pending";
	if ( MCP_Clock_MenuOrConsole() ) return "menu or console open";
	return NULL;
}

static void MCP_Clock_Engage()
{
	MCP_Clock_Install();
	// The wrapper's value is at least every value it has returned, so the held tic never goes back.
	g_vtic = I_GetTime( false );
	// Not a focus-loss pause (-1): focus can come back while frozen, and thaw would restore it.
	g_restorePaused = paused > 0 ? paused : 0;
	paused = 0;
	MCP_ClockFrozen = true;
	MCP_ClockArmedDemo = false;
	g_sawDemo = false;
	g_jobs.clear();
	g_pending = false;
	g_settle = 0;
	g_steps = g_shots = 0;
	MCP_Clock_SetFrac( 1, 1 );
}

static void MCP_Clock_Freeze()
{
	if ( MCP_ClockFrozen ) { MCP_Clock_PrintStatus(); return; }
	const char *why = MCP_Clock_FreezeRefusal();
	if ( why != NULL ) { Printf( "error %s\n", why ); return; }
	MCP_Clock_Engage();
	// One live tic, so r_NoInterpolate is cleared and the held frame interpolates.
	MCPClockJob step = { false, 1, 1, 1, "" };
	MCP_Clock_QueueJob( step );
	Printf( "MCP_CLOCK frozen=1 gametic=%d maptime=%d restore=%d jobs=%u\n", gametic, level.maptime, g_restorePaused,
		(unsigned)g_jobs.size() );
}

// Armed from the console line that starts the demo, so a pending game action or open console is fine.
static void MCP_Clock_Arm()
{
	if ( MCP_ClockFrozen ) { MCP_Clock_PrintStatus(); return; }
	const char *why = MCP_Clock_ArmRefusal();
	if ( why != NULL ) { Printf( "error %s\n", why ); return; }
	MCP_ClockArmedDemo = true;
	Printf( "MCP_CLOCK armed=demo frozen=0\n" );
}

// The armed freeze engages, with no step queued, at the top of the first frame after the tic that
// ran the demo's first ticcmd; a level load without a demo disarms.
static void MCP_Clock_CheckArmed()
{
	if ( demoplayback && gamestate == GS_LEVEL && gameaction == ga_nothing )
	{
		MCP_Clock_Engage();
		FString line;
		line.Format( "MCP_CLOCK frozen=1 maptime=%d restore=%d jobs=0 armed=demo\n", level.maptime, g_restorePaused );
		// Gamelog and bridge log only: a notify line never ages while frozen.
		MCP_Bridge_LogLine( line );
		Printf( PRINT_LOG, "%s", line.GetChars() );
	}
	else if ( !demoplayback && gameaction != ga_playdemo && gameaction != ga_loadgameplaydemo && MCP_Clock_LoadPending() )
		MCP_ClockArmedDemo = false;
}

void MCP_Clock_Thaw()
{
	MCP_ClockArmedDemo = false;
	if ( !MCP_ClockFrozen ) return;
	if ( !g_jobs.empty() ) MCP_Clock_Abort( "stopped" );
	MCP_Clock_SetFrameTime( false );
	g_offset = g_origGetTime( false ) - g_vtic;
	MCP_ClockFrozen = false;
	g_sawDemo = false;
	MCP_Clock_SetFrac( 1, 1 );
	// A paused tic around a demo desyncs it: recorded it is simulated on replay, played it is read and skipped.
	g_restoreSkipped = demorecording || demoplayback;
	paused = g_restoreSkipped ? 0 : g_restorePaused;
}

void MCP_Clock_ClientLost()
{
	if ( !MCP_ClockFrozen && !MCP_ClockArmedDemo ) return;
	MCP_Clock_Thaw();
	Printf( "MCP_CLOCK frozen=0: the MCP client disconnected\n" );
}

void MCP_Clock_SetPause( int value )
{
	if ( MCP_ClockFrozen ) g_restorePaused = value;
	else paused = value;
}

bool MCP_Clock_QueueShot( const char *name )
{
	if ( MCP_Clock_ShotRefusal() != NULL ) return false;
	MCPClockJob shot = { true, 0, 1, 1, name };
	return MCP_Clock_QueueJob( shot );
}

bool MCP_Clock_Hold()
{
	if ( MCP_ClockArmedDemo ) MCP_Clock_CheckArmed();
	if ( !MCP_ClockFrozen ) return false;
	// Stock Zandronum pauses on focus loss (paused -1), which would make every step a paused tic.
	if ( paused < 0 ) paused = 0;
	if ( g_jobs.empty() || g_jobs.front().shot ) return true;
	if ( !g_pending )
	{
		g_pending = true;
		g_pendGametic = gametic;
		g_pendMaptime = level.maptime;
		g_pendLoad = MCP_Clock_LoadPending();
		g_pendSince = I_MSTime();
	}
	// Each step is a fresh tic for NetUpdate, so a ticcmd is built and TryRunTics never waits.
	g_vtic++;
	return false;
}

// The step tic let through this frame: counted when maptime moved by one on the same level, else the job ends.
static void MCP_Clock_SettleTic()
{
	if ( gametic == g_pendGametic )
	{
		if ( I_MSTime() - g_pendSince >= MCP_CLOCK_STALL_MS ) MCP_Clock_Abort( "stalled" );
		return;
	}
	g_pending = false;
	MCP_Clock_SetFrac( 1, 1 );
	// A hub return or save load restores its own maptime, so any move but +1 is a new level.
	int moved = level.maptime - g_pendMaptime;
	if ( gamestate != GS_LEVEL || g_pendLoad || ( moved != 0 && moved != 1 ) ) { MCP_Clock_Abort( "level_change" ); return; }
	// gametic also moves on a paused tic (a pause net command, a menu a human opened).
	if ( moved == 0 ) { MCP_Clock_Abort( "paused" ); return; }
	g_steps++;
	if ( --g_jobs.front().left == 0 ) MCP_Clock_PopJob();
}

static void MCP_Clock_RunShot()
{
	MCPClockJob &job = g_jobs.front();
	if ( g_settle == 0 )
	{
		if ( job.k < job.n && !MCP_Clock_Interp() ) { MCP_Clock_Abort( "nointerp" ); return; }
		MCP_Clock_SetFrac( job.k, job.n );
		g_settle = MCP_CLOCK_SETTLE_FRAMES;
		return;
	}
	if ( --g_settle > 0 ) return;
	// Quiet, since a held frame never ages notify lines, so a "Captured" line would sit in every later frame.
	const bool quiet = screenshot_quiet;
	screenshot_quiet = true;
	M_ScreenShot( job.name.c_str() );
	screenshot_quiet = quiet;
	g_shots++;
	MCP_Clock_SetFrac( 1, 1 );
	MCP_Clock_PopJob();
}

void MCP_Clock_AfterDisplay()
{
	if ( !MCP_ClockFrozen ) return;
	if ( g_pending ) MCP_Clock_SettleTic();
	// After the settle, so the tic that read the demo's end still counts as a step.
	if ( g_sawDemo && !demoplayback )
	{
		MCP_Clock_Abort( "demo_end" );
		g_sawDemo = false;
	}
	if ( demoplayback ) g_sawDemo = true;
	if ( !g_jobs.empty() && gamestate != GS_LEVEL ) MCP_Clock_Abort( "level_change" );
	if ( !g_jobs.empty() && g_jobs.front().shot ) MCP_Clock_RunShot();
	if ( g_jobs.empty() ) std::this_thread::sleep_for( std::chrono::milliseconds( MCP_CLOCK_IDLE_SLEEP_MS ) );
}

static void MCP_Clock_Step( FCommandLine &argv )
{
	int n;
	if ( argv.argc() < 3 || !MCP_ParseInt( argv[2], n ) || n < 1 ) { Printf( "error usage: mcp_clock step <n>\n" ); return; }
	if ( !MCP_ClockFrozen ) { Printf( "error not frozen\n" ); return; }
	if ( paused > 0 ) { Printf( "error paused\n" ); return; }
	if ( MCP_Clock_MenuOrConsole() ) { Printf( "error menu or console open\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	MCPClockJob step = { false, n, 1, 1, "" };
	if ( !MCP_Clock_QueueJob( step ) ) { Printf( "error queue full\n" ); return; }
	Printf( "MCP_CLOCK queued jobs=%u\n", (unsigned)g_jobs.size() );
}

static void MCP_Clock_FrameTimeCommand( FCommandLine &argv )
{
	int held;
	if ( argv.argc() != 3 || !MCP_ParseInt( argv[2], held ) || ( held != 0 && held != 1 ) )
	{
		Printf( "error usage: mcp_clock frametime <0|1>\n" );
		return;
	}
	if ( !MCP_ClockFrozen ) { Printf( "error not frozen\n" ); return; }
	MCP_Clock_SetFrameTime( held != 0 );
	// Report the last source read without making a premature first held read here.
	Printf( "MCP_CLOCK frametime=%d framems=%u\n", held, g_frameClocks[MCP_FRAME_FPS].last );
}

static void MCP_Clock_Shot( FCommandLine &argv )
{
	int k = 1, n = 1;
	bool frac = argv.argc() >= 5;
	if ( argv.argc() < 3 || argv.argc() == 4 || ( frac && ( !MCP_ParseInt( argv[3], k ) || !MCP_ParseInt( argv[4], n ) ) ) ||
		n < 1 || k < 0 || k > n )
	{
		Printf( "error usage: mcp_clock shot <name> [<k> <N>], 0 <= k <= N\n" );
		return;
	}
	const char *why = MCP_Clock_ShotRefusal();
	if ( why != NULL ) { Printf( "error %s\n", why ); return; }
	// A step queued ahead decides interpolation by the time this shot runs; it is checked then.
	bool stepAhead = false;
	for ( const MCPClockJob &j : g_jobs ) stepAhead = stepAhead || !j.shot;
	if ( k < n && !stepAhead && !MCP_Clock_Interp() )
	{
		Printf( "error interpolation off (%s)\n", cl_capfps ? "cl_capfps" : "r_NoInterpolate" );
		return;
	}
	MCPClockJob shot = { true, 0, k, n, argv[2] };
	if ( !MCP_Clock_QueueJob( shot ) ) { Printf( "error queue full\n" ); return; }
	Printf( "MCP_CLOCK queued jobs=%u\n", (unsigned)g_jobs.size() );
}

// Unsafe: a shot writes a file at the path it names, so menus and mod scripts can't run it.
UNSAFE_CCMD( mcp_clock )
{
	const char *sub = ( argv.argc() >= 2 ) ? argv[1] : "";
	if ( stricmp( sub, "freeze" ) == 0 )
	{
		if ( argv.argc() >= 3 && stricmp( argv[2], "demo" ) == 0 ) MCP_Clock_Arm();
		else if ( argv.argc() >= 3 ) Printf( "error usage: mcp_clock freeze [demo]\n" );
		else MCP_Clock_Freeze();
	}
	else if ( stricmp( sub, "thaw" ) == 0 )
	{
		if ( !MCP_ClockFrozen ) { MCP_ClockArmedDemo = false; Printf( "MCP_CLOCK frozen=0\n" ); return; }
		MCP_Clock_Thaw();
		Printf( "MCP_CLOCK frozen=0 maptime=%d paused=%d%s\n", level.maptime, paused, g_restoreSkipped ? " restore_skipped=demo" : "" );
	}
	else if ( stricmp( sub, "step" ) == 0 ) MCP_Clock_Step( argv );
	else if ( stricmp( sub, "frametime" ) == 0 ) MCP_Clock_FrameTimeCommand( argv );
	else if ( stricmp( sub, "shot" ) == 0 ) MCP_Clock_Shot( argv );
	else if ( stricmp( sub, "stop" ) == 0 )
	{
		unsigned dropped = (unsigned)g_jobs.size();
		if ( dropped > 0 ) MCP_Clock_Abort( "stopped" );
		MCP_ClockArmedDemo = false;
		Printf( "MCP_CLOCK stopped dropped=%u\n", dropped );
	}
	else if ( stricmp( sub, "status" ) == 0 ) MCP_Clock_PrintStatus();
	else Printf( "error usage: mcp_clock freeze|thaw|frametime|step|shot|stop|status\n" );
}
