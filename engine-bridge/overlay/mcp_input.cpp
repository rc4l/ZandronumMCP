//
// mcp_input.cpp -- scripted per-tic player input (overlay file).
//
// A timeline is a list of segments, each holding one input for N tics. While one
// is armed, MCP_Input_Override replaces the console player's ticcmd inside
// G_Ticker, right after the engine copied the real one in, for exactly the tics
// scheduled. Offline only. Grammar and replies: ../../PROTOCOL.md (mcp_input).
//
#include "doomtype.h"
#include "c_dispatch.h"
#include "c_console.h"
#include "actor.h"
#include "d_player.h"
#include "d_event.h"
#include "d_ticcmd.h"
#include "doomstat.h"
#include "g_level.h"
#include "m_fixed.h"
#include "tables.h"
#include "templates.h"
#include "network.h"
#include "mcp_bridge.h"
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// The host enforces the same caps (src/input/timeline.ts).
#define MCP_INPUT_MAX_SEGS 64
#define MCP_INPUT_MAX_TICS 2100

struct MCPInputSeg
{
	int     tics;
	DWORD   buttons;
	short   forward, side, up;
	bool    hasAngle, hasPitch;
	angle_t angle; // absolute heading, held for the whole segment
	double  turn;  // BAM per tic, used when there is no absolute heading
	fixed_t pitch; // absolute view pitch; negative looks up
};

// The player after one consumed tic. maptime is the tic the input was applied in.
struct MCPInputRow
{
	int     maptime, seg, health;
	fixed_t x, y, z, momx, momy, momz, pitch;
	angle_t angle;
	DWORD   buttons;
};

static const struct { const char *name; DWORD bit; } MCP_INPUT_BUTTONS[] = {
	{ "attack", BT_ATTACK }, { "altattack", BT_ALTATTACK }, { "use", BT_USE }, { "jump", BT_JUMP },
	{ "crouch", BT_CROUCH }, { "reload", BT_RELOAD }, { "zoom", BT_ZOOM }, { "speed", BT_SPEED },
	{ "strafe", BT_STRAFE }, { "turn180", BT_TURN180 }, { "user1", BT_USER1 }, { "user2", BT_USER2 },
	{ "user3", BT_USER3 }, { "user4", BT_USER4 },
};

static MCPInputSeg g_segs[MCP_INPUT_MAX_SEGS];
static int         g_nsegs = 0;
static int         g_total = 0;      // tics across all segments
static bool        g_bad = false;    // a seg failed since the last clear
static bool        g_armed = false;
static bool        g_pauseAfter = false;
static const char *g_reason = "-";
static int         g_consumed = 0;   // tics that ran; also the trail row count
static int         g_segIdx = 0;     // segment of the next tic
static int         g_segDone = 0;    // tics of g_segIdx already consumed
static bool        g_pending = false; // an entry is applied and its tic hasn't been counted
static int         g_pendingMaptime = 0;
static int         g_lastMaptime = 0;
static double      g_turnAcc = 0;    // BAM remainder below one yaw unit
static short       g_turnYaw = 0;
static FString     g_map;
static MCPInputRow g_start;
static MCPInputRow g_trail[MCP_INPUT_MAX_TICS];

// Bounded, so an angle can't overflow its conversion.
static bool MCPI_Num( const char *s, double &out )
{
	return MCP_ParseNum( s, out ) && fabs( out ) < 1e9;
}

static FString MCPI_ButtonNames( DWORD bits )
{
	FString s;
	for ( size_t i = 0; i < countof( MCP_INPUT_BUTTONS ); i++ )
	{
		if ( !( bits & MCP_INPUT_BUTTONS[i].bit ) ) continue;
		if ( s.Len() > 0 ) s += ",";
		s += MCP_INPUT_BUTTONS[i].name;
	}
	return s.Len() > 0 ? s : FString( "-" );
}

// "attack,use" or "-" to button bits; false names the unknown one in err.
static bool MCPI_ParseButtons( const char *list, DWORD &out, FString &err )
{
	out = 0;
	if ( strcmp( list, "-" ) == 0 ) return true;
	for ( const char *p = list; ; )
	{
		const char *comma = strchr( p, ',' );
		size_t len = ( comma != NULL ) ? size_t( comma - p ) : strlen( p );
		size_t i = 0;
		for ( ; i < countof( MCP_INPUT_BUTTONS ); i++ )
		{
			const char *name = MCP_INPUT_BUTTONS[i].name;
			if ( strlen( name ) == len && strnicmp( p, name, len ) == 0 ) break;
		}
		if ( i == countof( MCP_INPUT_BUTTONS ) )
		{
			err.Format( "unknown button '%.*s' (known: %s)", int( len ), p, MCPI_ButtonNames( ~DWORD( 0 ) ).GetChars() );
			return false;
		}
		out |= MCP_INPUT_BUTTONS[i].bit;
		if ( comma == NULL ) return true;
		p = comma + 1;
	}
}

