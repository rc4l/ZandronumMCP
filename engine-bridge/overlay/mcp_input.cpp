//
// mcp_input.cpp -- scripted per-tic player input (overlay file).
//
// Injects a timeline into a copy of the console player's net ticcmd, never the net slot itself, which
// the next tic's cmd is delta-decoded over, so writing it would replay the last injected cmd.
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
#include "p_local.h"
#include "mcp_bridge.h"
#include "mcp_steer.h"
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

// The host enforces the same caps (src/input/timeline.ts).
#define MCP_INPUT_MAX_SEGS 64
#define MCP_INPUT_MAX_TICS 2100
// p_mobj.cpp's, private there: the stop rule's velocity bound.
#define MCP_INPUT_STOPSPEED 0x1000

enum { MCPI_SEG, MCPI_WALK };
enum { MCPI_PT, MCPI_TID, MCPI_CLASS };

struct MCPInputSeg
{
	int     kind;
	int     tics;
	DWORD   buttons;
	short   forward, side, up;
	bool    hasAngle, hasPitch;
	angle_t angle; // absolute heading, held for the whole segment
	double  turn;  // BAM per tic, used when there is no absolute heading
	fixed_t pitch; // absolute view pitch; negative looks up
	// walk
	int            target, tid;
	const PClass  *type;
	double         x, y, standoff, speed;
	bool           pass;
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
static int         g_done = 0;       // entries completed
static int         g_limit = 0;      // tics the run may consume
static int         g_stuckTics = 35;
// The walk entry in progress: steering state, its target and the cmd its tic was given.
static MCPSteerState g_steer;
static bool        g_walkBegun = false;
static double      g_walkX = 0, g_walkY = 0, g_walkRadius = 0;
static bool        g_walkSolid = false;
static bool        g_walkSeen = false; // the target was found at least once
static bool        g_hasDist = false;
static double      g_dist = 0;
static usercmd_t   g_walkCmd;

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
	const MCPInputSeg &s = g_segs[g_segIdx];
	MCPI_Snapshot( g_trail[g_consumed], g_pendingMaptime, g_segIdx + 1, s.kind == MCPI_WALK ? DWORD( g_walkCmd.buttons ) : s.buttons );
	g_consumed++;
	// A walk entry completes only in the hook, on a fresh read.
	if ( s.kind == MCPI_SEG && ++g_segDone >= s.tics )
	{
		g_segIdx++;
		g_segDone = 0;
		g_done++;
	}
	if ( g_segIdx >= g_nsegs ) MCPI_Disarm( "done" );
}