// A BAM difference as ticcmd yaw/pitch units (BAM >> 16), rounded to nearest.
static short MCPI_Delta16( int bam )
{
	int d = int( ( SQWORD( bam ) + 0x8000 ) >> 16 );
	return short( clamp( d, -32768, 32767 ) );
}

static void MCPI_Snapshot( MCPInputRow &r, int maptime, int seg, DWORD buttons )
{
	memset( &r, 0, sizeof( r ) );
	r.maptime = maptime;
	r.seg = seg;
	r.buttons = buttons;
	AActor *mo = players[consoleplayer].mo;
	if ( mo == NULL ) return;
	r.x = mo->x; r.y = mo->y; r.z = mo->z;
	r.momx = mo->velx; r.momy = mo->vely; r.momz = mo->velz;
	r.angle = mo->angle;
	r.pitch = mo->pitch;
	r.health = mo->health;
}

static void MCPI_PrintRow( const char *tag, const MCPInputRow &r )
{
	Printf( "%s maptime=%d seg=%d x=%.3f y=%.3f z=%.3f angle=%.3f pitch=%.3f momx=%.4f momy=%.4f momz=%.4f health=%d buttons=%s\n",
		tag, r.maptime, r.seg, FIXED2FLOAT( r.x ), FIXED2FLOAT( r.y ), FIXED2FLOAT( r.z ),
		r.angle / double( ANGLE_1 ), r.pitch / double( ANGLE_1 ),
		FIXED2FLOAT( r.momx ), FIXED2FLOAT( r.momy ), FIXED2FLOAT( r.momz ),
		r.health, MCPI_ButtonNames( r.buttons ).GetChars() );
}

// A marker the host splits the log on: bridge log and gamelog only, never the console or HUD.
static void MCPI_LogMarker( const char *text )
{
	MCP_Bridge_LogLine( text );
	Printf( PRINT_LOG, "%s", text );
}

static void MCPI_Disarm( const char *reason );

// Counts the applied entry once maptime shows its tic ran, disarming as done after the last one
// here so a status read while paused sees it.
static void MCPI_Settle()
{
	if ( !g_armed || !g_pending || level.maptime <= g_pendingMaptime ) return;
	g_pending = false;
	MCPI_Snapshot( g_trail[g_consumed], g_pendingMaptime, g_segIdx + 1, g_segs[g_segIdx].buttons );
	g_consumed++;
	if ( ++g_segDone >= g_segs[g_segIdx].tics )
	{
		g_segIdx++;
		g_segDone = 0;
	}
	if ( g_segIdx >= g_nsegs ) MCPI_Disarm( "done" );
}

// Every disarm puts the pause back when the timeline was armed on a paused game.
static void MCPI_Disarm( const char *reason )
{
	g_armed = false;
	g_pending = false;
	g_reason = reason;
	if ( g_pauseAfter && gamestate == GS_LEVEL ) paused = 1;
	FString marker;
	marker.Format( "MCP_INPUT_END reason=%s consumed=%d maptime=%d\n", reason, g_consumed, level.maptime );
	MCPI_LogMarker( marker );
}

static void MCPI_Apply( const MCPInputSeg &s, usercmd_t &u, AActor *mo, bool fresh )
{
	memset( &u, 0, sizeof( u ) );
	// The direction bits G_BuildTiccmd sets from held keys, so ACS GetPlayerInput sees them.
	u.buttons = s.buttons
		| ( s.forward > 0 ? BT_FORWARD : s.forward < 0 ? BT_BACK : 0 )
		| ( s.side > 0 ? BT_MOVERIGHT : s.side < 0 ? BT_MOVELEFT : 0 )
		| ( s.up > 0 ? BT_MOVEUP : s.up < 0 ? BT_MOVEDOWN : 0 )
		| ( s.turn > 0 ? BT_LEFT : s.turn < 0 ? BT_RIGHT : 0 );
	u.forwardmove = s.forward;
	u.sidemove = s.side;
	u.upmove = s.up;
	if ( s.hasAngle )
	{
		// From the live angle, so a yaw a turn180 or freeze ate is retried next tic.
		u.yaw = MCPI_Delta16( int( s.angle - mo->angle ) );
	}
	else
	{
		if ( fresh )
		{
			g_turnAcc += s.turn;
			g_turnYaw = short( clamp( floor( g_turnAcc / 65536.0 ), -32768.0, 32767.0 ) );
			g_turnAcc -= g_turnYaw * 65536.0;
		}
		u.yaw = g_turnYaw;
	}
	if ( s.hasPitch )
	{
		// The engine subtracts the delta; exactly -32768 would mean "center view".
		short d = MCPI_Delta16( mo->pitch - s.pitch );
		u.pitch = ( d == -32768 ) ? short( -32767 ) : d;
	}
}