// Every disarm puts back the pause the timeline was armed on (on a frozen clock, the one thaw restores),
// except around a demo, where a paused tic desyncs the replay.
static void MCPI_Disarm( const char *reason )
{
	g_armed = false;
	g_pending = false;
	g_reason = reason;
	if ( g_pauseAfter && gamestate == GS_LEVEL && !demorecording && !demoplayback ) MCP_Clock_SetPause( 1 );
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

static bool MCPI_IsNet() { return NETWORK_GetState() == NETSTATE_SERVER || NETWORK_InClientMode(); }

// The player's side of the steering inputs at tic start, as P_MovePlayer will see them.
static void MCPI_SteerInputs( MCPSteerIn &in, AActor *mo, double speed )
{
	player_t *pl = mo->player;
	APlayerPawn *pmo = pl->mo;
	int friction, baseFactor;
	int movefactor = P_GetMoveFactor( mo, &friction );
	P_GetFriction( mo, &baseFactor );
	bool onground = ( mo->z <= mo->floorz ) || ( mo->flags2 & MF2_ONMOBJ ) || ( mo->BounceFlags & BOUNCE_MBF ) || ( pl->cheats & CF_NOCLIP2 );
	bool air = !onground && !( mo->flags & MF_NOGRAVITY ) && !mo->waterlevel;
	if ( air ) movefactor = ( zacompatflags & ZACOMPATF_LIMITED_AIRMOVEMENT ) ? FixedMul( movefactor, level.aircontrol ) : movefactor / 4;
	// Map units of thrust per tweaked cmd unit: Speed, crouch, then Scale( fm, movefactor, 256 ).
	double scale = FIXED2DBL( pmo->Speed ) * movefactor / 256.0 / 65536.0;
	if ( pl->CanCrouch() && pl->crouchfactor != FRACUNIT ) scale *= FIXED2DBL( pl->crouchfactor );
	int capF = int( 12800 * speed + 0.5 ), capS = int( 10240 * speed + 0.5 );
	if ( mo->health <= pmo->RunHealth )
	{
		capF = MIN( capF, 0x1900 );
		capS = MIN( capS, 0x1800 );
	}
	// TweakSpeeds on each regime's largest allowed value: exact for speed items and CF_SPEED25.
	int p1F = MIN( capF, 0x31ff ), p1S = MIN( capS, 0x27ff ), f1 = p1F, s1 = p1S, f2 = capF, s2 = capS;
	pmo->TweakSpeeds( f1, s1 );
	pmo->TweakSpeeds( f2, s2 );
	in.fwd.regime2 = 0x3200;
	in.fwd.cap = capF;
	in.fwd.gain1 = p1F > 0 ? f1 / double( p1F ) * scale : 0;
	in.fwd.gain2 = capF >= 0x3200 ? f2 / double( capF ) * scale : in.fwd.gain1;
	in.side.regime2 = 0x2800;
	in.side.cap = capS;
	in.side.gain1 = p1S > 0 ? s1 / double( p1S ) * scale : 0;
	in.side.gain2 = capS >= 0x2800 ? s2 / double( capS ) * scale : in.side.gain1;
	in.px = FIXED2DBL( mo->x );
	in.py = FIXED2DBL( mo->y );
	in.vx = FIXED2DBL( mo->velx );
	in.vy = FIXED2DBL( mo->vely );
	in.angle = mo->angle * ( MCP_STEER_TWO_PI / 4294967296.0 );
	in.yawUnit = MCP_STEER_TWO_PI / 65536;
	in.thrustQuantum = MCP_STEER_TWO_PI / FINEANGLES;
	in.friction = FIXED2DBL( friction );
	in.stopSpeed = FIXED2DBL( MCP_INPUT_STOPSPEED );
	in.brakeScale = movefactor > baseFactor && !air ? double( baseFactor ) / movefactor : 1;
	in.onGround = !air;
	in.playerRadius = FIXED2DBL( mo->radius );
}

// The walk's target this tic into in; false (and why) when there is none.
static bool MCPI_WalkTarget( const MCPInputSeg &s, AActor *mo, MCPSteerIn &in, const char *&why )
{
	AActor *a = NULL;
	if ( s.target == MCPI_TID ) a = MCP_NearestWithTid( mo, s.tid );
	// A class target is picked once, when its entry starts.
	else if ( s.target == MCPI_CLASS && !g_walkSeen ) a = MCP_NearestOfClass( mo, s.type );
	if ( a != NULL )
	{
		g_walkX = FIXED2DBL( a->x );
		g_walkY = FIXED2DBL( a->y );
		g_walkRadius = FIXED2DBL( a->radius );
		g_walkSolid = ( a->flags & MF_SOLID ) != 0;
		g_walkSeen = true;
	}
	else if ( s.target == MCPI_PT ) { g_walkX = s.x; g_walkY = s.y; g_walkRadius = 0; g_walkSolid = false; }
	else if ( s.target == MCPI_TID || !g_walkSeen )
	{
		// A target gone while its box overlaps the player's was picked up on arrival.
		double reach = g_walkRadius + in.playerRadius;
		bool overlap = g_walkSeen && fabs( g_walkX - in.px ) < reach && fabs( g_walkY - in.py ) < reach;
		why = overlap ? "arrived" : "target_gone";
		return false;
	}
	in.tx = g_walkX;
	in.ty = g_walkY;
	in.targetRadius = g_walkRadius;
	in.solid = g_walkSolid;
	g_hasDist = true;
	g_dist = hypot( g_walkX - in.px, g_walkY - in.py );
	return true;
}

// Completes walk entries already satisfied at tic start (they consume no tic), leaving the next
// one's cmd in g_walkCmd, or returns false when it disarmed.
static bool MCPI_RunEntries( AActor *mo )
{
	for ( ;; )
	{
		if ( g_segIdx >= g_nsegs ) { MCPI_Disarm( "done" ); return false; }
		const MCPInputSeg &s = g_segs[g_segIdx];
		if ( s.kind == MCPI_SEG ) return true;
		if ( mo->health <= 0 || players[consoleplayer].playerstate != PST_LIVE ) { MCPI_Disarm( "died" ); return false; }
		if ( !g_walkBegun )
		{
			FString marker;
			marker.Format( "MCP_INPUT_SEG %d maptime=%d\n", g_segIdx + 1, level.maptime );
			MCPI_LogMarker( marker );
			MCP_SteerBegin( g_steer );
			g_walkBegun = true;
			g_walkSeen = false;
			// Not the previous walk's target if this one has none.
			g_hasDist = false;
		}
		MCPSteerIn in;
		MCPI_SteerInputs( in, mo, s.speed );
		in.standoff = s.standoff;
		in.pass = s.pass;
		in.stuckTics = g_stuckTics;
		const char *why = NULL;
		MCPSteerOut out;
		if ( !MCPI_WalkTarget( s, mo, in, why ) )
		{
			if ( strcmp( why, "arrived" ) != 0 ) { MCPI_Disarm( why ); return false; }
			out.status = MCP_STEER_DONE;
		}
		else MCP_Steer( g_steer, in, out );
		if ( out.status == MCP_STEER_DONE )
		{
			g_done++;
			g_segIdx++;
			g_walkBegun = false;
			continue;
		}
		if ( out.status == MCP_STEER_STUCK ) { MCPI_Disarm( "stuck" ); return false; }
		usercmd_t &u = g_walkCmd;
		memset( &u, 0, sizeof( u ) );
		u.buttons = s.buttons
			| ( out.forward > 0 ? BT_FORWARD : out.forward < 0 ? BT_BACK : 0 )
			| ( out.side > 0 ? BT_MOVERIGHT : out.side < 0 ? BT_MOVELEFT : 0 )
			| ( out.yaw > 0 ? BT_LEFT : out.yaw < 0 ? BT_RIGHT : 0 );
		u.forwardmove = short( out.forward );
		u.sidemove = short( out.side );
		u.yaw = short( out.yaw );
		return true;
	}
}

// Called from G_Ticker before a recording demo writes the net cmd, returning the cmd the tic runs
// (cmd itself, or a copy carrying the injected input).
ticcmd_t *MCP_Input_Override( int player, ticcmd_t *cmd )
{
	static ticcmd_t out;
	// A playing demo's input is the demo's.
	if ( demoplayback ) { if ( g_armed ) MCPI_Disarm( "demo" ); return cmd; }
	if ( !g_armed || player != consoleplayer ) return cmd;
	AActor *mo = players[consoleplayer].mo;
	// A maptime that jumped is a load of the same map: one application drives at most one tic.
	if ( gamestate != GS_LEVEL || mo == NULL || g_map.CompareNoCase( level.mapname ) != 0 ||
		level.maptime < g_lastMaptime || ( g_pending && level.maptime > g_pendingMaptime + 1 ) )
	{
		MCPI_Disarm( "level_change" );
		return cmd;
	}
	if ( paused ) return cmd;
	MCPI_Settle();
	if ( !g_armed ) return cmd;
	g_lastMaptime = level.maptime;
	// A tic a menu stopped leaves maptime alone: the same entry and cmd are applied again.
	bool fresh = !g_pending;
	if ( fresh )
	{
		MCPSteerIn in;
		MCPI_SteerInputs( in, mo, 1 );
		MCP_SteerObserve( g_steer, in );
		if ( !MCPI_RunEntries( mo ) ) return cmd;
		// Pausing here stops this tic's P_Ticker, so the limit is exact.
		if ( g_consumed >= g_limit ) { MCPI_Disarm( "timeout" ); return cmd; }
	}
	out = *cmd;
	const MCPInputSeg &s = g_segs[g_segIdx];
	if ( s.kind == MCPI_WALK ) out.ucmd = g_walkCmd;
	else
	{
		if ( fresh && g_segDone == 0 )
		{
			FString marker;
			marker.Format( "MCP_INPUT_SEG %d maptime=%d\n", g_segIdx + 1, level.maptime );
			MCPI_LogMarker( marker );
		}
		MCPI_Apply( s, out.ucmd, mo, fresh );
	}
	g_pending = true;
	g_pendingMaptime = level.maptime;
	return &out;
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
	s.kind = MCPI_SEG;
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

// walk <pt:x,y|tid:N|class:Name> <standoff> <pass 0|1> <speed> <buttons|->
static void MCPI_AddWalk( FCommandLine &argv )
{
	if ( argv.argc() != 7 )
	{
		MCPI_SegError( "usage: mcp_input walk <pt:x,y|tid:N|class:Name> <standoff> <pass 0|1> <speed> <buttons|->" );
		return;
	}
	if ( g_nsegs >= MCP_INPUT_MAX_SEGS ) { MCPI_SegError( "too many segments (max 64)" ); return; }
	MCPInputSeg s;
	memset( &s, 0, sizeof( s ) );
	s.kind = MCPI_WALK;
	FString err;
	const char *ref = argv[2];
	if ( strnicmp( ref, "pt:", 3 ) == 0 )
	{
		const char *comma = strchr( ref + 3, ',' );
		if ( comma == NULL || !MCPI_Num( FString( ref + 3, comma - ref - 3 ).GetChars(), s.x ) || !MCPI_Num( comma + 1, s.y ) ||
			fabs( s.x ) > 32767 || fabs( s.y ) > 32767 )
		{
			MCPI_SegError( "pt wants pt:x,y with map coordinates in -32767..32767" );
			return;
		}
		s.target = MCPI_PT;
	}
	else if ( strnicmp( ref, "tid:", 4 ) == 0 )
	{
		if ( !MCP_ParseInt( ref + 4, s.tid ) || s.tid < 1 ) { MCPI_SegError( "tid wants tid:N with N >= 1" ); return; }
		s.target = MCPI_TID;
	}
	else if ( strnicmp( ref, "class:", 6 ) == 0 )
	{
		s.type = PClass::FindClass( ref + 6 );
		if ( s.type == NULL || !s.type->IsDescendantOf( RUNTIME_CLASS( AActor ) ) )
		{
			err.Format( "unknown class %s", ref + 6 );
			MCPI_SegError( err );
			return;
		}
		s.target = MCPI_CLASS;
	}
	else
	{
		MCPI_SegError( "target must be pt:x,y, tid:N or class:Name" );
		return;
	}
	if ( !MCPI_Num( argv[3], s.standoff ) || s.standoff < 0 || s.standoff > 32767 ) { MCPI_SegError( "standoff must be a number in 0..32767" ); return; }
	if ( strcmp( argv[4], "0" ) != 0 && strcmp( argv[4], "1" ) != 0 ) { MCPI_SegError( "pass must be 0 or 1" ); return; }
	s.pass = argv[4][0] == '1';
	if ( !MCPI_Num( argv[5], s.speed ) || s.speed <= 0 || s.speed > 1 ) { MCPI_SegError( "speed must be a number in (0, 1]" ); return; }
	if ( !MCPI_ParseButtons( argv[6], s.buttons, err ) ) { MCPI_SegError( err ); return; }
	g_segs[g_nsegs++] = s;
	Printf( "MCP_INPUT walk %d\n", g_nsegs );
}

// go <0|1> [<maxtics> [<stucktics>]]
static void MCPI_Go( FCommandLine &argv )
{
	bool pauseAfter = argv.argc() >= 3 && atoi( argv[2] ) != 0;
	bool walks = false;
	for ( int i = 0; i < g_nsegs; i++ ) walks = walks || g_segs[i].kind == MCPI_WALK;
	int limit = walks ? MCP_INPUT_MAX_TICS : g_total, stuck = 35;
	if ( argv.argc() >= 4 && ( !MCP_ParseInt( argv[3], limit ) || limit < 1 ) ) { Printf( "error maxtics must be an integer >= 1\n" ); return; }
	if ( argv.argc() >= 5 && ( !MCP_ParseInt( argv[4], stuck ) || stuck < 1 ) ) { Printf( "error stucktics must be an integer >= 1\n" ); return; }
	if ( g_armed ) { Printf( "error armed: mcp_input stop first\n" ); return; }
	if ( g_bad ) { Printf( "error bad timeline: a seg failed, mcp_input clear first\n" ); return; }
	if ( g_nsegs == 0 ) { Printf( "error empty timeline\n" ); return; }
	if ( MCPI_IsNet() ) { Printf( "error netgame\n" ); return; }
	if ( demoplayback ) { Printf( "error demo playback\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	if ( !playeringame[consoleplayer] || players[consoleplayer].mo == NULL ) { Printf( "error no player\n" ); return; }
	if ( pauseAfter && demorecording && !MCP_ClockFrozen )
	{
		Printf( "error recording: a pause would desync the demo; freeze the clock first\n" );
		return;
	}

	g_limit = MIN( limit, MCP_INPUT_MAX_TICS );
	g_stuckTics = stuck;
	g_done = 0;
	g_walkBegun = false;
	g_hasDist = false;
	MCP_SteerReset( g_steer );
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
	// Unpaused on the game thread so the first scheduled tic is the next one that runs (a frozen clock
	// is already unpaused and keeps its restore value).
	if ( !MCP_ClockFrozen ) paused = 0;
	Printf( "MCP_INPUT armed segs=%d tics=%d limit=%d maptime=%d\n", g_nsegs, g_total, g_limit, level.maptime );
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
		g_nsegs = g_total = g_consumed = g_done = 0;
		g_bad = false;
		g_hasDist = false;
		g_reason = "-";
		Printf( "MCP_INPUT cleared\n" );
	}
	else if ( stricmp( sub, "seg" ) == 0 )
	{
		// Not marked bad: the armed timeline isn't the one being edited.
		if ( g_armed ) { Printf( "error armed: mcp_input stop first\n" ); return; }
		MCPI_AddSeg( argv );
	}
	else if ( stricmp( sub, "walk" ) == 0 )
	{
		if ( g_armed ) { Printf( "error armed: mcp_input stop first\n" ); return; }
		MCPI_AddWalk( argv );
	}
	else if ( stricmp( sub, "go" ) == 0 )
	{
		MCPI_Go( argv );
	}
	else if ( stricmp( sub, "status" ) == 0 )
	{
		MCPI_Settle();
		int seg = g_armed ? g_segIdx + 1 : ( g_consumed > 0 ? g_trail[g_consumed - 1].seg : 0 );
		FString dist = "-", target = "-";
		if ( g_hasDist )
		{
			dist.Format( "%.3f", g_dist );
			target.Format( "%.3f,%.3f", g_walkX, g_walkY );
		}
		Printf( "MCP_INPUT active=%d consumed=%d total=%d seg=%d maptime=%d reason=%s done=%d limit=%d net=%d dist=%s target=%s\n",
			g_armed ? 1 : 0, g_consumed, g_total, seg, level.maptime, g_reason, g_done, g_limit, MCPI_IsNet() ? 1 : 0,
			dist.GetChars(), target.GetChars() );
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
		Printf( "error usage: mcp_input clear|seg|walk|go|status|trail|stop\n" );
	}
}