// Called from G_Ticker for each player, after the tic's real cmd was copied into *cmd.
void MCP_Input_Override( int player, ticcmd_t *cmd )
{
	if ( !g_armed || player != consoleplayer ) return;
	AActor *mo = players[consoleplayer].mo;
	// A maptime that jumped is a load of the same map: one application drives at most one tic.
	if ( gamestate != GS_LEVEL || mo == NULL || g_map.CompareNoCase( level.mapname ) != 0 ||
		level.maptime < g_lastMaptime || ( g_pending && level.maptime > g_pendingMaptime + 1 ) )
	{
		MCPI_Disarm( "level_change" );
		return;
	}
	if ( paused ) return;
	MCPI_Settle();
	if ( !g_armed ) return;
	g_lastMaptime = level.maptime;
	if ( g_consumed >= g_total )
	{
		// Pausing here stops this tic's P_Ticker, so exactly the scheduled tics ran.
		MCPI_Disarm( "done" );
		return;
	}
	// A tic a menu stopped leaves maptime alone: the same entry is applied again.
	bool fresh = !g_pending;
	if ( fresh && g_segDone == 0 )
	{
		FString marker;
		marker.Format( "MCP_INPUT_SEG %d maptime=%d\n", g_segIdx + 1, level.maptime );
		MCPI_LogMarker( marker );
	}
	MCPI_Apply( g_segs[g_segIdx], cmd->ucmd, mo, fresh );
	g_pending = true;
	g_pendingMaptime = level.maptime;
}

static void MCPI_SegError( const char *why )
{
	g_bad = true;
	Printf( "error %s\n", why );
}

// seg <tics> <buttons|-> <fwd> <side> <up> <angle|-> <turn> <pitch|->
static void MCPI_AddSeg( FCommandLine &argv )
{
	if ( argv.argc() != 10 )
	{
		MCPI_SegError( "usage: mcp_input seg <tics> <buttons|-> <fwd> <side> <up> <angle|-> <turn> <pitch|->" );
		return;
	}
	MCPInputSeg s;
	memset( &s, 0, sizeof( s ) );
	int move[3];
	double angle = 0, pitch = 0;
	FString err;
	if ( !MCP_ParseInt( argv[2], s.tics ) || s.tics < 1 ) { MCPI_SegError( "tics must be an integer >= 1" ); return; }
	if ( g_nsegs >= MCP_INPUT_MAX_SEGS ) { MCPI_SegError( "too many segments (max 64)" ); return; }
	if ( s.tics > MCP_INPUT_MAX_TICS - g_total ) { MCPI_SegError( "too many tics (max 2100 in all)" ); return; }
	if ( !MCPI_ParseButtons( argv[3], s.buttons, err ) ) { MCPI_SegError( err ); return; }
	for ( int i = 0; i < 3; i++ )
	{
		if ( !MCP_ParseInt( argv[4 + i], move[i] ) || move[i] < -32768 || move[i] > 32767 )
		{
			MCPI_SegError( "fwd, side and up must be integers in -32768..32767" );
			return;
		}
	}
	s.hasAngle = strcmp( argv[7], "-" ) != 0;
	s.hasPitch = strcmp( argv[9], "-" ) != 0;
	if ( s.hasAngle && !MCPI_Num( argv[7], angle ) ) { MCPI_SegError( "angle must be a number or -" ); return; }
	if ( !MCPI_Num( argv[8], s.turn ) || fabs( s.turn ) > 180 ) { MCPI_SegError( "turn must be a number in -180..180" ); return; }
	if ( s.hasPitch && !MCPI_Num( argv[9], pitch ) ) { MCPI_SegError( "pitch must be a number or -" ); return; }
	if ( s.hasAngle && s.turn != 0 ) { MCPI_SegError( "give angle or turn, not both" ); return; }

	s.forward = short( move[0] );
	s.side = short( move[1] );
	s.up = short( move[2] );
	angle = fmod( angle, 360.0 );
	if ( angle < 0 ) angle += 360.0;
	s.angle = angle_t( angle * double( ANGLE_1 ) );
	s.turn *= double( ANGLE_1 );
	s.pitch = fixed_t( clamp( pitch, -89.0, 89.0 ) * double( ANGLE_1 ) );

	g_segs[g_nsegs++] = s;
	g_total += s.tics;
	Printf( "MCP_INPUT seg %d total=%d\n", g_nsegs, g_total );
}

static void MCPI_Go( bool pauseAfter )
{
	if ( g_armed ) { Printf( "error armed: mcp_input stop first\n" ); return; }
	if ( g_bad ) { Printf( "error bad timeline: a seg failed, mcp_input clear first\n" ); return; }
	if ( g_nsegs == 0 ) { Printf( "error empty timeline\n" ); return; }
	if ( NETWORK_GetState() == NETSTATE_SERVER || NETWORK_InClientMode() ) { Printf( "error netgame\n" ); return; }
	if ( demoplayback ) { Printf( "error demo playback\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	if ( !playeringame[consoleplayer] || players[consoleplayer].mo == NULL ) { Printf( "error no player\n" ); return; }

	g_armed = true;
	g_pauseAfter = pauseAfter;
	g_reason = "-";
	g_consumed = g_segIdx = g_segDone = 0;
	g_pending = false;
	g_turnAcc = 0;
	g_turnYaw = 0;
	g_lastMaptime = level.maptime;
	g_map = level.mapname;
	MCPI_Snapshot( g_start, level.maptime, 0, 0 );
	// Unpaused on the game thread, so the first scheduled tic is the next one that runs.
	paused = 0;
	Printf( "MCP_INPUT armed segs=%d tics=%d maptime=%d\n", g_nsegs, g_total, level.maptime );
}

// trail [from] prints every consumed tic from that index; trail ends prints each segment's last.
static void MCPI_PrintTrail( const char *arg )
{
	bool endsOnly = arg != NULL && stricmp( arg, "ends" ) == 0;
	int from = 0;
	if ( arg != NULL && !endsOnly && ( !MCP_ParseInt( arg, from ) || from < 0 ) )
	{
		Printf( "error usage: mcp_input trail [from|ends]\n" );
		return;
	}
	MCPI_Settle();
	Printf( "MCP_INPUT_TRAIL\n" );
	if ( from == 0 ) MCPI_PrintRow( "start", g_start );
	for ( int i = from; i < g_consumed; i++ )
	{
		if ( endsOnly && i + 1 < g_consumed && g_trail[i + 1].seg == g_trail[i].seg ) continue;
		MCPI_PrintRow( "tic", g_trail[i] );
	}
}

CCMD( mcp_input )
{
	const char *sub = ( argv.argc() >= 2 ) ? argv[1] : "";
	if ( stricmp( sub, "clear" ) == 0 )
	{
		if ( g_armed ) { Printf( "error armed: mcp_input stop first\n" ); return; }
		g_nsegs = g_total = g_consumed = 0;
		g_bad = false;
		g_reason = "-";
		Printf( "MCP_INPUT cleared\n" );
	}
	else if ( stricmp( sub, "seg" ) == 0 )
	{
		// Not marked bad: the armed timeline isn't the one being edited.
		if ( g_armed ) { Printf( "error armed: mcp_input stop first\n" ); return; }
		MCPI_AddSeg( argv );
	}
	else if ( stricmp( sub, "go" ) == 0 )
	{
		MCPI_Go( argv.argc() >= 3 && atoi( argv[2] ) != 0 );
	}
	else if ( stricmp( sub, "status" ) == 0 )
	{
		MCPI_Settle();
		int seg = g_armed ? g_segIdx + 1 : ( g_consumed > 0 ? g_trail[g_consumed - 1].seg : 0 );
		Printf( "MCP_INPUT active=%d consumed=%d total=%d seg=%d maptime=%d reason=%s\n",
			g_armed ? 1 : 0, g_consumed, g_total, seg, level.maptime, g_reason );
	}
	else if ( stricmp( sub, "trail" ) == 0 )
	{
		MCPI_PrintTrail( argv.argc() >= 3 ? argv[2] : NULL );
	}
	else if ( stricmp( sub, "stop" ) == 0 )
	{
		if ( !g_armed ) { Printf( "MCP_INPUT idle\n" ); return; }
		MCPI_Settle();
		if ( g_armed ) MCPI_Disarm( "stopped" );
		Printf( "MCP_INPUT stopped consumed=%d\n", g_consumed );
	}
	else
	{
		Printf( "error usage: mcp_input clear|seg|go|status|trail|stop\n" );
	}
}
