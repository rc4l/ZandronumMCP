//
// mcp_actorstate.cpp -- DECORATE/actor state inspection (overlay file).
// Dumps an actor's live state: class, health, position, current DECORATE state
// (sprite/frame/tics, e.g. "TNT1 A 0"), inventory chain, and -- for players --
// ready weapon and morph status. Plus the actors near the player. All reads,
// except the test-session CCMDs (mcp_setview, mcp_unblock, mcp_spawnat and the actor-editing ones).
//
#include "doomtype.h"
#include "c_dispatch.h"
#include "c_console.h"
#include "actor.h"
#include "chat.h"
#include "am_map.h"
#include "d_player.h"
#include "doomstat.h"
#include "g_shared/a_pickups.h"
#include "menu/menu.h"
#include "r_state.h"
#include "r_data/sprites.h"
#include "m_fixed.h"
#include "tables.h"
#include "p_acs.h"
#include "g_level.h"
#include "r_utility.h"
#include "v_text.h"
#include "v_video.h"
#include "network.h"
#include "sv_commands.h"
#include "sv_main.h"
#include "invasion.h"
#include "cooperative.h"
#include "c_cvars.h"
#include "p_spec.h"
#include "d_event.h"
#include "doomdef.h"
#include "gi.h"
#include "g_shared/a_sharedglobal.h"
#include "m_bbox.h"
#include "p_local.h"
#include "p_setup.h"
#include "p_trace.h"
#include "p_3dfloors.h"
#include "textures/textures.h"
#include "thingdef/thingdef.h"
#include "r_data/renderstyle.h"
#include "m_random.h"
// 3.3-alpha (267400324) moved sector tags into FTagManager; ZA_3.2.1 still has sector_t::tag.
#if __has_include("p_tags.h")
#include "p_tags.h"
#define MCP_SECTOR_TAG( sec ) tagManager.GetFirstSectorTag( sec )
#else
#define MCP_SECTOR_TAG( sec ) ( ( sec )->tag )
#endif
#include <errno.h>
#include <limits.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unordered_map>
#include "mcp_bridge.h"

static bool MCP_PrintState( const char *label, AActor *mo )
{
	if ( mo->state != NULL && mo->state->sprite < sprites.Size() )
	{
		Printf( "%s %s %c %d\n", label, sprites[mo->state->sprite].name,
			(char)( 'A' + mo->state->Frame ), mo->state->Tics );
		return true;
	}
	return false;
}

// Nearest label at or before state among those pointing into info's own states, so inherited
// labels never match; children read "Death.Fire".
static void MCP_WalkLabels( const FStateLabels *list, FActorInfo *info, const FState *state,
	const FString &prefix, const FState *&best, FString &bestName )
{
	for ( int i = 0; i < list->NumLabels; i++ )
	{
		const FStateLabel &l = list->Labels[i];
		FString name = prefix.IsEmpty() ? FString( l.Label.GetChars() ) : prefix + "." + l.Label.GetChars();
		if ( l.State != NULL && info->OwnsState( l.State ) && l.State <= state && ( best == NULL || l.State > best ) )
		{
			best = l.State;
			bestName = name;
		}
		if ( l.Children != NULL ) MCP_WalkLabels( l.Children, info, state, name, best, bestName );
	}
}

// A state's "<Owner>.<index>" id (UZDoom's StaticGetStateName form) and "<Label>[+N]" name (empty
// when no own label precedes it), or false when no class owns it.
static bool MCP_StateName( const FState *state, FString &id, FString &label )
{
	const PClass *owner = ( state != NULL ) ? FState::StaticFindStateOwner( state ) : NULL;
	if ( owner == NULL ) return false;
	FActorInfo *info = owner->ActorInfo;
	id.Format( "%s.%d", owner->TypeName.GetChars(), int( state - info->OwnedStates ) );
	const FState *best = NULL;
	FString name;
	if ( info->StateList != NULL ) MCP_WalkLabels( info->StateList, info, state, "", best, name );
	if ( best == NULL ) label = "";
	else if ( best == state ) label = name;
	else label.Format( "%s+%d", name.GetChars(), int( state - best ) );
	return true;
}

// usercmd_t as a kv line: buttons in decimal so the host decodes the bits.
static void MCP_PrintInput( const char *tag, const usercmd_t &cmd, DWORD oldButtons )
{
	Printf( "%s buttons=%u oldbuttons=%u forward=%d side=%d up=%d yaw=%d pitch=%d roll=%d\n", tag,
		(unsigned)cmd.buttons, (unsigned)oldButtons, cmd.forwardmove, cmd.sidemove, cmd.upmove,
		cmd.yaw, cmd.pitch, cmd.roll );
}

// Zandronum's fixed psprite slots as GZDoom layer numbers (PSP_WEAPON, PSP_FLASH, PSP_TARGET*).
static const int MCP_PSP_LAYERS[NUMPSPRITES] = { 1, 1000, INT_MAX - 2, INT_MAX - 1, INT_MAX };

struct MCPPspriteView { const void *object; const FState *state; int sprite; int frame; int tics; };
static pspdef_t *MCP_WeaponLayer( player_t *p ) { return p->psprites[ps_weapon].state != NULL ? &p->psprites[ps_weapon] : NULL; }
static MCPPspriteView MCP_PspriteView( const pspdef_t &p ) { return { NULL, p.state, p.sprite, p.frame, p.tics }; }

// Shared by weapon sample fields and every layer's event row.
static bool MCP_PspriteField( FString &v, const MCPPspriteView &p, const char *field )
{
	if ( p.state == NULL ) return false;
	if ( !strcmp( field, "wstate" ) ) { FString label; return MCP_StateName( p.state, v, label ); }
	if ( !strcmp( field, "wlabel" ) ) { FString id; return MCP_StateName( p.state, id, v ) && !v.IsEmpty(); }
	if ( !strcmp( field, "wsprite" ) ) v = unsigned( p.sprite ) < sprites.Size() ? sprites[p.sprite].name : "----";
	else if ( !strcmp( field, "wframe" ) ) v.Format( "%c", char( 'A' + p.frame ) );
	else v.Format( "%d", p.tics );
	return true;
}

static bool MCP_PlayerField( FString &v, AActor *a, const char *field )
{
	player_t *p = a->player;
	if ( p == NULL || p->mo != a ) return false;
	if ( !strcmp( field, "buttons" ) ) v.Format( "%u", unsigned( p->original_cmd.buttons ) );
	else if ( !strcmp( field, "modbuttons" ) ) v.Format( "%u", unsigned( p->cmd.ucmd.buttons ) );
	else if ( !strcmp( field, "wclass" ) ) { if ( p->ReadyWeapon == NULL ) return false; v = p->ReadyWeapon->GetClass()->TypeName.GetChars(); }
	else if ( !strcmp( field, "pending" ) )
	{
		if ( p->PendingWeapon == WP_NOCHANGE ) return false;
		v = p->PendingWeapon != NULL ? p->PendingWeapon->GetClass()->TypeName.GetChars() : "none";
	}
	else if ( !strcmp( field, "refire" ) ) v.Format( "%d", p->refire );
	else if ( !strcmp( field, "wflags" ) ) v.Format( "%u", unsigned( p->WeaponState ) );
	else { const pspdef_t *psp = MCP_WeaponLayer( p ); return psp != NULL && MCP_PspriteField( v, MCP_PspriteView( *psp ), field ); }
	return true;
}

static void MCP_PrintPlayerWeapon( player_t *p )
{
	MCP_PrintInput( "input", p->original_cmd, p->original_oldbuttons );
	MCP_PrintInput( "modinput", p->cmd.ucmd, p->oldbuttons );

	FString info;
	info.Format( "weaponinfo refire=%d flags=%u", p->refire, (unsigned)p->WeaponState );
	if ( p->PendingWeapon == NULL ) info += " pending=none";
	else if ( p->PendingWeapon != WP_NOCHANGE )
		info.AppendFormat( " pending=%s", p->PendingWeapon->GetClass()->TypeName.GetChars() );
	Printf( "%s\n", info.GetChars() );

	for ( int i = 0; i < NUMPSPRITES; i++ )
	{
		const pspdef_t &psp = p->psprites[i];
		if ( psp.state == NULL ) continue;
		FString line, id, label;
		line.Format( "psprite layer=%d sprite=%s frame=%c tics=%d x=%.1f y=%.1f", MCP_PSP_LAYERS[i],
			( unsigned( psp.sprite ) < sprites.Size() ) ? sprites[psp.sprite].name : "----",
			(char)( 'A' + psp.frame ), psp.tics, FIXED2FLOAT( psp.sx ), FIXED2FLOAT( psp.sy ) );
		if ( MCP_StateName( psp.state, id, label ) )
		{
			line.AppendFormat( " id=%s", id.GetChars() );
			if ( !label.IsEmpty() ) line.AppendFormat( " label=%s", label.GetChars() );
		}
		Printf( "%s\n", line.GetChars() );
	}
}

// Hidden by HideOrDestroyIfSafe in a map-reset game mode: out of play but keeping its tid,
// so every lookup here skips it, as Zandronum's ACS does.
static bool MCP_IsHidden( AActor *a ) { return ( a->STFlags & STFL_HIDDEN_INSTEAD_OF_DESTROYED ) != 0; }

// The index-th (0-based) actor sharing a TID, where zeroIsPlayer maps tid 0 (index 0 only) to the
// console player's body since FActorIterator finds nothing for tid 0.
static AActor *MCP_ResolveActor( int tid, int index, bool zeroIsPlayer )
{
	if ( tid == 0 && zeroIsPlayer ) return ( index == 0 ) ? players[consoleplayer].mo : NULL;
	FActorIterator it( tid );
	AActor *mo;
	int i = 0;
	while ( ( mo = it.Next() ) != NULL )
		if ( !MCP_IsHidden( mo ) && i++ >= index ) break;
	return mo;
}

CCMD( dumpactor )
{
	AActor *mo = players[consoleplayer].mo;
	if ( argv.argc() >= 2 )
		mo = MCP_ResolveActor( atoi( argv[1] ), ( argv.argc() >= 3 ) ? atoi( argv[2] ) : 0, false );

	Printf( "MCP_ACTOR\n" );
	if ( mo == NULL ) { Printf( "actor none\n" ); return; }

	Printf( "class %s\n", mo->GetClass()->TypeName.GetChars() );
	Printf( "health %d\n", mo->health );
	Printf( "pos %.1f %.1f %.1f\n", FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ), FIXED2FLOAT( mo->z ) );
	Printf( "angle %.1f\n", mo->angle / float( ANGLE_1 ) );
	Printf( "pitch %.1f\n", mo->pitch / float( ANGLE_1 ) );
	FString id, label;
	if ( MCP_PrintState( "state", mo ) && MCP_StateName( mo->state, id, label ) )
		Printf( "stateid %s%s%s\n", id.GetChars(), label.IsEmpty() ? "" : " ", label.GetChars() );

	if ( mo->player != NULL )
	{
		if ( mo->player->ReadyWeapon != NULL )
			Printf( "weapon %s\n", mo->player->ReadyWeapon->GetClass()->TypeName.GetChars() );
		Printf( "morphtics %d\n", mo->player->morphTics );
		MCP_PrintPlayerWeapon( mo->player );
	}

	for ( AInventory *item = mo->Inventory; item != NULL; item = item->Inventory )
		Printf( "item %s %d %d\n", item->GetClass()->TypeName.GetChars(), item->Amount, item->MaxAmount );
}

CCMD( actorsnear )
{
	AActor *me = players[consoleplayer].mo;
	Printf( "MCP_ACTORS\n" );
	if ( me == NULL ) return;
	fixed_t r = ( ( argv.argc() >= 2 ) ? atoi( argv[1] ) : 512 ) * FRACUNIT;

	TThinkerIterator<AActor> it;
	AActor *a;
	while ( ( a = it.Next() ) != NULL )
	{
		if ( a == me || MCP_IsHidden( a ) ) continue;
		if ( abs( a->x - me->x ) > r || abs( a->y - me->y ) > r ) continue;
		const char *spr = ( a->state != NULL && a->state->sprite < sprites.Size() )
			? sprites[a->state->sprite].name : "----";
		Printf( "near %s %d %.0f %.0f %s\n", a->GetClass()->TypeName.GetChars(), a->health,
			FIXED2FLOAT( a->x ), FIXED2FLOAT( a->y ), spr );
	}
}

// Temp modules mcp_runacs loaded into this level (LumpNum <= -2), any of which
// makes a save I_Error on load.
static int MCP_RunAcsModules()
{
	int n = 0;
	for ( int lib = 0; FBehavior *m = FBehavior::StaticGetModule( lib ); lib++ )
	{
		if ( m->GetLumpNum() <= -2 ) n++;
	}
	return n;
}

// Only queued actions that load a map, save or demo, not screenshots or autosaves.
static bool MCP_LoadPending()
{
	switch ( gameaction )
	{
		case ga_loadlevel:
		case ga_newgame:
		case ga_newgame2:
		case ga_loadgame:
		case ga_loadgamehidecon:
		case ga_loadgameplaydemo:
		case ga_autoloadgame:
		case ga_playdemo:
			return true;
		default:
			return false;
	}
}

// One-line engine state snapshot, so an MCP caller can tell a normally-running
// game apart from paused/menu/console/intermission/dead/spectating/chatting/
// demo-recording states that would otherwise make an unrelated tool (summon,
// menu_key, screenshot) look like it succeeded while doing nothing. With an
// argument, that argument is
// echoed as the leading token (the sentinel-riding form used by the bridge);
// with none, "MCP_STATUS" is used instead, so the command stays usable by hand.
CCMD( mcp_status )
{
	const char *token = ( argv.argc() >= 2 ) ? argv[1] : "MCP_STATUS";

	const char *menu = "off";
	if ( menuactive == MENU_On ) menu = "on";
	else if ( menuactive == MENU_WaitKey ) menu = "waitkey";
	else if ( menuactive == MENU_OnNoPause ) menu = "onnopause";

	const char *console = "up";
	if ( ConsoleState == c_down ) console = "down";
	else if ( ConsoleState == c_falling ) console = "falling";
	else if ( ConsoleState == c_rising ) console = "rising";

	const char *gs = "level";
	switch ( gamestate )
	{
		case GS_INTERMISSION: gs = "intermission"; break;
		case GS_FINALE:       gs = "finale";       break;
		case GS_DEMOSCREEN:   gs = "demoscreen";   break;
		case GS_FULLCONSOLE:  gs = "fullconsole";  break;
		case GS_HIDECONSOLE:  gs = "hideconsole";  break;
		case GS_STARTUP:      gs = "startup";      break;
		case GS_TITLELEVEL:   gs = "titlelevel";   break;
		default: break; // GS_LEVEL
	}

	player_t *p = playeringame[consoleplayer] ? &players[consoleplayer] : NULL;
	AActor *mo = ( p != NULL ) ? p->mo : NULL;
	bool dead = ( mo != NULL ) && ( ( p->playerstate == PST_DEAD ) || ( mo->health <= 0 ) );

	char line[512];
	size_t n = (size_t)snprintf( line, sizeof( line ),
		"%s paused=%d menu=%s console=%s gamestate=%s player=%s spectating=%d demo=%d automap=%d "
		"chat=%d demorec=%d pending=%d maptime=%d acstemp=%d frozen=%d",
		token, paused, menu, console, gs,
		( mo != NULL ) ? ( dead ? "dead" : "alive" ) : "none",
		( mo != NULL && p->bSpectating ) ? 1 : 0,
		demoplayback ? 1 : 0,
		automapactive ? 1 : 0,
		( CHAT_GetChatMode() != CHATMODE_NONE ) ? 1 : 0,
		demorecording ? 1 : 0,
		MCP_LoadPending() ? 1 : 0,
		level.maptime,
		MCP_RunAcsModules(),
		MCP_ClockFrozen ? 1 : 0 );

	// health/armor only mean something with a live player actor -- a menu or
	// intermission (mo == NULL) reads as gamestate=<not level>, not falsely "dead".
	if ( mo != NULL && n < sizeof( line ) )
	{
		AInventory *armor = mo->FindInventory<ABasicArmor>();
		n += (size_t)snprintf( line + n, sizeof( line ) - n, " health=%d armor=%d cheats=%d",
			mo->health, ( armor != NULL ) ? armor->Amount : 0, p->cheats );
	}

	if ( menuactive != MENU_Off && DMenu::CurrentMenu != NULL && n < sizeof( line ) )
	{
		snprintf( line + n, sizeof( line ) - n, " menuclass=%s",
			DMenu::CurrentMenu->GetClass()->TypeName.GetChars() );
	}

	Printf( "%s\n", line );
}

// The console player's body, or NULL: a -host server has no player of its own (consoleplayer 0 is a client's slot).
static AActor *MCP_ConsoleBody()
{
	if ( NETWORK_GetState() == NETSTATE_SERVER || !playeringame[consoleplayer] ) return NULL;
	return players[consoleplayer].mo;
}

// --- mcp_mark: a bindable playtest marker.

// A named ACS result script reporting the mod's round number, which must not delay or it returns a partial result.
CVAR( String, mcp_mark_round, "", CVAR_ARCHIVE )

extern FString shotfile;

// The mcp_mark_round script's result as round=, round=none when no such script runs here.
static void MCP_AppendRound( FString &line, AActor *mo )
{
	const char *name = mcp_mark_round;
	if ( name[0] == '\0' || NETWORK_InClientMode() || gamestate != GS_LEVEL ) return;
	int num = MCP_ScriptNumber( name );
	FBehavior *module = NULL;
	// Checked first: P_StartScript prints "Unknown script" and returns 0 for a missing one.
	if ( FBehavior::StaticFindScript( num, module ) == NULL ) { line += " round=none"; return; }
	MCPBridgeReplySuspendGuard gameOutput;
	line.AppendFormat( " round=%d", P_StartScript( mo, NULL, num, NULL, NULL, 0, ACS_ALWAYS | ACS_WANTRESULT ) );
}

// mcp_mark [note...]
// Reply: MCP_MARK n= tic= maptime= map= [x= y= z= angle=] [round=] [wave=] shot=<name|none> note=<rest>
CCMD( mcp_mark )
{
	static int count = 0;
	int n = ++count;
	AActor *mo = MCP_ConsoleBody();

	FString line;
	line.Format( "MCP_MARK n=%d tic=%d maptime=%d map=%s", n, gametic, level.maptime, level.mapname );
	if ( mo != NULL )
		line.AppendFormat( " x=%.1f y=%.1f z=%.1f angle=%.1f", FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ),
			FIXED2FLOAT( mo->z ), mo->angle / float( ANGLE_1 ) );
	MCP_AppendRound( line, mo );
	if ( invasion ) line.AppendFormat( " wave=%u", (unsigned)INVASION_GetCurrentWave() );

	// Not over a pending game action, which it would drop, nor without a screen (a -host server never runs V_Init).
	FString shot = "none";
	if ( ( MCP_ClockFrozen || gameaction == ga_nothing ) && screen != NULL )
	{
		const char *port = getenv( "ZANDRONUM_BRIDGE_PORT" );
		char stamp[32] = "00000000-000000";
		time_t now = time( NULL );
		struct tm *lt = localtime( &now );
		if ( lt != NULL ) strftime( stamp, sizeof( stamp ), "%Y%m%d-%H%M%S", lt );
		shot.Format( "mcp_mark_%d_%s_%d", ( port != NULL ) ? atoi( port ) : 0, stamp, n );
		// A frozen clock runs no tic to take ga_screenshot, so the clock captures it.
		if ( MCP_ClockFrozen )
		{
			if ( !MCP_Clock_QueueShot( shot ) ) shot = "none";
		}
		else
		{
			shotfile = shot;
			gameaction = ga_screenshot;
		}
	}
	line.AppendFormat( " shot=%s note=", shot.GetChars() );
	for ( int i = 1; i < argv.argc(); i++ )
	{
		if ( i > 1 ) line += ' ';
		line += argv[i];
	}
	Printf( "%s\n", line.GetChars() );
}

// --- test-session CCMDs, whose listing lines are "<tag> key=value ..." with
// name= always last (names can hold spaces), so one generic reader parses them all.

static double MCP_Deg( int bam ) { return bam / double( ANGLE_1 ); }

// An actor reference as "player<n>" for a player body, else "Class#tid".
static FString MCP_ActorRef( AActor *a )
{
	FString s;
	if ( a->player != NULL ) s.Format( "player%d", int( a->player - players ) );
	else s.Format( "%s#%d", a->GetClass()->TypeName.GetChars(), a->tid );
	return s;
}

// Owned inventory rides its owner around the map; it isn't a map actor.
static bool MCP_IsOwnedItem( AActor *a )
{
	return a->IsKindOf( RUNTIME_CLASS( AInventory ) ) && static_cast<AInventory *>( a )->Owner != NULL;
}

static double MCP_Dist2D( AActor *a, AActor *b )
{
	double dx = FIXED2FLOAT( a->x ) - FIXED2FLOAT( b->x );
	double dy = FIXED2FLOAT( a->y ) - FIXED2FLOAT( b->y );
	return sqrt( dx * dx + dy * dy );
}

// The value of "key=value" in argv, or NULL if no such key was given.
static const char *MCP_StrArg( FCommandLine &argv, const char *key )
{
	size_t len = strlen( key );
	for ( int i = 1; i < argv.argc(); i++ )
		if ( strncmp( argv[i], key, len ) == 0 && argv[i][len] == '=' ) return argv[i] + len + 1;
	return NULL;
}

// Parses "key=N" out of argv; returns false if no such key was given.
static bool MCP_IntArg( FCommandLine &argv, const char *key, int &out )
{
	const char *v = MCP_StrArg( argv, key );
	if ( v == NULL ) return false;
	out = atoi( v );
	return true;
}

// Parses "key=N" as a fractional number; returns false if the key is absent.
static bool MCP_NumArg( FCommandLine &argv, const char *key, double &out )
{
	const char *v = MCP_StrArg( argv, key );
	if ( v == NULL ) return false;
	out = atof( v );
	return true;
}

// The actor of a class (subclasses too) nearest to me, skipping me and owned items, or with no me
// the first one found; NULL if none.
AActor *MCP_NearestOfClass( AActor *me, const PClass *type )
{
	TThinkerIterator<AActor> it;
	AActor *a, *best = NULL;
	double bestDist = 0;
	while ( ( a = it.Next() ) != NULL )
	{
		if ( a == me || !a->IsKindOf( type ) || MCP_IsOwnedItem( a ) || MCP_IsHidden( a ) ) continue;
		double d = ( me != NULL ) ? MCP_Dist2D( me, a ) : 0;
		if ( best == NULL || d < bestDist ) { best = a; bestDist = d; }
	}
	return best;
}

// The actor with this TID nearest to me, skipping me; NULL if none.
AActor *MCP_NearestWithTid( AActor *me, int tid )
{
	FActorIterator it( tid );
	AActor *a, *best = NULL;
	double bestDist = 0;
	while ( ( a = it.Next() ) != NULL )
	{
		if ( a == me || MCP_IsHidden( a ) ) continue;
		double d = MCP_Dist2D( me, a );
		if ( best == NULL || d < bestDist ) { best = a; bestDist = d; }
	}
	return best;
}

// ACS SetActorAngle/SetActorPitch in degrees (pitch negative looks up): no view interpolation, sent to clients.
static void MCP_SetYaw( AActor *a, double deg )
{
	deg = fmod( deg, 360.0 );
	if ( deg < 0 ) deg += 360.0;
	a->SetAngle( angle_t( deg * double( ANGLE_1 ) ), false );
	if ( NETWORK_GetState() == NETSTATE_SERVER ) SERVERCOMMANDS_SetThingAngleExact( a );
}

static void MCP_SetPitchDeg( AActor *a, double deg )
{
	a->SetPitch( int( deg * double( ANGLE_1 ) ), false );
	if ( NETWORK_GetState() == NETSTATE_SERVER ) SERVERCOMMANDS_MoveThingExact( a, CM_PITCH );
}

// mcp_setview <deg> [pitch] | mcp_setview tid=N | mcp_setview class=X
// Pitch is in the engine's convention: negative looks up.
CCMD( mcp_setview )
{
	AActor *me = players[consoleplayer].mo;
	if ( me == NULL || me->player == NULL ) { Printf( "error no player\n" ); return; }
	if ( argv.argc() < 2 ) { Printf( "error usage: mcp_setview <deg> [pitch] | tid=N | class=X\n" ); return; }

	AActor *target = NULL;
	int tid;
	const char *cls = MCP_StrArg( argv, "class" );
	double yawDeg, pitchDeg;

	if ( MCP_IntArg( argv, "tid", tid ) )
	{
		target = MCP_ResolveActor( tid, 0, false );
		if ( target == NULL ) { Printf( "error no actor with tid %d\n", tid ); return; }
	}
	else if ( cls != NULL )
	{
		const PClass *type = PClass::FindClass( cls );
		if ( type == NULL ) { Printf( "error unknown class %s\n", cls ); return; }
		target = MCP_NearestOfClass( me, type );
		if ( target == NULL ) { Printf( "error no %s on the map\n", cls ); return; }
	}
	else
	{
		yawDeg = atof( argv[1] );
		pitchDeg = ( argv.argc() >= 3 ) ? atof( argv[2] ) : MCP_Deg( me->pitch );
	}

	if ( target != NULL )
	{
		yawDeg = MCP_Deg( int( R_PointToAngle2( me->x, me->y, target->x, target->y ) ) );
		double eye = FIXED2FLOAT( me->z ) + FIXED2FLOAT( me->player->viewheight );
		double dz = FIXED2FLOAT( target->z ) + FIXED2FLOAT( target->height ) / 2 - eye;
		pitchDeg = -atan2( dz, MCP_Dist2D( me, target ) ) * 180.0 / M_PI;
	}

	if ( pitchDeg > 89.0 ) pitchDeg = 89.0;
	if ( pitchDeg < -89.0 ) pitchDeg = -89.0;
	MCP_SetYaw( me, yawDeg );
	MCP_SetPitchDeg( me, pitchDeg );

	FString line;
	line.Format( "view angle=%.1f pitch=%.1f", me->angle / double( ANGLE_1 ), MCP_Deg( me->pitch ) );
	if ( target != NULL )
		line.AppendFormat( " tid=%d class=%s", target->tid, target->GetClass()->TypeName.GetChars() );
	Printf( "%s\n", line.GetChars() );
}

// Clears what eats input and has no stock CCMD to close it: console, chat, automap, a frozen clock.
CCMD( mcp_unblock )
{
	C_HideConsole();
	if ( CHAT_GetChatMode() != CHATMODE_NONE ) CHAT_SetChatMode( CHATMODE_NONE );
	if ( automapactive ) AM_Stop();
	MCP_Clock_Thaw();
	Printf( "unblock ok\n" );
}

CCMD( dumpplayers )
{
	static const char *const STATES[] = { "live", "dead", "reborn", "enter", "reborn", "enter" };
	// Not Net_Arbitrator (always 0 here): a server owns no slot, so only offline play has a host.
	const bool offline = NETWORK_GetState() != NETSTATE_SERVER && !NETWORK_InClientMode();
	Printf( "MCP_PLAYERS\n" );
	for ( int i = 0; i < MAXPLAYERS; i++ )
	{
		if ( !playeringame[i] ) continue;
		player_t *p = &players[i];
		FString line;
		line.Format( "player slot=%d bot=%d host=%d spec=%d deadspec=%d", i, p->bIsBot ? 1 : 0,
			( offline && i == consoleplayer ) ? 1 : 0, p->bSpectating ? 1 : 0, p->bDeadSpectator ? 1 : 0 );
		if ( unsigned( p->playerstate ) < countof( STATES ) )
			line.AppendFormat( " state=%s", STATES[p->playerstate] );

		AActor *mo = p->mo;
		if ( mo != NULL )
		{
			AInventory *armor = mo->FindInventory<ABasicArmor>();
			line.AppendFormat( " hp=%d armor=%d", mo->health, ( armor != NULL ) ? armor->Amount : 0 );
			if ( p->ReadyWeapon != NULL )
				line.AppendFormat( " weapon=%s", p->ReadyWeapon->GetClass()->TypeName.GetChars() );
			line.AppendFormat( " x=%.1f y=%.1f z=%.1f angle=%.1f pitch=%.1f tid=%d",
				FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ), FIXED2FLOAT( mo->z ),
				mo->angle / double( ANGLE_1 ), MCP_Deg( mo->pitch ), mo->tid );
		}
		line.AppendFormat( " cheats=%d frags=%d deaths=%u kills=%d items=%d secrets=%d points=%d wins=%u",
			p->cheats, p->fragcount, (unsigned)p->ulDeathCount, p->killcount, p->itemcount,
			p->secretcount, (int)p->lPointCount, (unsigned)p->ulWins );
		if ( p->bOnTeam ) line.AppendFormat( " team=%u", p->Team );
		line.AppendFormat( " ping=%u", (unsigned)p->ulPing );

		FString name = p->userinfo.GetName();
		V_RemoveColorCodes( name );
		line.AppendFormat( " name=%s", name.GetChars() );
		Printf( "%s\n", line.GetChars() );
	}
}

// Letter set for findactors' flags= field; mirrored by FLAG_LETTERS in
// src/parsers/actorstate.ts.
static FString MCP_FlagLetters( AActor *a )
{
	FString f;
	if ( a->flags3 & MF3_ISMONSTER ) f += 'm';
	if ( a->flags & MF_FRIENDLY ) f += 'f';
	if ( a->flags & MF_CORPSE ) f += 'c';
	if ( a->flags2 & MF2_DORMANT ) f += 'd';
	if ( a->flags & MF_SHOOTABLE ) f += 's';
	if ( a->flags & MF_SOLID ) f += 'o';
	if ( ( a->flags2 & MF2_INVULNERABLE ) || ( a->flags5 & MF5_NODAMAGE ) ) f += 'i';
	if ( a->flags & MF_AMBUSH ) f += 'a';
	if ( f.IsEmpty() ) f = "-";
	return f;
}

// --- The actor field table: findactors' keys in their pinned order (src/sampler/watch.ts FIELDS),
// then mcp_rec's own.

// tid survives Destroy, and index is -1 except during a findactors tid= walk.
struct MCPFieldCtx { AActor *me; int tid; int index; };
struct MCPField
{
	const char *name;
	char kind; // 'c' findactors, 't' findactors tid= only, 'd' detail=1 only, 'r' mcp_rec only
	bool ( *value )( FString &v, AActor *a, const MCPFieldCtx &c );
};

static bool MCP_HasSprite( AActor *a ) { return a->state != NULL && a->state->sprite < sprites.Size(); }

static bool MCP_RefField( FString &v, AActor *ref )
{
	if ( ref == NULL ) return false;
	v = MCP_ActorRef( ref );
	return true;
}

static const MCPField MCP_FIELDS[] = {
	{ "class", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v = a->GetClass()->TypeName.GetChars(); return true; } },
	{ "tid", 'c', []( FString &v, AActor *, const MCPFieldCtx &c ) { v.Format( "%d", c.tid ); return true; } },
	{ "hp", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%d", a->health ); return true; } },
	{ "spawnhp", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%d", a->SpawnHealth() ); return true; } },
	{ "x", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", FIXED2FLOAT( a->x ) ); return true; } },
	{ "y", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", FIXED2FLOAT( a->y ) ); return true; } },
	{ "z", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", FIXED2FLOAT( a->z ) ); return true; } },
	{ "angle", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", a->angle / double( ANGLE_1 ) ); return true; } },
	{ "pitch", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", MCP_Deg( a->pitch ) ); return true; } },
	{ "dist", 'c', []( FString &v, AActor *a, const MCPFieldCtx &c ) {
		if ( c.me == NULL ) return false;
		v.Format( "%.1f", MCP_Dist2D( c.me, a ) );
		return true;
	} },
	{ "index", 't', []( FString &v, AActor *, const MCPFieldCtx &c ) {
		if ( c.index < 0 ) return false;
		v.Format( "%d", c.index );
		return true;
	} },
	{ "sprite", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		if ( !MCP_HasSprite( a ) ) return false;
		v = sprites[a->state->sprite].name;
		return true;
	} },
	{ "frame", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		if ( !MCP_HasSprite( a ) ) return false;
		v.Format( "%c", (char)( 'A' + a->state->Frame ) );
		return true;
	} },
	{ "flags", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { v = MCP_FlagLetters( a ); return true; } },
	{ "target", 'c', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_RefField( v, a->target ); } },
	{ "master", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_RefField( v, a->master ); } },
	{ "tracer", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_RefField( v, a->tracer ); } },
	{ "special", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%d", a->special ); return true; } },
	{ "args", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		v.Format( "%d,%d,%d,%d,%d", a->args[0], a->args[1], a->args[2], a->args[3], a->args[4] );
		return true;
	} },
	{ "vel", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		v.Format( "%.2f,%.2f,%.2f", FIXED2FLOAT( a->velx ), FIXED2FLOAT( a->vely ), FIXED2FLOAT( a->velz ) );
		return true;
	} },
	{ "radius", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", FIXED2FLOAT( a->radius ) ); return true; } },
	{ "height", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", FIXED2FLOAT( a->height ) ); return true; } },
	{ "floorz", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%.1f", FIXED2FLOAT( a->floorz ) ); return true; } },
	{ "player", 'd', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		if ( a->player == NULL ) return false;
		v.Format( "%d", int( a->player - players ) );
		return true;
	} },
	{ "state", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		FString label;
		return MCP_StateName( a->state, v, label );
	} },
	{ "label", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) {
		FString id;
		return MCP_StateName( a->state, id, v ) && !v.IsEmpty();
	} },
	{ "tics", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { v.Format( "%d", a->tics ); return true; } },
	{ "buttons", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "buttons" ); } },
	{ "modbuttons", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "modbuttons" ); } },
	{ "wclass", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wclass" ); } },
	{ "pending", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "pending" ); } },
	{ "refire", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "refire" ); } },
	{ "wflags", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wflags" ); } },
	{ "wstate", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wstate" ); } },
	{ "wlabel", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wlabel" ); } },
	{ "wsprite", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wsprite" ); } },
	{ "wframe", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wframe" ); } },
	{ "wtics", 'r', []( FString &v, AActor *a, const MCPFieldCtx & ) { return MCP_PlayerField( v, a, "wtics" ); } },
};

// The head every actor reply shares: class through pitch.
static const int MCP_FIELDS_HEAD = 9;

// Appends name=value when the field has a value, space-separated (none at the start or after a space).
static void MCP_AppendField( FString &line, const MCPField &f, AActor *a, const MCPFieldCtx &c )
{
	FString v;
	if ( !f.value( v, a, c ) ) return;
	if ( !line.IsEmpty() && line[line.Len() - 1] != ' ' ) line += ' ';
	line.AppendFormat( "%s=%s", f.name, v.GetChars() );
}

// The field head shared by findactors' found line, mcp_spawnat's spawned line and the write replies.
static void MCP_AppendActorKv( FString &line, AActor *a, int tid )
{
	const MCPFieldCtx c = { NULL, tid, -1 };
	for ( int i = 0; i < MCP_FIELDS_HEAD; i++ ) MCP_AppendField( line, MCP_FIELDS[i], a, c );
}

// index counts the non-hidden TID walk, including owned items, as MCP_ResolveActor does.
struct MCPFound { AActor *actor; double dist; int index; };

static int MCP_CompareFound( const void *a, const void *b )
{
	double da = static_cast<const MCPFound *>( a )->dist, db = static_cast<const MCPFound *>( b )->dist;
	return ( da < db ) ? -1 : ( da > db ) ? 1 : 0;
}

// findactors [class=X] [tid=N] [radius=N] [limit=N] [detail=1]
CCMD( findactors )
{
	Printf( "MCP_FOUND\n" );
	AActor *me = MCP_ConsoleBody();
	const char *cls = MCP_StrArg( argv, "class" );
	const PClass *type = NULL;
	if ( cls != NULL )
	{
		type = PClass::FindClass( cls );
		if ( type == NULL ) { Printf( "error unknown class %s\n", cls ); return; }
	}
	int tid = 0, radius = 0, limit = 200, detail = 0;
	bool byTid = MCP_IntArg( argv, "tid", tid );
	bool byRadius = MCP_IntArg( argv, "radius", radius ) && me != NULL;
	MCP_IntArg( argv, "limit", limit );
	MCP_IntArg( argv, "detail", detail );

	TArray<MCPFound> hits;
	TThinkerIterator<AActor> all;
	FActorIterator tagged( tid );
	int walked = 0;
	for ( ;; )
	{
		AActor *a = byTid ? tagged.Next() : all.Next();
		if ( a == NULL ) break;
		if ( MCP_IsHidden( a ) ) continue;
		const int index = walked++;
		if ( MCP_IsOwnedItem( a ) ) continue;
		if ( type != NULL && !a->IsKindOf( type ) ) continue;
		MCPFound hit = { a, ( me != NULL ) ? MCP_Dist2D( me, a ) : 0.0, index };
		if ( byRadius && hit.dist > radius ) continue;
		hits.Push( hit );
	}
	if ( me != NULL && hits.Size() > 1 )
		qsort( &hits[0], hits.Size(), sizeof( MCPFound ), MCP_CompareFound );

	unsigned shown = ( limit > 0 && unsigned( limit ) < hits.Size() ) ? unsigned( limit ) : hits.Size();
	MCPFieldCtx c = { me, 0, -1 };
	for ( unsigned i = 0; i < shown; i++ )
	{
		AActor *a = hits[i].actor;
		c.tid = a->tid;
		c.index = byTid ? hits[i].index : -1;
		FString line = "found";
		for ( const MCPField &f : MCP_FIELDS )
			if ( f.kind == 'c' || f.kind == 't' || ( f.kind == 'd' && detail ) ) MCP_AppendField( line, f, a, c );
		Printf( "%s\n", line.GetChars() );
	}
	if ( shown < hits.Size() ) Printf( "truncated shown=%u total=%u\n", shown, hits.Size() );
}

// Strict number parse, so "x=abc" is a usage error rather than a silent 0.
bool MCP_ParseNum( const char *s, double &out )
{
	char *end;
	out = strtod( s, &end );
	return end != s && *end == '\0' && isfinite( out );
}

// Whether v fits a fixed_t map coordinate: past it FLOAT2FIXED wraps, and a trace runs millions of steps.
static bool MCP_MapCoord( double v ) { return v >= -32767 && v <= 32767; }
static const char *const MCP_COORD_RANGE = "coordinates must be within -32767..32767";

// Why P_TestMobjLocation refused: an actor, a line, or a floor/ceiling fit.
static FString MCP_BlockReason( AActor *a )
{
	FString s;
	if ( a->BlockingMobj != NULL ) s.Format( "blocked by %s", MCP_ActorRef( a->BlockingMobj ).GetChars() );
	else if ( a->BlockingLine != NULL ) s.Format( "blocked by line %d", int( a->BlockingLine - lines ) );
	else s.Format( "blocked floor=%.1f ceiling=%.1f z=%.1f height=%.1f", FIXED2FLOAT( a->floorz ),
		FIXED2FLOAT( a->ceilingz ), FIXED2FLOAT( a->z ), FIXED2FLOAT( a->height ) );
	return s;
}

// A fit test (fn) run with PASSMOBJ, so an actor above or below doesn't block, and NOTRIGGER,
// so a wall it touches has its push or impact special left alone.
template <class F> static bool MCP_WithFitFlags( AActor *actor, F fn )
{
	DWORD oldFlags2 = actor->flags2, oldFlags6 = actor->flags6;
	actor->flags2 |= MF2_PASSMOBJ;
	actor->flags6 |= MF6_NOTRIGGER;
	bool ok = MCP_GameCall( fn );
	actor->flags2 = oldFlags2;
	actor->flags6 = oldFlags6;
	return ok;
}

// The spawn test, shared with mcp_place's move.
static bool MCP_SpawnFits( AActor *actor )
{
	return MCP_WithFitFlags( actor, [actor]() { return P_TestMobjLocation( actor ); } );
}

// Destroys a spawn that is not kept, taking it back out of the kill, item and secret totals.
static void MCP_DropSpawn( AActor *actor )
{
	MCPBridgeReplySuspendGuard gameOutput;
	actor->ClearCounters();
	actor->Destroy();
}

// Whether the straight path between two points crosses no wall (a one-sided or blocking line, or
// an opening lower than the actor), using FSlide::SlideTraverse's line tests.
static bool MCP_PathClear( AActor *actor, fixed_t x1, fixed_t y1, fixed_t x2, fixed_t y2 )
{
	FLineOpening open;
	FPathTraverse it( x1, y1, x2, y2, PT_ADDLINES );
	intercept_t *in;
	while ( ( in = it.Next() ) != NULL )
	{
		line_t *li = in->d.line;
		if ( !( li->flags & ML_TWOSIDED ) || li->backsector == NULL ) return false;
		if ( li->flags & ( ML_BLOCKING | ML_BLOCKEVERYTHING ) ) return false;
		P_LineOpening( open, actor, li, it.Trace().x + FixedMul( it.Trace().dx, in->frac ),
			it.Trace().y + FixedMul( it.Trace().dy, in->frac ) );
		if ( open.range < actor->height ) return false;
	}
	return true;
}

static FString MCP_FmtNum( double v );

// Whether z keeps an actor this tall inside a fixed_t, else err: above 32767 - height, z + height
// wraps and the fit test's ceiling and actor-overlap checks pass wrongly.
static bool MCP_ZFits( double z, fixed_t height, FString &err )
{
	const double top = 32767 - FIXED2DBL( height );
	if ( z >= -32767 && z <= top ) return true;
	err.Format( "z must be within -32767..%s for height %s", MCP_FmtNum( top ).GetChars(),
		MCP_FmtNum( FIXED2DBL( height ) ).GetChars() );
	return false;
}

// The find= radius limit and smallest ring step: about 3.3k probes at worst.
static const double MCP_FIND_MAX = 256.0;
static const double MCP_FIND_MIN_STEP = 8.0;

// Spawns the blocked actor's class at the nearest free spot within maxDist with no wall between, or
// returns NULL; the blocked actor only probes and ends back at the requested spot.
static AActor *MCP_FindSpawnSpot( AActor *probe, fixed_t x, fixed_t y, bool hasZ, double maxDist, double &moved )
{
	const double step = MAX<double>( FIXED2FLOAT( probe->radius ), MCP_FIND_MIN_STEP );
	const fixed_t z = probe->z;
	const int rings = int( floor( maxDist / step ) );
	for ( int k = 1; k <= rings; k++ )
	{
		const int points = int( ceil( 2 * M_PI * k ) );
		for ( int i = 0; i < points; i++ )
		{
			const double a = 2 * M_PI * i / points;
			const double cxd = FIXED2FLOAT( x ) + k * step * cos( a ), cyd = FIXED2FLOAT( y ) + k * step * sin( a );
			// A ring point past the fixed-point range would wrap to the far side of the map.
			if ( !MCP_MapCoord( cxd ) || !MCP_MapCoord( cyd ) ) continue;
			const fixed_t cx = FLOAT2FIXED( cxd );
			const fixed_t cy = FLOAT2FIXED( cyd );
			// From the requested spot: P_LineOpening reads the actor's z for 3D floors and midtex.
			probe->SetOrigin( x, y, z );
			if ( !MCP_PathClear( probe, x, y, cx, cy ) ) continue;
			// Spawn's ONFLOORZ order: z on the sector floor first, so SetOrigin's floorz
			// refresh (P_FindFloorCeiling) only counts 3D floors at or below it.
			const fixed_t sectorFloor = P_PointInSector( cx, cy )->floorplane.ZatPoint( cx, cy );
			probe->SetOrigin( cx, cy, hasZ ? z : sectorFloor );
			if ( !hasZ ) probe->z = probe->floorz;
			if ( !MCP_SpawnFits( probe ) ) continue;

			// A fresh spawn, so BeginPlay and every Spawn-time field are the found spot's.
			probe->SetOrigin( x, y, z );
			AActor *fresh = MCP_GameCall( [&]() { return Spawn( probe->GetClass(), cx, cy, hasZ ? z : ONFLOORZ, NO_REPLACE ); } );
			if ( fresh == NULL ) continue;
			// The probe may overlap a spot this close, and must not block its own replacement.
			const DWORD probeFlags2 = probe->flags2;
			probe->flags2 |= MF2_THRUACTORS;
			const bool fits = MCP_SpawnFits( fresh );
			probe->flags2 = probeFlags2;
			if ( fits )
			{
				moved = k * step;
				return fresh;
			}
			MCP_DropSpawn( fresh );
		}
	}
	probe->SetOrigin( x, y, z );
	return NULL;
}

// mcp_spawnat <class> <x> <y> [z=N] [angle=N] [tid=N|auto] [kind=friend|foe] [force=1]
//   [find=R] [health=N] [special=N] [args=a,b,c,d,e] [ambush=1] [dormant=1]
// Spawns directly (no net command), so the reply reports the new actor; z defaults
// to the floor, angle is in degrees, tid defaults to a fresh unique TID.
CCMD( mcp_spawnat )
{
	static const char *const USAGE = "error usage: mcp_spawnat <class> <x> <y> [z=N] [angle=N] "
		"[tid=N|auto] [kind=friend|foe] [force=1] [find=R] [health=N] [special=N] [args=a,b,c,d,e] "
		"[ambush=1] [dormant=1]\n";
	double x, y, z = 0, angle = 0;
	if ( argv.argc() < 4 || strchr( argv[1], '=' ) != NULL || !MCP_ParseNum( argv[2], x ) ||
		!MCP_ParseNum( argv[3], y ) ) { Printf( "%s", USAGE ); return; }
	if ( !MCP_MapCoord( x ) || !MCP_MapCoord( y ) ) { Printf( "error %s\n", MCP_COORD_RANGE ); return; }
	if ( NETWORK_InClientMode() ) { Printf( "error client: spawn on the server instance\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }

	const PClass *type = PClass::FindClass( argv[1] );
	if ( type == NULL || type->ActorInfo == NULL ) { Printf( "error unknown class %s\n", argv[1] ); return; }

	bool hasZ = MCP_NumArg( argv, "z", z );
	FString zErr;
	// The height Spawn will give it: its replacement's default, as ALLOW_REPLACE picks it.
	if ( hasZ && !MCP_ZFits( z, GetDefaultByType( type->GetReplacement() )->height, zErr ) )
	{
		Printf( "error %s\n", zErr.GetChars() );
		return;
	}
	MCP_NumArg( argv, "angle", angle );
	double find = 0, moved = 0;
	bool hasFind = MCP_NumArg( argv, "find", find );
	const char *tidArg = MCP_StrArg( argv, "tid" );
	const char *kind = MCP_StrArg( argv, "kind" );
	const char *argsArg = MCP_StrArg( argv, "args" );
	int force = 0, health = 0, special = 0, ambush = 0, dormant = 0;
	MCP_IntArg( argv, "force", force );
	bool hasHealth = MCP_IntArg( argv, "health", health );
	bool hasSpecial = MCP_IntArg( argv, "special", special );
	MCP_IntArg( argv, "ambush", ambush );
	MCP_IntArg( argv, "dormant", dormant );
	bool friendKind = kind != NULL && strcmp( kind, "friend" ) == 0;
	bool foeKind = kind != NULL && strcmp( kind, "foe" ) == 0;
	if ( kind != NULL && !friendKind && !foeKind ) { Printf( "%s", USAGE ); return; }
	if ( force ) hasFind = false;
	if ( hasFind && !( find > 0 && find <= MCP_FIND_MAX ) )
	{
		Printf( "error find wants a radius above 0, up to %s\n", MCP_FmtNum( MCP_FIND_MAX ).GetChars() );
		return;
	}

	int args[5] = { 0, 0, 0, 0, 0 };
	if ( argsArg != NULL )
	{
		const char *p = argsArg;
		for ( int i = 0; i < 5 && *p != '\0'; i++ )
		{
			args[i] = atoi( p );
			p = strchr( p, ',' );
			if ( p == NULL ) break;
			p++;
		}
	}

	AActor *actor = MCP_GameCall( [&]() { return Spawn( type, FLOAT2FIXED( x ), FLOAT2FIXED( y ),
		hasZ ? FLOAT2FIXED( z ) : ONFLOORZ, ALLOW_REPLACE ); } );
	if ( actor == NULL ) { Printf( "error spawn failed\n" ); return; }

	// Never searched: a light fails the first test for a reason no other spot cures,
	// and each test of a missile or MBF bouncer damages what it overlaps.
	const PClass *lightType = PClass::FindClass( "DynamicLight" );
	bool isLight = lightType != NULL && actor->IsKindOf( lightType );
	bool isMissile = ( actor->flags & MF_MISSILE ) || ( actor->BounceFlags & BOUNCE_MBF );
	if ( !force && !MCP_SpawnFits( actor ) )
	{
		FString why = MCP_BlockReason( actor );
		bool search = hasFind && !isLight && !isMissile;
		AActor *placed = search ? MCP_FindSpawnSpot( actor, FLOAT2FIXED( x ), FLOAT2FIXED( y ), hasZ, find, moved ) : NULL;
		MCP_DropSpawn( actor );
		if ( placed == NULL )
		{
			if ( search ) Printf( "error no free spot within %s: %s\n", MCP_FmtNum( find ).GetChars(), why.GetChars() );
			else Printf( "error %s\n", why.GetChars() );
			return;
		}
		actor = placed;
	}

	angle = fmod( angle, 360.0 );
	if ( angle < 0 ) angle += 360.0;
	actor->angle = angle_t( angle * double( ANGLE_1 ) );
	actor->tid = ( tidArg == NULL || strcmp( tidArg, "auto" ) == 0 ) ? P_FindUniqueTID( 0, 0 ) : atoi( tidArg );
	if ( actor->tid != 0 ) actor->AddToHash();
	if ( actor->flags & MF_SPECIAL ) actor->flags |= MF_DROPPED;

	if ( friendKind )
	{
		if ( actor->CountsAsKill() ) level.total_monsters--;
		actor->FriendPlayer = consoleplayer + 1;
		actor->flags |= MF_FRIENDLY;
		actor->LastHeard = players[consoleplayer].mo;
		actor->health = actor->SpawnHealth();
	}
	else if ( foeKind )
	{
		actor->FriendPlayer = 0;
		actor->flags &= ~MF_FRIENDLY;
		actor->health = actor->SpawnHealth();
	}
	if ( hasHealth ) actor->health = health;
	if ( hasSpecial )
	{
		actor->special = special;
		for ( int i = 0; i < 5; i++ ) actor->args[i] = args[i];
		// Spawn ran BeginPlay before args existed; lights seed intensity there.
		if ( argsArg != NULL && isLight )
		{
			fixed_t oldZ = actor->z;
			MCP_GameCall( [&]() { actor->BeginPlay(); } );
			actor->z = oldZ;
		}
	}
	// Direct writes rather than HandleSpawnFlags, which also resets InitialState.
	if ( ambush ) actor->flags |= MF_AMBUSH;
	// MTF_DORMANT too, or a light's PostBeginPlay re-activates it on the first tic.
	if ( dormant ) { actor->SpawnFlags |= MTF_DORMANT; MCP_GameCall( [&]() { actor->Deactivate( NULL ); } ); }

	if ( NETWORK_GetState() == NETSTATE_SERVER )
	{
		SERVERCOMMANDS_SpawnThing( actor );
		// The probe's drop sent the totals before this spawn counted on the clients.
		if ( moved > 0 ) { SERVERCOMMANDS_SetMapNumTotalMonsters( ); SERVERCOMMANDS_SetMapNumTotalItems( ); }
		if ( actor->angle != 0 ) SERVERCOMMANDS_SetThingAngle( actor );
		if ( actor->tid != 0 ) SERVERCOMMANDS_SetThingTID( actor );
		if ( kind != NULL || ambush ) SERVERCOMMANDS_SetThingFlags( actor, FLAGSET_FLAGS );
		if ( kind != NULL || hasHealth ) SERVERCOMMANDS_SetThingHealth( actor );
		if ( hasSpecial ) { SERVERCOMMANDS_SetThingSpecial( actor ); SERVERCOMMANDS_SetThingArguments( actor ); }
		if ( dormant ) SERVERCOMMANDS_ThingDeactivate( actor, NULL );
		SERVER_DestroyActorIfClientsidedOnly( actor );
	}

	FString line = "spawned ";
	MCP_AppendActorKv( line, actor, actor->tid );
	line.AppendFormat( " flags=%s", MCP_FlagLetters( actor ).GetChars() );
	if ( stricmp( actor->GetClass()->TypeName.GetChars(), argv[1] ) != 0 ) line.AppendFormat( " requested=%s", argv[1] );
	if ( hasSpecial )
		line.AppendFormat( " special=%d args=%d,%d,%d,%d,%d", actor->special,
			actor->args[0], actor->args[1], actor->args[2], actor->args[3], actor->args[4] );
	if ( force ) line += " forced=1";
	if ( moved > 0 ) line.AppendFormat( " moved=%s", MCP_FmtNum( moved ).GetChars() );
	Printf( "%s\n", line.GetChars() );
}

// --- mcp_setprop: read or write one property on a live actor.

// %.4f with trailing zeros dropped; never %g, whose exponent form the TS parser reads as a string.
static FString MCP_FmtNum( double v )
{
	char buf[64];
	snprintf( buf, sizeof( buf ), "%.4f", v );
	char *end = buf + strlen( buf );
	while ( end > buf && end[-1] == '0' ) end--;
	if ( end > buf && end[-1] == '.' ) end--;
	*end = '\0';
	return strcmp( buf, "-0" ) == 0 ? FString( "0" ) : FString( buf );
}

static FString MCP_FmtFixed( fixed_t v ) { return MCP_FmtNum( FIXED2FLOAT( v ) ); }

static FString MCP_FmtInt( int v )
{
	FString s;
	s.Format( "%d", v );
	return s;
}

bool MCP_ParseInt( const char *s, int &out )
{
	char *end;
	errno = 0;
	long v = strtol( s, &end, 10 );
	if ( end == s || *end != '\0' || errno == ERANGE || v < INT_MIN || v > INT_MAX ) return false;
	out = int( v );
	return true;
}

static bool MCP_IsServer() { return NETWORK_GetState() == NETSTATE_SERVER; }

// The flag word a server command carries a flag in; FLAGSET_UNKNOWN for none
// (deprecated flags, item/weapon/player flags, BounceFlags, effects).
static FlagSet MCP_FlagSetOf( AActor *a, FFlagDef *fd )
{
	static const struct { DWORD AActor::*word; FlagSet set; } WORDS[] = {
		{ &AActor::flags, FLAGSET_FLAGS }, { &AActor::flags2, FLAGSET_FLAGS2 },
		{ &AActor::flags3, FLAGSET_FLAGS3 }, { &AActor::flags4, FLAGSET_FLAGS4 },
		{ &AActor::flags5, FLAGSET_FLAGS5 }, { &AActor::flags6, FLAGSET_FLAGS6 },
		{ &AActor::flags7, FLAGSET_FLAGS7 }, { &AActor::STFlags, FLAGSET_FLAGSST } };
	if ( fd->structoffset == -1 ) return FLAGSET_UNKNOWN;
	DWORD *flagp = (DWORD *)( ( (char *)a ) + fd->structoffset );
	for ( size_t i = 0; i < countof( WORDS ); i++ )
		if ( flagp == &( a->*WORDS[i].word ) ) return WORDS[i].set;
	return FLAGSET_UNKNOWN;
}

// A_ChangeFlag's body (thingdef_codeptr.cpp) without its client bail-out: relink,
// counters (invasion included, a corpse skipped as UZDoom's ModActorFlag does) and,
// on a server, the flag word and totals.
static void MCP_ChangeFlag( AActor *a, FFlagDef *fd, bool set )
{
	bool killBefore = a->CountsAsKill() && a->health > 0;
	INTBOOL itemBefore = a->flags & MF_COUNTITEM;
	INTBOOL secretBefore = a->flags5 & MF5_COUNTSECRET;

	if ( fd->structoffset == -1 ) HandleDeprecatedFlags( a, a->GetClass()->ActorInfo, set, fd->flagbit );
	else
	{
		DWORD *flagp = (DWORD *)( ( (char *)a ) + fd->structoffset );
		DWORD oldFlag = *flagp;
		bool linkChange = flagp == &a->flags && ( fd->flagbit == MF_NOBLOCKMAP || fd->flagbit == MF_NOSECTOR );
		if ( linkChange ) a->UnlinkFromWorld();
		ModActorFlag( a, fd, set );
		if ( linkChange ) a->LinkToWorld();

		if ( MCP_IsServer() && *flagp != oldFlag ) SERVERCOMMANDS_SetThingFlags( a, MCP_FlagSetOf( a, fd ) );
	}

	bool killAfter = a->CountsAsKill() && a->health > 0;
	if ( killBefore != killAfter )
	{
		level.total_monsters += killAfter ? 1 : -1;
		INVASION_UpdateMonsterCount( a, !killAfter );
		if ( MCP_IsServer() ) SERVERCOMMANDS_SetMapNumTotalMonsters();
	}
	INTBOOL itemAfter = a->flags & MF_COUNTITEM;
	if ( !itemBefore != !itemAfter )
	{
		level.total_items += itemAfter ? 1 : -1;
		if ( MCP_IsServer() ) SERVERCOMMANDS_SetMapNumTotalItems();
	}
	INTBOOL secretAfter = a->flags5 & MF5_COUNTSECRET;
	if ( !secretBefore != !secretAfter )
	{
		level.total_secrets += secretAfter ? 1 : -1;
		if ( MCP_IsServer() ) SERVERCOMMANDS_SetMapNumTotalSecrets();
	}
}

// The flag a "flag:NAME" prop names, where a "Group.FLAG" prefix names a flag list's declaring
// class (ACTOR., INVENTORY.), not any actor class.
static FFlagDef *MCP_FindFlag( AActor *a, const char *name )
{
	const char *dot = strchr( name, '.' );
	if ( dot == NULL ) return FindFlag( a->GetClass(), name, NULL );
	FString part1( name, dot - name );
	return FindFlag( a->GetClass(), part1.GetChars(), dot + 1 );
}

// raw is the first value token, str every value token joined by one space.
struct MCPPropValue { double num; FString str; const char *raw; bool force; };

// Marks a prop whose write replicates itself (or has nothing to send).
static void MCP_SentInWrite( AActor * ) {}

struct MCPProp
{
	const char *name;
	char type;  // n number, i integer, b 0/1, s one-token string, t free text, - unsupported
	FString ( *read )( AActor * );
	// false: note holds the error text; true: note holds extra reply fields.
	bool ( *write )( AActor *, const MCPPropValue &, FString &note );
	// What a server sends clients after the write; NULL refuses the write on a server.
	void ( *replicate )( AActor * );
};

#define MCP_FIXED_PROP( nm, field, send ) { nm, 'n', []( AActor *a ) { return MCP_FmtFixed( a->field ); }, \
	[]( AActor *a, const MCPPropValue &v, FString & ) { a->field = FLOAT2FIXED( v.num ); return true; }, send }
#define MCP_INT_PROP( nm, field ) { nm, 'i', []( AActor *a ) { return MCP_FmtInt( a->field ); }, \
	[]( AActor *a, const MCPPropValue &v, FString & ) { a->field = int( v.num ); return true; }, NULL }
#define MCP_UNSUPPORTED_PROP( nm ) { nm, '-', NULL, NULL, NULL }

// The same dead check as ACS SetActorProperty.
static bool MCP_IsDead( AActor *a )
{
	return a->health <= 0 || ( a->player != NULL && a->player->playerstate == PST_DEAD );
}

static bool MCP_SetHealth( AActor *a, const MCPPropValue &v, FString &note )
{
	if ( MCP_IsDead( a ) )
	{
		note = "already dead";
		return false;
	}
	a->health = int( v.num );
	if ( a->player != NULL ) a->player->health = a->health;
	// Player health only, as ACS does: SetThingHealth sends a byte.
	if ( MCP_IsServer() && a->player != NULL && SERVER_IsValidClient( ULONG( a->player - players ) ) )
		SERVERCOMMANDS_SetPlayerHealth( ULONG( a->player - players ) );
	if ( a->health <= 0 )
	{
		// No source, like ACS with no activator; Die replicates the kill itself.
		a->Die( NULL, NULL );
		note = " died=1";
		if ( a->ObjectFlags & OF_EuthanizeMe ) note += " removed=1";
	}
	return true;
}

// A_SetSize's pattern (UZDoom), minus FullHeight: APlayerPawn::Tick resets a pawn's height
// from the class default every tic, so that write can't stick.
static bool MCP_SetSize( AActor *a, const char *prop, fixed_t radius, fixed_t height, const MCPPropValue &v,
	FString &note )
{
	if ( v.num < 0 )
	{
		note.Format( "bad value %s for %s", v.raw, prop );
		return false;
	}
	if ( a->IsKindOf( RUNTIME_CLASS( APlayerPawn ) ) && height != a->height )
	{
		note = "unsupported prop height on a player pawn on this engine";
		return false;
	}
	fixed_t oldRadius = a->radius, oldHeight = a->height;
	a->UnlinkFromWorld();
	a->radius = radius;
	a->height = height;
	a->LinkToWorld();
	if ( !v.force && !P_TestMobjLocation( a ) )
	{
		note = MCP_BlockReason( a );
		a->UnlinkFromWorld();
		a->radius = oldRadius;
		a->height = oldHeight;
		a->LinkToWorld();
		return false;
	}
	return true;
}

// DEFINE_PROPERTY(renderstyle)'s table (thingdef_properties.cpp), which is function-static there.
static const char *const MCP_RENDERSTYLE_NAMES[] = {
	"NONE", "NORMAL", "FUZZY", "SOULTRANS", "OPTFUZZY", "STENCIL",
	"TRANSLUCENT", "ADD", "SHADED", "SHADOW", "SUBTRACT" };
static const ERenderStyle MCP_RENDERSTYLE_VALUES[] = {
	STYLE_None, STYLE_Normal, STYLE_Fuzzy, STYLE_SoulTrans, STYLE_OptFuzzy,
	STYLE_TranslucentStencil, STYLE_Translucent, STYLE_Add, STYLE_Shaded,
	STYLE_Shadow, STYLE_Subtract };

static FString MCP_GetRenderStyle( AActor *a )
{
	for ( size_t i = 0; i < countof( MCP_RENDERSTYLE_VALUES ); i++ )
		if ( a->RenderStyle == LegacyRenderStyles[MCP_RENDERSTYLE_VALUES[i]] ) return MCP_RENDERSTYLE_NAMES[i];
	return "CUSTOM";
}

static bool MCP_SetRenderStyle( AActor *a, const MCPPropValue &v, FString &note )
{
	const char *name = v.raw;
	if ( strnicmp( name, "style_", 6 ) == 0 ) name += 6;
	for ( size_t i = 0; i < countof( MCP_RENDERSTYLE_NAMES ); i++ )
	{
		if ( stricmp( name, MCP_RENDERSTYLE_NAMES[i] ) == 0 )
		{
			a->RenderStyle = LegacyRenderStyles[MCP_RENDERSTYLE_VALUES[i]];
			return true;
		}
	}
	note.Format( "unknown renderstyle %s", v.raw );
	return false;
}

static bool MCP_SetFriendly( AActor *a, const MCPPropValue &v, FString & )
{
	bool on = v.num != 0;
	MCP_ChangeFlag( a, FindFlag( a->GetClass(), "FRIENDLY", NULL ), on );
	a->FriendPlayer = on ? consoleplayer + 1 : 0;
	if ( on ) a->LastHeard = players[consoleplayer].mo;
	return true;
}

static bool MCP_SetDormant( AActor *a, const MCPPropValue &v, FString &note )
{
	bool was = ( a->flags2 & MF2_DORMANT ) != 0;
	// Sent first and always, as Thing_Activate/Deactivate do: the call may remove the actor.
	if ( MCP_IsServer() )
	{
		if ( v.num != 0 ) SERVERCOMMANDS_ThingDeactivate( a, NULL );
		else SERVERCOMMANDS_ThingActivate( a, NULL );
	}
	if ( v.num != 0 ) a->Deactivate( NULL );
	else a->Activate( NULL );
	// Only a live monster's native Activate/Deactivate flips the bit; lights and the like toggle without it.
	if ( ( ( a->flags2 & MF2_DORMANT ) != 0 ) == was ) note = " noop=1";
	return true;
}

static void MCP_SendSpeed( AActor *a ) { SERVERCOMMANDS_SetThingProperty( a, APROP_Speed ); }
static void MCP_SendAlpha( AActor *a ) { SERVERCOMMANDS_SetThingProperty( a, APROP_Alpha ); }
static void MCP_SendRenderStyle( AActor *a ) { SERVERCOMMANDS_SetThingProperty( a, APROP_RenderStyle ); }
static void MCP_SendGravity( AActor *a ) { SERVERCOMMANDS_SetThingGravity( a ); }
static void MCP_SendScaleX( AActor *a ) { SERVERCOMMANDS_SetThingScale( a, ACTORSCALE_X ); }
static void MCP_SendScaleY( AActor *a ) { SERVERCOMMANDS_SetThingScale( a, ACTORSCALE_Y ); }
static void MCP_SendScale( AActor *a ) { SERVERCOMMANDS_SetThingScale( a, ACTORSCALE_X | ACTORSCALE_Y ); }
static void MCP_SendSpecies( AActor *a ) { SERVERCOMMANDS_SetThingStringProperty( a, APROP_Species ); }
static void MCP_SendNameTag( AActor *a ) { SERVERCOMMANDS_SetThingStringProperty( a, APROP_NameTag ); }

static const MCPProp MCP_PROPS[] = {
	MCP_FIXED_PROP( "speed", Speed, MCP_SendSpeed ),
	MCP_FIXED_PROP( "gravity", gravity, MCP_SendGravity ),
	MCP_UNSUPPORTED_PROP( "friction" ),
	MCP_FIXED_PROP( "meleerange", meleerange, NULL ),
	MCP_FIXED_PROP( "maxstepheight", MaxStepHeight, NULL ),
	MCP_FIXED_PROP( "maxdropoffheight", MaxDropOffHeight, NULL ),
	MCP_FIXED_PROP( "damagefactor", DamageFactor, NULL ),
	MCP_UNSUPPORTED_PROP( "damagemultiply" ),
	{ "alpha", 'n', []( AActor *a ) { return MCP_FmtFixed( a->alpha ); },
		[]( AActor *a, const MCPPropValue &v, FString & ) { a->alpha = clamp<fixed_t>( FLOAT2FIXED( v.num ), 0, FRACUNIT ); return true; },
		MCP_SendAlpha },
	MCP_FIXED_PROP( "scalex", scaleX, MCP_SendScaleX ),
	MCP_FIXED_PROP( "scaley", scaleY, MCP_SendScaleY ),
	{ "scale", 'n', []( AActor *a ) { return MCP_FmtFixed( a->scaleX ); },
		[]( AActor *a, const MCPPropValue &v, FString & ) { a->scaleX = a->scaleY = FLOAT2FIXED( v.num ); return true; },
		MCP_SendScale },
	MCP_INT_PROP( "mass", Mass ),
	MCP_INT_PROP( "score", Score ),
	MCP_INT_PROP( "accuracy", accuracy ),
	MCP_INT_PROP( "stamina", stamina ),
	MCP_INT_PROP( "reactiontime", reactiontime ),
	MCP_UNSUPPORTED_PROP( "friendlyseeblocks" ),
	{ "damage", 'i', []( AActor *a ) {
			return ( a->Damage & 0xC0000000 ) == 0x40000000 ? FString( "expr" ) : MCP_FmtInt( a->Damage ); },
		[]( AActor *a, const MCPPropValue &v, FString &note ) {
			// 0x40000000 and up would select a DECORATE damage expression.
			if ( v.num >= 0x40000000 ) { note.Format( "bad value %s for damage", v.raw ); return false; }
			a->Damage = int( v.num );
			return true; }, NULL },
	{ "health", 'i', []( AActor *a ) { return MCP_FmtInt( a->health ); }, MCP_SetHealth, MCP_SentInWrite },
	{ "height", 'n', []( AActor *a ) { return MCP_FmtFixed( a->height ); },
		[]( AActor *a, const MCPPropValue &v, FString &note ) {
			return MCP_SetSize( a, "height", a->radius, FLOAT2FIXED( v.num ), v, note ); }, NULL },
	{ "radius", 'n', []( AActor *a ) { return MCP_FmtFixed( a->radius ); },
		[]( AActor *a, const MCPPropValue &v, FString &note ) {
			return MCP_SetSize( a, "radius", FLOAT2FIXED( v.num ), a->height, v, note ); }, NULL },
	{ "renderstyle", 's', MCP_GetRenderStyle, MCP_SetRenderStyle, MCP_SendRenderStyle },
	{ "friendly", 'b', []( AActor *a ) { return MCP_FmtInt( ( a->flags & MF_FRIENDLY ) ? 1 : 0 ); },
		MCP_SetFriendly, MCP_SentInWrite },
	{ "dormant", 'b', []( AActor *a ) { return MCP_FmtInt( ( a->flags2 & MF2_DORMANT ) ? 1 : 0 ); },
		MCP_SetDormant, MCP_SentInWrite },
	{ "nametag", 't', []( AActor *a ) { return FString( a->GetTag() ); },
		[]( AActor *a, const MCPPropValue &v, FString & ) { a->SetTag( v.str.GetChars() ); return true; },
		MCP_SendNameTag },
	{ "species", 's', []( AActor *a ) { return FString( a->Species.GetChars() ); },
		[]( AActor *a, const MCPPropValue &v, FString & ) { a->Species = FName( v.raw ); return true; },
		MCP_SendSpecies },
	{ "damagetype", 's', []( AActor *a ) { return FString( a->DamageType.GetChars() ); },
		[]( AActor *a, const MCPPropValue &v, FString & ) { a->DamageType = FName( v.raw ); return true; }, NULL },
};

// --- The target of the CCMDs that act on one live actor: argv[1..2] are <tid> <index>, tid 0 the
// console player's body (index 0 only).

static bool MCP_TargetArgs( FCommandLine &argv, int &tid, int &index )
{
	return argv.argc() >= 3 && MCP_ParseInt( argv[1], tid ) && MCP_ParseInt( argv[2], index ) &&
		tid >= 0 && index >= 0 && !( tid == 0 && index > 0 );
}

// False, after printing why, where verb can't act: a client only mirrors the server, and
// consoleplayer is slot 0 on a server, whoever holds it.
static bool MCP_TargetGuards( const char *verb, int tid )
{
	if ( NETWORK_InClientMode() ) { Printf( "error client: %s on the server instance\n", verb ); return false; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return false; }
	if ( MCP_IsServer() && tid == 0 ) { Printf( "error server: pass a tid\n" ); return false; }
	return true;
}

// The target actor, or NULL after printing why: none there, or a spectator's body.
static AActor *MCP_ResolveTarget( int tid, int index )
{
	AActor *a = MCP_ResolveActor( tid, index, true );
	if ( a == NULL ) { Printf( "error no actor with tid %d index %d\n", tid, index ); return NULL; }
	if ( a->player != NULL && a->player->bSpectating ) { Printf( "error spectator\n" ); return NULL; }
	return a;
}

// A write reply's tail: flags=, the write's own extra fields, then name= (the tag, which may hold spaces).
static void MCP_AppendTail( FString &line, AActor *a, const FString &extra )
{
	FString tag = a->GetTag();
	V_RemoveColorCodes( tag );
	line.AppendFormat( " flags=%s%s name=%s", MCP_FlagLetters( a ).GetChars(), extra.GetChars(), tag.GetChars() );
}

// mcp_setprop <tid> <index> <prop> [value...] [force=1]
// A direct write, so it applies while paused and the actor acts on it once the sim runs.
CCMD( mcp_setprop )
{
	static const char *const USAGE = "error usage: mcp_setprop <tid> <index> <prop> [value...] [force=1]\n";
	int tid, index;
	if ( argv.argc() < 4 || !MCP_TargetArgs( argv, tid, index ) ) { Printf( "%s", USAGE ); return; }
	if ( !MCP_TargetGuards( "set", tid ) ) return;

	const char *propArg = argv[3];
	bool isFlag = strnicmp( propArg, "flag:", 5 ) == 0;
	const MCPProp *prop = NULL;
	if ( !isFlag )
	{
		for ( const MCPProp &p : MCP_PROPS )
			if ( stricmp( p.name, propArg ) == 0 ) { prop = &p; break; }
		if ( prop == NULL ) { Printf( "error unknown prop %s\n", propArg ); return; }
		if ( prop->type == '-' ) { Printf( "error unsupported prop %s on this engine\n", prop->name ); return; }
	}
	char type = isFlag ? 'b' : prop->type;

	int first = 4, last = argv.argc();
	bool forceable = prop != NULL && ( stricmp( prop->name, "height" ) == 0 || stricmp( prop->name, "radius" ) == 0 );
	MCPPropValue v = { 0, "", NULL, false };
	if ( forceable && last - first == 2 && strcmp( argv[last - 1], "force=1" ) == 0 ) { v.force = true; last--; }
	if ( type != 't' && last - first > 1 ) { Printf( "%s", USAGE ); return; }
	bool reading = last == first;
	if ( !reading )
	{
		v.raw = argv[first];
		for ( int i = first; i < last; i++ )
		{
			if ( i > first ) v.str += ' ';
			v.str += argv[i];
		}
		bool ok = true;
		int n = 0;
		// Fixed point holds only +-32767.
		if ( type == 'n' ) ok = MCP_ParseNum( v.raw, v.num ) && fabs( v.num ) <= 32767;
		else if ( type == 'i' ) { ok = MCP_ParseInt( v.raw, n ); v.num = n; }
		else if ( type == 'b' ) { ok = strcmp( v.raw, "0" ) == 0 || strcmp( v.raw, "1" ) == 0; v.num = v.raw[0] == '1'; }
		if ( !ok ) { Printf( "error bad value %s for %s\n", v.str.GetChars(), propArg ); return; }
		// Clients would silently keep the old value.
		if ( MCP_IsServer() && prop != NULL && prop->replicate == NULL )
		{
			Printf( "error not replicated: %s\n", prop->name );
			return;
		}
	}

	AActor *a = MCP_ResolveTarget( tid, index );
	if ( a == NULL ) return;
	FFlagDef *fd = isFlag ? MCP_FindFlag( a, propArg + 5 ) : NULL;
	if ( isFlag && fd == NULL ) { Printf( "error unknown flag %s\n", propArg + 5 ); return; }
	if ( !reading && isFlag && MCP_IsServer() && MCP_FlagSetOf( a, fd ) == FLAGSET_UNKNOWN )
	{
		Printf( "error not replicated: %s\n", propArg );
		return;
	}

	auto readNow = [&]() { return isFlag ? MCP_FmtInt( CheckActorFlag( a, fd ) ? 1 : 0 ) : prop->read( a ); };
	FString old = readNow(), note;
	int tid0 = a->tid;
	if ( !reading )
	{
		if ( isFlag ) MCP_GameCall( [&]() { MCP_ChangeFlag( a, fd, v.num != 0 ); } );
		else if ( !MCP_GameCall( [&]() { return prop->write( a, v, note ); } ) ) { Printf( "error %s\n", note.GetChars() ); return; }
		else if ( MCP_IsServer() ) prop->replicate( a );
	}

	FString line;
	line.Format( "setprop prop=%s", isFlag ? propArg : prop->name );
	// nametag has neither: name= (last, may hold spaces) already shows it.
	if ( type != 't' )
	{
		line.AppendFormat( " old=%s", old.GetChars() );
		if ( !reading ) line.AppendFormat( " new=%s", readNow().GetChars() );
	}
	line += ' ';
	MCP_AppendActorKv( line, a, tid0 );
	MCP_AppendTail( line, a, note );
	Printf( "%s\n", line.GetChars() );
}

// --- acting on other actors: mcp_place / mcp_remove / mcp_damage / mcp_inv, direct writes as mcp_setprop's.

// "key=N" parsed strictly: false when absent; bad is set when it is there but not a number.
static bool MCP_StrictNumArg( FCommandLine &argv, const char *key, double &out, bool &bad )
{
	const char *v = MCP_StrArg( argv, key );
	if ( v == NULL ) return false;
	if ( !MCP_ParseNum( v, out ) ) bad = true;
	return true;
}

// P_MoveThing without its fit test: the same fog, interpolation reset and replication.
static void MCP_ForceMove( AActor *a, fixed_t x, fixed_t y, fixed_t z, bool fog )
{
	MCPBridgeReplySuspendGuard gameOutput;
	const fixed_t oldX = a->x, oldY = a->y, oldZ = a->z;
	a->SetOrigin( x, y, z );
	if ( fog )
	{
		const fixed_t spots[2][3] = { { x, y, z }, { oldX, oldY, oldZ } };
		for ( int i = 0; i < 2; i++ )
		{
			AActor *f = Spawn<ATeleportFog>( spots[i][0], spots[i][1], spots[i][2] + TELEFOGHEIGHT, ALLOW_REPLACE );
			if ( MCP_IsServer() ) SERVERCOMMANDS_SpawnThing( f );
		}
	}
	a->PrevX = x;
	a->PrevY = y;
	a->PrevZ = z;
	if ( a == players[consoleplayer].camera ) R_ResetViewInterpolation();
	if ( MCP_IsServer() )
		SERVERCOMMANDS_MoveThing( a, ( oldX != x ? CM_X : 0 ) | ( oldY != y ? CM_Y : 0 ) | ( oldZ != z ? CM_Z : 0 ) );
}

// mcp_place <tid> <index> [x=] [y=] [z=] [angle=] [pitch=] [vx=] [vy=] [vz=] [addvel=1] [fog=1] [force=1]
// Position (P_MoveThing with the spawn test's flags), then angle/pitch in degrees, then velocity in
// units per tic, where a refused move applies nothing at all.
CCMD( mcp_place )
{
	static const char *const USAGE = "error usage: mcp_place <tid> <index> [x=] [y=] [z=] [angle=] [pitch=] "
		"[vx=] [vy=] [vz=] [addvel=1] [fog=1] [force=1]\n";
	static const char *const POS_KEYS[3] = { "x", "y", "z" };
	static const char *const VEL_KEYS[3] = { "vx", "vy", "vz" };
	int tid, index, addvel = 0, fog = 0, force = 0;
	double pos[3], vel[3], angle = 0, pitch = 0;
	bool hasPos[3], hasVel[3], bad = false;
	for ( int i = 0; i < 3; i++ )
	{
		hasPos[i] = MCP_StrictNumArg( argv, POS_KEYS[i], pos[i], bad );
		hasVel[i] = MCP_StrictNumArg( argv, VEL_KEYS[i], vel[i], bad );
	}
	const bool hasAngle = MCP_StrictNumArg( argv, "angle", angle, bad );
	const bool hasPitch = MCP_StrictNumArg( argv, "pitch", pitch, bad );
	MCP_IntArg( argv, "addvel", addvel );
	MCP_IntArg( argv, "fog", fog );
	MCP_IntArg( argv, "force", force );
	const bool moving = hasPos[0] || hasPos[1] || hasPos[2], launching = hasVel[0] || hasVel[1] || hasVel[2];
	if ( !MCP_TargetArgs( argv, tid, index ) || bad || !( moving || launching || hasAngle || hasPitch ) )
	{
		Printf( "%s", USAGE );
		return;
	}
	for ( int i = 0; i < 3; i++ )
	{
		if ( hasPos[i] && !MCP_MapCoord( pos[i] ) ) { Printf( "error %s\n", MCP_COORD_RANGE ); return; }
		if ( hasVel[i] && !MCP_MapCoord( vel[i] ) ) { Printf( "error velocity must be within -32767..32767\n" ); return; }
	}
	if ( hasPitch && fabs( pitch ) > 90 ) { Printf( "error pitch must be within -90..90\n" ); return; }
	if ( !MCP_TargetGuards( "place", tid ) ) return;
	AActor *a = MCP_ResolveTarget( tid, index );
	if ( a == NULL ) return;

	const fixed_t fromX = a->x, fromY = a->y, fromZ = a->z;
	if ( moving )
	{
		const fixed_t x = hasPos[0] ? FLOAT2FIXED( pos[0] ) : fromX, y = hasPos[1] ? FLOAT2FIXED( pos[1] ) : fromY;
		// summon_at's floor default, given literally: P_MoveThing's fit test fails ONFLOORZ.
		const fixed_t z = hasPos[2] ? FLOAT2FIXED( pos[2] )
			: ( hasPos[0] || hasPos[1] ) ? P_PointInSector( x, y )->floorplane.ZatPoint( x, y ) : fromZ;
		FString zErr;
		if ( !MCP_ZFits( FIXED2DBL( z ), a->height, zErr ) ) { Printf( "error %s\n", zErr.GetChars() ); return; }
		if ( force ) MCP_ForceMove( a, x, y, z, fog != 0 );
		else if ( !MCP_WithFitFlags( a, [&]() { return P_MoveThing( a, x, y, z, fog != 0 ); } ) )
		{
			// P_MoveThing put the actor back, so a floor/ceiling reason is read at the refused spot.
			a->SetOrigin( x, y, z );
			FString why = MCP_BlockReason( a );
			a->SetOrigin( fromX, fromY, fromZ );
			Printf( "error %s\n", why.GetChars() );
			return;
		}
	}
	if ( hasAngle ) MCP_SetYaw( a, angle );
	if ( hasPitch ) MCP_SetPitchDeg( a, pitch );
	if ( launching )
	{
		// Set mode zeroes all three axes, so a missing one is set to its own value (added: 0).
		const fixed_t cur[3] = { a->velx, a->vely, a->velz };
		fixed_t v[3];
		for ( int i = 0; i < 3; i++ ) v[i] = hasVel[i] ? FLOAT2FIXED( vel[i] ) : addvel ? 0 : cur[i];
		P_Thing_SetVelocity( a, v[0], v[1], v[2], addvel != 0, false );
	}

	FString line = "placed ", extra;
	MCP_AppendActorKv( line, a, a->tid );
	line.AppendFormat( " fromx=%.1f fromy=%.1f fromz=%.1f vx=%.2f vy=%.2f vz=%.2f", FIXED2FLOAT( fromX ),
		FIXED2FLOAT( fromY ), FIXED2FLOAT( fromZ ), FIXED2FLOAT( a->velx ), FIXED2FLOAT( a->vely ), FIXED2FLOAT( a->velz ) );
	if ( moving && fog ) extra += " fog=1";
	if ( moving && force ) extra += " forced=1";
	MCP_AppendTail( line, a, extra );
	Printf( "%s\n", line.GetChars() );
}

// mcp_remove <tid> <index> [all=1]: Thing_Remove on the index-th actor with the tid, or on every one,
// reporting a live player body as skipped since P_RemoveThing leaves it.
CCMD( mcp_remove )
{
	static const char *const USAGE = "error usage: mcp_remove <tid> <index> [all=1]\n";
	int tid, index, all = 0;
	MCP_IntArg( argv, "all", all );
	if ( !MCP_TargetArgs( argv, tid, index ) || tid == 0 || ( all && index > 0 ) ) { Printf( "%s", USAGE ); return; }
	if ( !MCP_TargetGuards( "remove", tid ) ) return;

	// Collected first: a removal can take a later one with it (an owner its inventory), skipped below.
	TArray<AActor *> targets;
	if ( all )
	{
		FActorIterator it( tid );
		for ( AActor *a = it.Next(); a != NULL; a = it.Next() )
			if ( !MCP_IsHidden( a ) ) targets.Push( a );
		if ( targets.Size() == 0 ) { Printf( "error no actor with tid %d\n", tid ); return; }
	}
	else
	{
		AActor *a = MCP_ResolveTarget( tid, index );
		if ( a == NULL ) return;
		targets.Push( a );
	}

	int count = 0;
	FString skipped;
	for ( unsigned i = 0; i < targets.Size(); i++ )
	{
		AActor *a = targets[i];
		if ( ( a->ObjectFlags & OF_EuthanizeMe ) || MCP_IsHidden( a ) ) continue;
		if ( a->player != NULL && a == a->player->mo )
		{
			skipped.AppendFormat( "%s%s", skipped.IsEmpty() ? "" : ",", MCP_ActorRef( a ).GetChars() );
			continue;
		}
		// The head first: a destroyed actor's tid reads 0.
		FString line = "removed ";
		MCP_AppendActorKv( line, a, a->tid );
		MCP_GameCall( [&]() { P_RemoveThing( a ); } );
		// A map-reset game mode hides a map-placed actor instead (HideOrDestroyIfSafe); it keeps its tid.
		if ( MCP_IsHidden( a ) ) line += " hidden=1";
		Printf( "%s\n", line.GetChars() );
		count++;
	}
	FString total;
	total.Format( "removed_total count=%d", count );
	if ( !skipped.IsEmpty() ) total.AppendFormat( " skipped=%s", skipped.GetChars() );
	Printf( "%s\n", total.GetChars() );
}

// mcp_damage <tid> <index> <amount> [type=Name] [source=<tid>]
// P_DamageMobj with no inflictor, as Thing_Damage, replying health before and after since its return differs per engine.
CCMD( mcp_damage )
{
	static const char *const USAGE = "error usage: mcp_damage <tid> <index> <amount> [type=Name] [source=<tid>]\n";
	int tid, index, amount, srcTid = 0;
	const char *srcArg = MCP_StrArg( argv, "source" );
	if ( argv.argc() < 4 || !MCP_TargetArgs( argv, tid, index ) || !MCP_ParseInt( argv[3], amount ) || amount < 1 ||
		amount > TELEFRAG_DAMAGE || ( srcArg != NULL && ( !MCP_ParseInt( srcArg, srcTid ) || srcTid < 0 ) ) )
	{
		Printf( "%s", USAGE );
		return;
	}
	if ( !MCP_TargetGuards( "damage", tid ) ) return;
	if ( srcArg != NULL && srcTid == 0 && MCP_IsServer() ) { Printf( "error server: pass a source tid\n" ); return; }
	AActor *a = MCP_ResolveTarget( tid, index );
	if ( a == NULL ) return;
	AActor *source = ( srcArg != NULL ) ? MCP_ResolveActor( srcTid, 0, true ) : NULL;
	if ( srcArg != NULL && source == NULL ) { Printf( "error no source actor with tid %d\n", srcTid ); return; }
	if ( MCP_IsDead( a ) ) { Printf( "error already dead\n" ); return; }

	const char *typeArg = MCP_StrArg( argv, "type" );
	const FName type = ( typeArg != NULL ) ? FName( typeArg ) : FName( NAME_None );
	const int oldhp = a->health, tid0 = a->tid;
	// No DMG_FORCED: it skips the player-health mirror.
	MCP_GameCall( [&]() { P_DamageMobj( a, NULL, source, amount, type ); } );
	const int dealt = oldhp - a->health;

	FString line = "damaged ";
	MCP_AppendActorKv( line, a, tid0 );
	line.AppendFormat( " oldhp=%d dealt=%d type=%s", oldhp, dealt, type.GetChars() );
	if ( source != NULL ) line.AppendFormat( " source=%s", MCP_ActorRef( source ).GetChars() );
	if ( dealt <= 0 ) line += " nodamage=1";
	if ( a->health <= 0 ) line += " died=1";
	if ( a->ObjectFlags & OF_EuthanizeMe ) line += " removed=1";
	MCP_AppendTail( line, a, "" );
	Printf( "%s\n", line.GetChars() );
}

// p_acs.cpp's DoTakeInv, which is static there.
static void MCP_TakeInv( AActor *actor, const PClass *info, int amount )
{
	AInventory *item = actor->FindInventory( info );
	if ( item == NULL ) return;
	const int oldAmount = item->Amount;
	item->Amount -= amount;
	if ( MCP_IsServer() && actor->player != NULL && ( oldAmount > 0 || amount < 0 ) )
		SERVERCOMMANDS_TakeInventory( actor->player - players, item->GetClass(), MAX( 0, item->Amount ) );
	if ( item->Amount <= 0 )
	{
		// Ammo and internal armor stay at 0, as ACS keeps them.
		if ( item->ItemFlags & IF_KEEPDEPLETED ) item->Amount = 0;
		else item->Destroy();
	}
}

// The class a given item's amount is kept under: armor in BasicArmor, an ammo pickup in its parent ammo,
// a Health item in health itself (NULL), anything else in its own class.
static const PClass *MCP_HeldClass( const PClass *type )
{
	if ( type->IsDescendantOf( RUNTIME_CLASS( ABasicArmorPickup ) ) || type->IsDescendantOf( RUNTIME_CLASS( ABasicArmorBonus ) ) )
		return RUNTIME_CLASS( ABasicArmor );
	if ( type->IsDescendantOf( RUNTIME_CLASS( AHealth ) ) ) return NULL;
	// AAmmo::GetParentAmmo's walk, on the class.
	if ( type != RUNTIME_CLASS( AAmmo ) && type->IsDescendantOf( RUNTIME_CLASS( AAmmo ) ) )
		while ( type->ParentClass != RUNTIME_CLASS( AAmmo ) ) type = type->ParentClass;
	return type;
}

static int MCP_HeldAmount( AActor *a, const PClass *held )
{
	if ( held == NULL ) return a->health;
	AInventory *item = a->FindInventory( held );
	return ( item != NULL ) ? item->Amount : 0;
}

// mcp_inv <tid> <index> <give|take> <class> [amount]
// ACS GiveInventory/TakeInventory on one actor (amount default 1), with what it holds before and after.
CCMD( mcp_inv )
{
	static const char *const USAGE = "error usage: mcp_inv <tid> <index> <give|take> <class> [amount]\n";
	int tid, index, amount = 1;
	if ( argv.argc() < 5 || argv.argc() > 6 || !MCP_TargetArgs( argv, tid, index ) ||
		( stricmp( argv[3], "give" ) != 0 && stricmp( argv[3], "take" ) != 0 ) ||
		( argv.argc() == 6 && ( !MCP_ParseInt( argv[5], amount ) || amount < 1 ) ) )
	{
		Printf( "%s", USAGE );
		return;
	}
	const bool give = stricmp( argv[3], "give" ) == 0;
	if ( !MCP_TargetGuards( give ? "give" : "take", tid ) ) return;
	// ACS's own rename.
	const char *name = ( stricmp( argv[4], "Armor" ) == 0 ) ? ( give ? "BasicArmorPickup" : "BasicArmor" ) : argv[4];
	const PClass *type = PClass::FindClass( name );
	if ( type == NULL || type->ActorInfo == NULL || !type->IsDescendantOf( RUNTIME_CLASS( AInventory ) ) )
	{
		Printf( "error not an inventory class %s\n", argv[4] );
		return;
	}
	AActor *a = MCP_ResolveTarget( tid, index );
	if ( a == NULL ) return;
	// DoGiveInv and DoTakeInv send clients a player's inventory only.
	if ( MCP_IsServer() && a->player == NULL ) { Printf( "error not replicated: %s on a non-player\n", argv[3] ); return; }

	// A take looks up the exact class (FindInventory), so ClipBox there takes nothing from Clip.
	const PClass *held = give ? MCP_HeldClass( type ) : type;
	const int before = MCP_HeldAmount( a, held ), tid0 = a->tid;
	bool ok = true;
	if ( give ) ok = MCP_GameCall( [&]() { return DoGiveInv( a, type, amount ); } );
	else MCP_GameCall( [&]() { MCP_TakeInv( a, type, amount ); } );

	FString line;
	line.Format( "inv op=%s item=%s held=%s before=%d after=%d", give ? "give" : "take", type->TypeName.GetChars(),
		( held != NULL ) ? held->TypeName.GetChars() : "health", before, MCP_HeldAmount( a, held ) );
	if ( !ok ) line += " ok=0";
	line += ' ';
	MCP_AppendActorKv( line, a, tid0 );
	MCP_AppendTail( line, a, "" );
	Printf( "%s\n", line.GetChars() );
}

// --- map probes: mcp_pointinfo / mcp_checksight / mcp_tracemove, read-only since collision tests run on
// a throwaway probe actor and every flag they lower on real actors is put back before the CCMD returns.

// Actor flag words lowered for one CCMD, restored (newest first) on every return path.
class MCPFlagScope
{
	struct Entry { AActor *actor; DWORD AActor::*word; DWORD old; };
	TArray<Entry> saved;
public:
	void Lower( AActor *a, DWORD AActor::*word, DWORD bits )
	{
		if ( a == NULL || !( a->*word & bits ) ) return;
		Entry e = { a, word, a->*word };
		saved.Push( e );
		a->*word &= ~bits;
	}
	~MCPFlagScope()
	{
		for ( int i = int( saved.Size() ) - 1; i >= 0; i-- ) saved[i].actor->*saved[i].word = saved[i].old;
	}
};

// A probe dropped (counters cleared, destroyed) on every return path.
struct MCPProbe
{
	AActor *actor;
	MCPProbe() : actor( NULL ) {}
	~MCPProbe() { if ( actor != NULL ) MCP_DropSpawn( actor ); }
};

// "a,b[,c]" into out; the count, or -1 for anything else.
static int MCP_ParseNumList( const char *s, double *out, int max )
{
	for ( int n = 0; ; )
	{
		const char *comma = strchr( s, ',' );
		FString part = ( comma != NULL ) ? FString( s, comma - s ) : FString( s );
		if ( n == max || !MCP_ParseNum( part.GetChars(), out[n] ) ) return -1;
		n++;
		if ( comma == NULL ) return n;
		s = comma + 1;
	}
}

// An actor or a map point named by one token: tid:N[:index], player:N, class:Name (the nearest
// to the console player) or pt:x,y[,z].
struct MCPRef { AActor *actor; double x, y, z; bool hasZ; };

static bool MCP_ParseRef( const char *tok, MCPRef &out, FString &err )
{
	out.actor = NULL;
	out.x = out.y = out.z = 0;
	out.hasZ = false;
	const char *colon = strchr( tok, ':' );
	FString kind = ( colon != NULL ) ? FString( tok, colon - tok ) : FString( tok );
	const char *rest = ( colon != NULL ) ? colon + 1 : "";
	err.Format( "bad reference %s (want tid:N[:index], player:N, class:Name or pt:x,y[,z])", tok );
	if ( stricmp( kind.GetChars(), "pt" ) == 0 )
	{
		double v[3];
		int n = MCP_ParseNumList( rest, v, 3 );
		if ( n < 2 ) return false;
		for ( int i = 0; i < n; i++ )
			if ( !MCP_MapCoord( v[i] ) ) { err = MCP_COORD_RANGE; return false; }
		out.x = v[0];
		out.y = v[1];
		out.hasZ = n == 3;
		if ( out.hasZ ) out.z = v[2];
		return true;
	}
	if ( stricmp( kind.GetChars(), "tid" ) == 0 )
	{
		const char *sep = strchr( rest, ':' );
		FString tidPart = ( sep != NULL ) ? FString( rest, sep - rest ) : FString( rest );
		int tid, index = 0;
		if ( !MCP_ParseInt( tidPart.GetChars(), tid ) || tid <= 0 ) return false;
		if ( sep != NULL && ( !MCP_ParseInt( sep + 1, index ) || index < 0 ) ) return false;
		out.actor = MCP_ResolveActor( tid, index, false );
		if ( out.actor == NULL ) err.Format( "no actor with tid %d index %d", tid, index );
		return out.actor != NULL;
	}
	if ( stricmp( kind.GetChars(), "player" ) == 0 )
	{
		int n;
		if ( !MCP_ParseInt( rest, n ) || n < 0 || n >= MAXPLAYERS ) return false;
		out.actor = playeringame[n] ? players[n].mo : NULL;
		if ( out.actor == NULL ) err.Format( "no player %d", n );
		return out.actor != NULL;
	}
	if ( stricmp( kind.GetChars(), "class" ) == 0 && rest[0] != '\0' )
	{
		const PClass *type = PClass::FindClass( rest );
		if ( type == NULL ) { err.Format( "unknown class %s", rest ); return false; }
		// Without a console player (a server), the first one found.
		out.actor = MCP_NearestOfClass( MCP_ConsoleBody(), type );
		if ( out.actor == NULL ) err.Format( "no %s on the map", rest );
		return out.actor != NULL;
	}
	return false;
}

// Why no probe may be spawned here, or NULL: a client only mirrors the server, and the spawn draws
// from the spawn RNG, which a demo must replay exactly.
static const char *MCP_ProbeRefusal()
{
	if ( NETWORK_InClientMode() ) return "client: probe on the server instance";
	if ( demoplayback || demorecording ) return "demo: no probes during demo playback or recording";
	return NULL;
}

// A MapSpot (never a mod's replacement) sized like the mover, for collision tests with no side
// effects: blocked by solid actors without being solid (no TOUCHY kill), triggers and pushes nothing,
// picks nothing up, and is never in the blockmap, so nothing collides with it.
static AActor *MCP_SpawnProbe( fixed_t x, fixed_t y, fixed_t z, fixed_t radius, fixed_t height, AActor *mover )
{
	const PClass *type = PClass::FindClass( "MapSpot" );
	AActor *p = ( type != NULL ) ? MCP_GameCall( [&]() { return Spawn( type, x, y, z, NO_REPLACE ); } ) : NULL;
	if ( p == NULL ) return NULL;
	// NOSECTOR must be clear when it links, or the steep-slope test finds no touching sectors.
	p->UnlinkFromWorld();
	p->flags &= ~( MF_NOSECTOR | MF_PICKUP | MF_NOGRAVITY | MF_SOLID | MF_SHOOTABLE | MF_SPECIAL );
	p->flags |= MF_NOBLOCKMAP;
	p->flags2 |= MF2_CANNOTPUSH;
	p->flags6 |= MF6_BLOCKEDBYSOLIDACTORS | MF6_NOTRIGGER;
	p->radius = radius;
	p->height = height;
	if ( mover != NULL )
	{
		p->MaxStepHeight = mover->MaxStepHeight;
		p->MaxDropOffHeight = mover->MaxDropOffHeight;
		p->flags |= mover->flags & ( MF_DROPOFF | MF_FLOAT );
		p->flags2 |= mover->flags2 & MF2_PASSMOBJ;
		p->flags3 |= mover->flags3 & MF3_NOBLOCKMONST;
		p->flags5 |= mover->flags5 & MF5_NODROPOFF;
	}
	p->LinkToWorld();
	return p;
}

// Keeps the mover from blocking its own probe, and every BUMPSPECIAL actor in the box from running
// its special with the probe as activator (Zandronum's bump has no player/monster gate).
static void MCP_QuietArea( MCPFlagScope &scope, AActor *mover, const FBoundingBox &box )
{
	scope.Lower( mover, &AActor::flags, MF_SOLID | MF_SHOOTABLE | MF_SPECIAL );
	FBlockThingsIterator it( box );
	AActor *a;
	while ( ( a = it.Next() ) != NULL ) scope.Lower( a, &AActor::flags6, MF6_BUMPSPECIAL );
}

// PIT_CheckLine's blocking test, including the mover's player-only barriers.
static bool MCP_LineBlocks( AActor *probe, line_t *ld, bool asPlayer )
{
	if ( ld->backsector == NULL ) return true;
	if ( ld->flags & ML_RAILING ) return false;
	if ( ld->flags & ( ML_BLOCKING | ML_BLOCKEVERYTHING ) ) return true;
	bool notBlocked = ( probe->flags3 & MF3_NOBLOCKMONST ) ||
		( ( i_compatflags & COMPATF_NOBLOCKFRIENDS ) && ( probe->flags & MF_FRIENDLY ) );
	if ( !notBlocked && ( ld->flags & ML_BLOCKMONSTERS ) ) return true;
	if ( asPlayer && ( ld->flags & ML_BLOCK_PLAYERS ) ) return true;
	return ( probe->flags & MF_FLOAT ) && ( ld->flags & ML_BLOCK_FLOATERS );
}

static line_t *MCP_BlockingLine( AActor *probe, fixed_t x, fixed_t y, bool asPlayer )
{
	FBoundingBox box( x, y, probe->radius );
	FBlockLinesIterator it( box );
	line_t *ld;
	while ( ( ld = it.Next() ) != NULL )
	{
		if ( box.Right() <= ld->bbox[BOXLEFT] || box.Left() >= ld->bbox[BOXRIGHT] ||
			box.Top() <= ld->bbox[BOXBOTTOM] || box.Bottom() >= ld->bbox[BOXTOP] ) continue;
		if ( box.BoxOnLineSide( ld ) == -1 && MCP_LineBlocks( probe, ld, asPlayer ) ) return ld;
	}
	return NULL;
}

struct MCPBlock { const char *reason; FString extra; };

// Re-derive the block rather than using BlockingLine, which can just lower the opening.
static MCPBlock MCP_ProbeReason( AActor *probe, const FCheckPosition &tm, fixed_t x, fixed_t y, bool asPlayer )
{
	MCPBlock b;
	if ( probe->BlockingMobj != NULL )
	{
		b.reason = "actor";
		b.extra.Format( " blocker=%s", MCP_ActorRef( probe->BlockingMobj ).GetChars() );
		return b;
	}
	line_t *ld = MCP_BlockingLine( probe, x, y, asPlayer );
	if ( ld != NULL )
	{
		b.reason = "line";
		b.extra.Format( " line=%d", int( ld - lines ) );
		return b;
	}
	b.reason = ( tm.ceilingz - tm.floorz < probe->height ) ? "ceiling" : "slope";
	return b;
}

// Whether x,y (and z, with checkZ) is inside the map, as UZDoom's IsPointInMap, or -1 (unknown)
// without GL nodes since the test needs closed GL subsectors.
static int MCP_PointInMap( fixed_t x, fixed_t y, fixed_t z, bool checkZ )
{
	if ( !hasglnodes ) return -1;
	subsector_t *ss = R_PointInSubsector( x, y );
	for ( DWORD i = 0; i < ss->numlines; i++ )
	{
		seg_t *seg = ss->firstline + i;
		if ( seg->backsector != NULL || seg->linedef == NULL ) continue;
		divline_t dl;
		P_MakeDivline( seg->linedef, &dl );
		if ( P_PointOnDivlineSide( x, y, &dl ) >= 1 ) return 0;
	}
	if ( checkZ && ( z > ss->sector->ceilingplane.ZatPoint( x, y ) || z < ss->sector->floorplane.ZatPoint( x, y ) ) )
		return 0;
	return 1;
}

static const char *MCP_TexName( FTextureID id )
{
	FTexture *tex = TexMan[id];
	return ( tex != NULL ) ? tex->Name : "-";
}

// The radius/height a probe takes, explicit values over the mover's, or false if either is unknown.
static bool MCP_ProbeSize( FCommandLine &argv, AActor *mover, fixed_t &radius, fixed_t &height )
{
	double r, h;
	bool hasR = MCP_NumArg( argv, "radius", r ), hasH = MCP_NumArg( argv, "height", h );
	if ( ( !hasR || !hasH ) && mover == NULL ) return false;
	radius = hasR ? FLOAT2FIXED( r ) : mover->radius;
	height = hasH ? FLOAT2FIXED( h ) : mover->height;
	return radius > 0 && height > 0;
}

// The mover= actor, else NULL; false (err set) for a bad reference or a point.
static bool MCP_MoverArg( FCommandLine &argv, AActor *&mover, FString &err )
{
	const char *tok = MCP_StrArg( argv, "mover" );
	mover = NULL;
	if ( tok == NULL ) return true;
	MCPRef ref;
	if ( !MCP_ParseRef( tok, ref, err ) ) return false;
	if ( ref.actor == NULL ) { err = "mover wants an actor, not a point"; return false; }
	mover = ref.actor;
	return true;
}

// mcp_pointinfo <x> <y> [z=N] [radius=N height=N] [mover=<ref>]
// Sector data at a point; with a size (radius and height, or a mover) also whether it fits there.
CCMD( mcp_pointinfo )
{
	Printf( "MCP_POINT\n" );
	double xd, yd, zd = 0;
	if ( argv.argc() < 3 || !MCP_ParseNum( argv[1], xd ) || !MCP_ParseNum( argv[2], yd ) )
	{
		Printf( "error usage: mcp_pointinfo <x> <y> [z=N] [radius=N height=N] [mover=<ref>]\n" );
		return;
	}
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	bool hasZ = MCP_NumArg( argv, "z", zd );
	if ( !MCP_MapCoord( xd ) || !MCP_MapCoord( yd ) || ( hasZ && !MCP_MapCoord( zd ) ) ) { Printf( "error %s\n", MCP_COORD_RANGE ); return; }
	AActor *mover;
	FString err;
	if ( !MCP_MoverArg( argv, mover, err ) ) { Printf( "error %s\n", err.GetChars() ); return; }
	fixed_t radius = 0, height = 0;
	bool wantFit = MCP_StrArg( argv, "radius" ) != NULL || MCP_StrArg( argv, "height" ) != NULL || mover != NULL;
	if ( wantFit && !MCP_ProbeSize( argv, mover, radius, height ) )
	{
		Printf( "error a fit needs radius and height above 0, or mover=\n" );
		return;
	}
	const char *refusal = wantFit ? MCP_ProbeRefusal() : NULL;
	if ( refusal != NULL ) { Printf( "error %s\n", refusal ); return; }

	fixed_t x = FLOAT2FIXED( xd ), y = FLOAT2FIXED( yd );
	sector_t *sec = P_PointInSector( x, y );
	fixed_t floorz = sec->floorplane.ZatPoint( x, y ), ceilz = sec->ceilingplane.ZatPoint( x, y );
	fixed_t z = hasZ ? FLOAT2FIXED( zd ) : floorz;

	// The surfaces around z, 3D floors included, as CheckActorFloorTexture/CeilingTexture walk them.
	fixed_t floor3d = floorz, ceil3d = ceilz;
	FTextureID floorTex = sec->GetTexture( sector_t::floor ), ceilTex = sec->GetTexture( sector_t::ceiling );
	TDeletingArray<F3DFloor *> &ffs = sec->e->XFloor.ffloors;
	for ( unsigned i = 0; i < ffs.Size(); i++ )
	{
		F3DFloor *ff = ffs[i];
		if ( ( ff->flags & ( FF_EXISTS | FF_SOLID ) ) != ( FF_EXISTS | FF_SOLID ) ) continue;
		if ( z >= ff->top.plane->ZatPoint( x, y ) ) { floor3d = ff->top.plane->ZatPoint( x, y ); floorTex = *ff->top.texture; break; }
	}
	for ( int i = int( ffs.Size() ) - 1; i >= 0; i-- )
	{
		F3DFloor *ff = ffs[i];
		if ( ( ff->flags & ( FF_EXISTS | FF_SOLID ) ) != ( FF_EXISTS | FF_SOLID ) ) continue;
		if ( z <= ff->bottom.plane->ZatPoint( x, y ) ) { ceil3d = ff->bottom.plane->ZatPoint( x, y ); ceilTex = *ff->bottom.texture; break; }
	}

	FString line;
	line.Format( "point sector=%d", int( sec - sectors ) );
	int inMap = MCP_PointInMap( x, y, z, true );
	if ( inMap >= 0 ) line.AppendFormat( " inmap=%d", inMap );
	line.AppendFormat( " floorz=%.1f ceilingz=%.1f", FIXED2FLOAT( floorz ), FIXED2FLOAT( ceilz ) );
	if ( floor3d != floorz ) line.AppendFormat( " floor3d=%.1f", FIXED2FLOAT( floor3d ) );
	if ( ceil3d != ceilz ) line.AppendFormat( " ceiling3d=%.1f", FIXED2FLOAT( ceil3d ) );
	line.AppendFormat( " light=%d special=%d tag=%d", sec->lightlevel, sec->special, MCP_SECTOR_TAG( sec ) );
	Printf( "%s\nfloortex name=%s\nceiltex name=%s\n", line.GetChars(), MCP_TexName( floorTex ), MCP_TexName( ceilTex ) );
	if ( !wantFit ) return;

	MCPFlagScope scope;
	MCP_QuietArea( scope, mover, FBoundingBox( x, y, radius ) );
	MCPProbe probe;
	probe.actor = MCP_SpawnProbe( x, y, z, radius, height, mover );
	if ( probe.actor == NULL ) { Printf( "error probe spawn failed\n" ); return; }
	FCheckPosition tm;
	bool asPlayer = mover != NULL && mover->player != NULL;
	line_t *blocked = NULL;
	if ( !MCP_GameCall( [&]() { return P_CheckPosition( probe.actor, x, y, tm ); } ) )
	{
		MCPBlock b = MCP_ProbeReason( probe.actor, tm, x, y, asPlayer );
		Printf( "fit ok=0 reason=%s%s\n", b.reason, b.extra.GetChars() );
	}
	else if ( asPlayer && ( blocked = MCP_BlockingLine( probe.actor, x, y, true ) ) != NULL )
		Printf( "fit ok=0 reason=line line=%d\n", int( blocked - lines ) );
	// A given z must also sit inside the opening P_CheckPosition found.
	else if ( hasZ && z < tm.floorz ) Printf( "fit ok=0 reason=floor\n" );
	else if ( hasZ && z + height > tm.ceilingz ) Printf( "fit ok=0 reason=ceiling\n" );
	else Printf( "fit ok=1\n" );
}

// The line that stops a straight trace from a's eye to b's middle, as a hint for why sight failed;
// -1 when the trace is clear (P_CheckSight's slope window can still fail it).
static int MCP_SightBlockLine( AActor *a, AActor *b, bool pastBlocking )
{
	fixed_t eye = a->z + a->height - ( a->height >> 2 );
	double dx = FIXED2FLOAT( b->x ) - FIXED2FLOAT( a->x ), dy = FIXED2FLOAT( b->y ) - FIXED2FLOAT( a->y );
	double dz = FIXED2FLOAT( b->z + b->height / 2 - eye );
	double len = sqrt( dx * dx + dy * dy + dz * dz );
	if ( len <= 0 ) return -1;
	FTraceResults res;
	DWORD mask = ML_BLOCKSIGHT | ( pastBlocking ? 0 : ML_BLOCKEVERYTHING );
	if ( !Trace( a->x, a->y, eye, a->Sector, FLOAT2FIXED( dx / len ), FLOAT2FIXED( dy / len ), FLOAT2FIXED( dz / len ),
		FLOAT2FIXED( len ), 0, mask, a, res ) ) return -1;
	return ( res.HitType == TRACE_HitWall && res.Line != NULL ) ? int( res.Line - lines ) : -1;
}

// mcp_checksight from=<ref> to=<ref> [flags=N]: ACS CheckSight's line of sight, where a point is a
// 1-unit-high probe at its z or the floor, so its eye is 0.75 above that.
CCMD( mcp_checksight )
{
	Printf( "MCP_SIGHT\n" );
	const char *tok[2] = { MCP_StrArg( argv, "from" ), MCP_StrArg( argv, "to" ) };
	if ( tok[0] == NULL || tok[1] == NULL )
	{
		Printf( "error usage: mcp_checksight from=<ref> to=<ref> [flags=N]\n" );
		return;
	}
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	int flags = 0;
	MCP_IntArg( argv, "flags", flags );
	MCPRef ref[2];
	FString err;
	for ( int i = 0; i < 2; i++ )
		if ( !MCP_ParseRef( tok[i], ref[i], err ) ) { Printf( "error %s\n", err.GetChars() ); return; }
	const char *refusal = ( ref[0].actor == NULL || ref[1].actor == NULL ) ? MCP_ProbeRefusal() : NULL;
	if ( refusal != NULL ) { Printf( "error %s\n", refusal ); return; }

	MCPProbe probe[2];
	AActor *end[2];
	FString name[2];
	for ( int i = 0; i < 2; i++ )
	{
		end[i] = ref[i].actor;
		if ( end[i] != NULL ) { name[i] = MCP_ActorRef( end[i] ); continue; }
		fixed_t x = FLOAT2FIXED( ref[i].x ), y = FLOAT2FIXED( ref[i].y );
		fixed_t z = ref[i].hasZ ? FLOAT2FIXED( ref[i].z ) : P_PointInSector( x, y )->floorplane.ZatPoint( x, y );
		end[i] = probe[i].actor = MCP_SpawnProbe( x, y, z, FRACUNIT, FRACUNIT, NULL );
		if ( end[i] == NULL ) { Printf( "error probe spawn failed\n" ); return; }
		name[i] = tok[i];
	}
	bool visible = P_CheckSight( end[0], end[1], SF_IGNOREVISIBILITY | flags );
	FString line;
	line.Format( "sight visible=%d from=%s to=%s", visible ? 1 : 0, name[0].GetChars(), name[1].GetChars() );
	int blockLine = visible ? -1 : MCP_SightBlockLine( end[0], end[1], ( flags & SF_SEEPASTBLOCKEVERYTHING ) != 0 );
	if ( blockLine >= 0 ) line.AppendFormat( " line=%d", blockLine );
	Printf( "%s\n", line.GetChars() );
}

// mcp_tracemove <x> <y> [from=x,y] [mover=<ref>] [radius=N] [height=N] [actors=0]
// Whether the mover walks straight to x,y, stepping a probe at most radius-1 at a time as P_XYMovement does.
CCMD( mcp_tracemove )
{
	static const char *const USAGE = "error usage: mcp_tracemove <x> <y> [from=x,y] [mover=<ref>] [radius=N] "
		"[height=N] [actors=0]\n";
	Printf( "MCP_TRACE\n" );
	double tx, ty;
	if ( argv.argc() < 3 || !MCP_ParseNum( argv[1], tx ) || !MCP_ParseNum( argv[2], ty ) ) { Printf( "%s", USAGE ); return; }
	if ( !MCP_MapCoord( tx ) || !MCP_MapCoord( ty ) ) { Printf( "error %s\n", MCP_COORD_RANGE ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	const char *refusal = MCP_ProbeRefusal();
	if ( refusal != NULL ) { Printf( "error %s\n", refusal ); return; }

	AActor *mover;
	FString err;
	if ( !MCP_MoverArg( argv, mover, err ) ) { Printf( "error %s\n", err.GetChars() ); return; }
	if ( mover == NULL )
	{
		AActor *me = MCP_ConsoleBody();
		if ( me != NULL && !players[consoleplayer].bSpectating ) mover = me;
	}
	fixed_t radius, height;
	if ( !MCP_ProbeSize( argv, mover, radius, height ) )
	{
		Printf( "error no mover: pass radius/height or mover=\n" );
		return;
	}
	double start[2];
	const char *fromArg = MCP_StrArg( argv, "from" );
	if ( fromArg != NULL && MCP_ParseNumList( fromArg, start, 2 ) != 2 ) { Printf( "%s", USAGE ); return; }
	if ( fromArg != NULL && ( !MCP_MapCoord( start[0] ) || !MCP_MapCoord( start[1] ) ) ) { Printf( "error %s\n", MCP_COORD_RANGE ); return; }
	if ( fromArg == NULL && mover == NULL ) { Printf( "error from= needed without a mover\n" ); return; }
	int actors = 1;
	MCP_IntArg( argv, "actors", actors );

	fixed_t sx = fromArg ? FLOAT2FIXED( start[0] ) : mover->x, sy = fromArg ? FLOAT2FIXED( start[1] ) : mover->y;
	fixed_t ex = FLOAT2FIXED( tx ), ey = FLOAT2FIXED( ty );
	fixed_t sz = fromArg ? P_PointInSector( sx, sy )->floorplane.ZatPoint( sx, sy ) : mover->z;

	MCPFlagScope scope;
	MCP_QuietArea( scope, mover, FBoundingBox( MIN( sx, ex ) - radius, MIN( sy, ey ) - radius,
		MAX( sx, ex ) + radius, MAX( sy, ey ) + radius ) );
	MCPProbe probe;
	AActor *p = probe.actor = MCP_SpawnProbe( sx, sy, sz, radius, height, mover );
	if ( p == NULL ) { Printf( "error probe spawn failed\n" ); return; }
	if ( !actors ) p->flags2 |= MF2_THRUACTORS;

	// P_TryMove's dropoff rule: a player moves by momentum (dropoff allowed), a monster walks.
	bool asPlayer = mover != NULL && mover->player != NULL;
	bool momentum = asPlayer && !( i_compatflags & COMPATF_CROSSDROPOFF );
	bool checkDrop = ( !momentum && !( p->flags & ( MF_DROPOFF | MF_FLOAT ) ) ) || ( p->flags5 & MF5_NODROPOFF );

	// Doubles: a fixed_t difference overflows past 32767 units.
	const double sxf = FIXED2FLOAT( sx ), syf = FIXED2FLOAT( sy ), dx = tx - sxf, dy = ty - syf;
	const double total = sqrt( dx * dx + dy * dy );
	const int steps = MAX( 1, int( ceil( total / MAX( FIXED2FLOAT( radius ) - 1.0, 1.0 ) ) ) );
	MCPBlock b;
	b.reason = NULL;
	FCheckPosition tm;
	// i = 0 is the start, which must fit too; from= puts the probe on the floor there.
	for ( int i = 0; i <= steps; i++ )
	{
		fixed_t nx = FLOAT2FIXED( sxf + dx * i / steps ), ny = FLOAT2FIXED( syf + dy * i / steps );
		if ( MCP_PointInMap( nx, ny, 0, false ) == 0 ) { b.reason = "outside"; break; }
		if ( !MCP_GameCall( [&]() { return P_CheckPosition( p, nx, ny, tm ); } ) ) { b = MCP_ProbeReason( p, tm, nx, ny, asPlayer ); break; }
		line_t *blocked = asPlayer ? MCP_BlockingLine( p, nx, ny, true ) : NULL;
		if ( blocked != NULL )
		{
			b.reason = "line";
			b.extra.Format( " line=%d", int( blocked - lines ) );
			break;
		}
		if ( i == 0 )
		{
			if ( fromArg != NULL ) p->SetOrigin( nx, ny, tm.floorz );
			continue;
		}
		// P_TryMove's walker and FLY+NOGRAVITY ceiling rules agree for an actor at p->z.
		if ( tm.ceilingz - p->z < p->height ) { b.reason = "ceiling"; break; }
		if ( tm.floorz - p->z > p->MaxStepHeight )
		{
			b.reason = "step";
			b.extra.Format( " rise=%.1f", FIXED2FLOAT( tm.floorz - p->z ) );
			break;
		}
		if ( checkDrop && tm.floorz - tm.dropoffz > p->MaxDropOffHeight )
		{
			b.reason = "dropoff";
			b.extra.Format( " drop=%.1f", FIXED2FLOAT( tm.floorz - tm.dropoffz ) );
			break;
		}
		p->SetOrigin( nx, ny, tm.floorz );
	}

	const double px = FIXED2FLOAT( p->x ) - sxf, py = FIXED2FLOAT( p->y ) - syf;
	const double dist = sqrt( px * px + py * py );
	FString line;
	line.Format( "trace ok=%d", b.reason == NULL ? 1 : 0 );
	if ( b.reason != NULL ) line.AppendFormat( " reason=%s", b.reason );
	line.AppendFormat( " x=%.1f y=%.1f z=%.1f dist=%.1f total=%.1f%s", FIXED2FLOAT( p->x ), FIXED2FLOAT( p->y ),
		FIXED2FLOAT( p->z ), dist, total, b.extra.GetChars() );
	Printf( "%s\n", line.GetChars() );
}

// --- mcp_rec: the per-tic recorder, which prints nothing while armed (rows go to a dump file), or
// the host would take a row for the reply of whatever command is pending.

static const int MCP_REC_MAX_WATCHES = 8;
static const int MCP_REC_MAX_TRACKED = 512;
static const unsigned MCP_REC_MAX_ROWS = 20000;
static const int MCP_REC_MAX_TICS = 10500;
static const unsigned MCP_REC_MAX_SCRIPTS = 32;
static const unsigned MCP_REC_MAX_VARS = 32;

bool MCP_RecArmed = false;

// A watch's selectors, AND-ed: no class, tid 0 and player -1 each mean "any".
struct MCPRecWatch { const PClass *type; int tid; int player; };
// A matched actor: its id (0 past the tracked cap), the walk that last saw it, its last sample.
struct MCPRecActor { int id; unsigned gen; FString last; };

enum { MCP_REC_SPAWN = 1, MCP_REC_DESTROY = 2, MCP_REC_STATE = 4, MCP_REC_DAMAGE = 8, MCP_REC_DEATH = 16, MCP_REC_PSPRITE = 32 };
static const struct { const char *name; int bit; } MCP_REC_EVENTS[] = {
	{ "spawn", MCP_REC_SPAWN }, { "destroy", MCP_REC_DESTROY }, { "state", MCP_REC_STATE },
	{ "damage", MCP_REC_DAMAGE }, { "death", MCP_REC_DEATH }, { "psprite", MCP_REC_PSPRITE },
};
static const int MCP_REC_DEFAULT_EVENTS = MCP_REC_SPAWN | MCP_REC_DESTROY | MCP_REC_DAMAGE | MCP_REC_DEATH;
static const char *const MCP_REC_DEFAULT_FIELDS = "tid,hp,x,y,z,sprite,frame";
// A state row's fields, after id=.
static const char *const MCP_REC_STATE_FIELDS[] = { "state", "label", "sprite", "frame", "tics" };

// Which watches a match tries: class-only ones match at spawn, tid and player ones at each tic end.
enum { MCP_REC_CLASS_WATCHES = 1, MCP_REC_RESOLVED_WATCHES = 2, MCP_REC_ALL_WATCHES = 3 };

// The setup, kept until clear, which go refuses once a failed line has marked it bad.
static MCPRecWatch g_recWatches[MCP_REC_MAX_WATCHES];
static int g_recNWatches = 0;
static TArray<int> g_recFields; // MCP_FIELDS indices, in the order asked
static bool g_recFieldsSet = false;
static int g_recEvents = MCP_REC_DEFAULT_EVENTS;
static bool g_recScripts = false, g_recAllScripts = false;
static TArray<int> g_recScriptNums; // a named script as minus its FName, as ACS numbers it
static bool g_recBad = false;
struct MCPRecVar { MCPAcsRef ref; FString label; int last; };
static TArray<MCPRecVar> g_recVars;

// One recording: go starts it afresh, clear empties it.
static bool g_recRun = false, g_recChanges = true;
static int g_recTics = 0, g_recRan = 0, g_recEvery = 1, g_recStart = 0, g_recLast = 0;
static int g_recNextId = 0, g_recNextSerial = 0, g_recLive = 0, g_recDropped = 0, g_recUntracked = 0;
static unsigned g_recGen = 0;
static const char *g_recReason = "-";
static FString g_recMap;
static TArray<FString> g_recRows;
// Stored actor and script pointers are only ever map keys.
static std::unordered_map<const AActor *, MCPRecActor> g_recIds;
static std::unordered_map<const void *, int> g_recSerials;
struct MCPRecPsprite { const void *object; const FState *state; };
static std::unordered_map<long long, MCPRecPsprite> g_recPsprites;

// Whether the game is still on the level the recording was armed on, as mcp_input checks it.
static bool MCP_RecSameLevel()
{
	return gamestate == GS_LEVEL && level.maptime >= g_recLast && g_recMap.CompareNoCase( level.mapname ) == 0;
}

static void MCP_RecDisarm( const char *reason )
{
	MCP_RecArmed = false;
	g_recReason = reason;
	g_recIds.clear();
	g_recSerials.clear();
	g_recPsprites.clear();
	g_recLive = 0;
	// Run mode owns the pause, as step does: it ends paused however it ends, except around a demo.
	if ( g_recRun && gamestate == GS_LEVEL && !demorecording && !demoplayback ) MCP_Clock_SetPause( 1 );
}

void MCP_Rec_ResetImpl() { MCP_RecDisarm( "map_reset" ); }

// The one row writer: a level change disarms here first, so nothing from the next map is recorded.
static bool MCP_RecWrite( const char *kind, const FString &body )
{
	if ( !MCP_RecSameLevel() )
	{
		MCP_RecDisarm( "level_change" );
		return false;
	}
	if ( g_recRows.Size() >= MCP_REC_MAX_ROWS )
	{
		g_recDropped++;
		return true;
	}
	FString row;
	row.Format( "rec t=%d k=%s %s", level.maptime, kind, body.GetChars() );
	g_recRows.Push( row );
	return true;
}

static void MCP_RecReadVars( bool baseline )
{
	for ( unsigned i = 0; MCP_RecArmed && i < g_recVars.Size(); i++ )
	{
		if ( !MCP_RecSameLevel() ) { MCP_RecDisarm( "level_change" ); return; }
		MCPRecVar &v = g_recVars[i];
		int value;
		if ( !MCP_AcsRefRead( v.ref, value ) ) { MCP_RecDisarm( "level_change" ); return; }
		if ( !baseline && value == v.last ) continue;
		FString body;
		body.Format( "var=%u value=%d", i + 1, value );
		if ( !baseline ) body.AppendFormat( " prev=%d", v.last );
		body.AppendFormat( " name=%s", v.label.GetChars() );
		v.last = value;
		MCP_RecWrite( "var", body );
	}
}

static MCPRecActor *MCP_RecFind( const AActor *a )
{
	auto it = g_recIds.find( a );
	return it != g_recIds.end() ? &it->second : NULL;
}

static int MCP_RecIdOf( const AActor *a )
{
	const MCPRecActor *r = ( a != NULL ) ? MCP_RecFind( a ) : NULL;
	return ( r != NULL ) ? r->id : 0;
}

static long long MCP_RecPspriteKey( int id, int layer ) { return ( (long long)id << 32 ) | (unsigned int)layer; }

static void MCP_RecPsprite( int id, int layer, const MCPPspriteView &p )
{
	MCPRecPsprite &last = g_recPsprites[MCP_RecPspriteKey( id, layer )];
	const bool changed = p.state != NULL ? last.state != p.state || last.object != p.object : last.state != NULL;
	last = { p.object, p.state };
	if ( !changed ) return;
	FString body;
	body.Format( "id=%d layer=%d", id, layer );
	if ( p.state == NULL ) body += " wstate=none";
	else for ( const char *f : { "wstate", "wlabel", "wsprite", "wframe", "wtics" } )
	{
		FString v;
		if ( MCP_PspriteField( v, p, f ) ) body.AppendFormat( " %s=%s", f, v.GetChars() );
	}
	MCP_RecWrite( "psprite", body );
}

void MCP_Rec_PspriteSetImpl( AActor *body, const void *, int layer )
{
	if ( !( g_recEvents & MCP_REC_PSPRITE ) ) return;
	const int id = MCP_RecIdOf( body );
	if ( id <= 0 || body->player == NULL || body->player->mo != body || layer < 0 || layer >= NUMPSPRITES ) return;
	MCP_RecPsprite( id, MCP_PSP_LAYERS[layer], MCP_PspriteView( body->player->psprites[layer] ) );
}

void MCP_Rec_PspriteClearImpl( AActor *body, int layer )
{
	if ( !( g_recEvents & MCP_REC_PSPRITE ) ) return;
	const int id = MCP_RecIdOf( body );
	if ( id <= 0 || body->player == NULL || body->player->mo != body || layer < 0 || layer >= NUMPSPRITES ) return;
	MCP_RecPsprite( id, MCP_PSP_LAYERS[layer], { NULL, NULL, 0, 0, 0 } );
}

static void MCP_RecReconcilePsprites( AActor *a, int id )
{
	if ( !( g_recEvents & MCP_REC_PSPRITE ) || a->player == NULL || a->player->mo != a ) return;
	for ( int i = 0; MCP_RecArmed && i < NUMPSPRITES; i++ )
	{
		auto it = g_recPsprites.find( MCP_RecPspriteKey( id, MCP_PSP_LAYERS[i] ) );
		if ( it != g_recPsprites.end() && it->second.state != NULL && a->player->psprites[i].state == NULL )
			MCP_RecPsprite( id, MCP_PSP_LAYERS[i], { NULL, NULL, 0, 0, 0 } );
	}
}

// Forgets a's entry; its id, 0 when it had none.
static int MCP_RecErase( const AActor *a )
{
	auto it = g_recIds.find( a );
	if ( it == g_recIds.end() ) return 0;
	const int id = it->second.id;
	if ( id > 0 ) g_recLive--;
	g_recIds.erase( it );
	return id;
}

// Gives an unknown a an id and writes its first row (k=spawn or seen), counting it untracked past
// the cap; NULL when the write disarmed.
static MCPRecActor *MCP_RecTrack( AActor *a, const char *kind )
{
	MCPRecActor &r = g_recIds[a];
	r.gen = g_recGen;
	r.last = "";
	if ( g_recLive >= MCP_REC_MAX_TRACKED )
	{
		r.id = 0;
		g_recUntracked++;
		return &r;
	}
	r.id = ++g_recNextId;
	g_recLive++;
	if ( ( g_recEvents & MCP_REC_PSPRITE ) && a->player != NULL && a->player->mo == a )
		for ( int i = 0; i < NUMPSPRITES; i++ )
			g_recPsprites[MCP_RecPspriteKey( r.id, MCP_PSP_LAYERS[i] )] = { NULL, a->player->psprites[i].state };
	FString body;
	body.Format( "id=%d class=%s tid=%d x=%.1f y=%.1f z=%.1f", r.id, a->GetClass()->TypeName.GetChars(), a->tid,
		FIXED2FLOAT( a->x ), FIXED2FLOAT( a->y ), FIXED2FLOAT( a->z ) );
	return ( MCP_RecWrite( kind, body ) && MCP_RecArmed ) ? &r : NULL;
}

static bool MCP_RecMatches( const MCPRecWatch &w, AActor *a )
{
	if ( w.type != NULL && !a->IsKindOf( w.type ) ) return false;
	if ( w.tid != 0 && a->tid != w.tid ) return false;
	return w.player < 0 || ( playeringame[w.player] && players[w.player].mo == a );
}

// Whether a matches one of the watches in `which`; a map-reset hidden actor never does.
static bool MCP_RecWatched( AActor *a, int which )
{
	if ( MCP_IsHidden( a ) ) return false;
	for ( int i = 0; i < g_recNWatches; i++ )
	{
		const MCPRecWatch &w = g_recWatches[i];
		const int kind = ( w.tid == 0 && w.player < 0 ) ? MCP_REC_CLASS_WATCHES : MCP_REC_RESOLVED_WATCHES;
		if ( ( which & kind ) && MCP_RecMatches( w, a ) ) return true;
	}
	return false;
}

// A sample of the asked fields, skipped with changes=1 when it equals the actor's last one.
static void MCP_RecSample( AActor *a, MCPRecActor &r )
{
	const MCPFieldCtx c = { MCP_ConsoleBody(), a->tid, -1 };
	FString body;
	body.Format( "id=%d", r.id );
	for ( unsigned i = 0; i < g_recFields.Size(); i++ ) MCP_AppendField( body, MCP_FIELDS[g_recFields[i]], a, c );
	// Compare, not ==: this FString has no operator==, so == would compare the two char pointers.
	if ( g_recChanges && body.Compare( r.last ) == 0 ) return;
	r.last = body;
	MCP_RecWrite( "sample", body );
}

// Walks every live actor: adopts new matches of the watches in `which` (a seen row), samples the
// tracked ones when `sample`, and forgets entries it didn't visit, so no freed address keeps an id.
static void MCP_RecWalk( bool sample, int which )
{
	g_recGen++;
	TThinkerIterator<AActor> it;
	AActor *a;
	while ( MCP_RecArmed && ( a = it.Next() ) != NULL )
	{
		MCPRecActor *r = MCP_RecFind( a );
		if ( r == NULL )
		{
			if ( !MCP_RecWatched( a, which ) ) continue;
			if ( ( r = MCP_RecTrack( a, "seen" ) ) == NULL ) return;
		}
		r->gen = g_recGen;
		if ( r->id > 0 ) MCP_RecReconcilePsprites( a, r->id );
		if ( !MCP_RecArmed ) return;
		// Owned inventory is tracked for its events, but rides its owner: no samples.
		if ( sample && r->id > 0 && !MCP_IsOwnedItem( a ) ) MCP_RecSample( a, *r );
	}
	if ( !MCP_RecArmed ) return;
	for ( auto i = g_recIds.begin(); i != g_recIds.end(); )
	{
		if ( i->second.gen == g_recGen ) { ++i; continue; }
		if ( i->second.id > 0 ) g_recLive--;
		i = g_recIds.erase( i );
	}
}

// Runs right after P_Ticker's maptime++, so once per simulated tic, after everything in it.
void MCP_Rec_TickImpl()
{
	// Exactly one tic since the last one: anything else is a load or a new map.
	if ( level.maptime != g_recLast + 1 || gamestate != GS_LEVEL || g_recMap.CompareNoCase( level.mapname ) != 0 )
	{
		MCP_RecDisarm( "level_change" );
		return;
	}
	g_recLast = level.maptime;
	g_recRan++;
	MCP_RecWalk( g_recRan % g_recEvery == 0, MCP_REC_RESOLVED_WATCHES );
	MCP_RecReadVars( false );
	// Pausing here (run mode) stops the very next tic, so exactly the tics asked ran.
	if ( MCP_RecArmed && g_recRan >= g_recTics ) MCP_RecDisarm( "done" );
}

void MCP_Rec_SpawnImpl( AActor *actor )
{
	// Before any guard, so a reused address never inherits an old id.
	MCP_RecErase( actor );
	if ( MCP_RecWatched( actor, MCP_REC_CLASS_WATCHES ) )
		MCP_RecTrack( actor, ( g_recEvents & MCP_REC_SPAWN ) ? "spawn" : "seen" );
}

void MCP_Rec_DestroyImpl( AActor *actor )
{
	// Before any guard, which also makes a second Destroy a no-op.
	const int id = MCP_RecErase( actor );
	if ( id <= 0 || !( g_recEvents & MCP_REC_DESTROY ) ) return;
	FString body;
	body.Format( "id=%d x=%.1f y=%.1f z=%.1f", id, FIXED2FLOAT( actor->x ), FIXED2FLOAT( actor->y ), FIXED2FLOAT( actor->z ) );
	MCP_RecWrite( "destroy", body );
}

static int MCP_FieldIndex( const char *name )
{
	for ( size_t i = 0; i < countof( MCP_FIELDS ); i++ )
		if ( MCP_FIELDS[i].kind != 't' && stricmp( MCP_FIELDS[i].name, name ) == 0 ) return int( i );
	return -1;
}

void MCP_Rec_StateImpl( AActor *actor )
{
	// The bit first: every SetState of every actor lands here while armed.
	if ( !( g_recEvents & MCP_REC_STATE ) ) return;
	const int id = MCP_RecIdOf( actor );
	if ( id <= 0 ) return;
	static int fields[countof( MCP_REC_STATE_FIELDS )] = { -1 };
	if ( fields[0] < 0 )
		for ( size_t i = 0; i < countof( MCP_REC_STATE_FIELDS ); i++ ) fields[i] = MCP_FieldIndex( MCP_REC_STATE_FIELDS[i] );
	const MCPFieldCtx c = { NULL, actor->tid, -1 };
	FString body;
	body.Format( "id=%d", id );
	for ( int f : fields ) MCP_AppendField( body, MCP_FIELDS[f], actor, c );
	MCP_RecWrite( "state", body );
}

// src= and inf= as actor refs, each with srcid=/infid= when tracked; left out when NULL.
static void MCP_RecAppendCause( FString &body, AActor *source, AActor *inflictor )
{
	const struct { const char *key; AActor *a; } causes[] = { { "src", source }, { "inf", inflictor } };
	for ( const auto &cause : causes )
	{
		if ( cause.a == NULL ) continue;
		body.AppendFormat( " %s=%s", cause.key, MCP_ActorRef( cause.a ).GetChars() );
		const int id = MCP_RecIdOf( cause.a );
		if ( id > 0 ) body.AppendFormat( " %sid=%d", cause.key, id );
	}
}

// After both health subtractions, so hp= is the target's health after the hit.
void MCP_Rec_DamageImpl( AActor *target, AActor *inflictor, AActor *source, int damage, const FName &mod )
{
	if ( target == NULL || !( g_recEvents & MCP_REC_DAMAGE ) ) return;
	const int id = MCP_RecIdOf( target );
	if ( id <= 0 && MCP_RecIdOf( source ) <= 0 && MCP_RecIdOf( inflictor ) <= 0 ) return;
	FString body;
	body.Format( "id=%d", id );
	if ( id <= 0 ) body.AppendFormat( " tgt=%s", MCP_ActorRef( target ).GetChars() );
	body.AppendFormat( " amount=%d type=%s", damage, mod.GetChars() );
	MCP_RecAppendCause( body, source, inflictor );
	body.AppendFormat( " hp=%d", target->health );
	MCP_RecWrite( "damage", body );
}

void MCP_Rec_DeathImpl( AActor *actor, AActor *source, AActor *inflictor )
{
	const int id = MCP_RecIdOf( actor );
	if ( id <= 0 || !( g_recEvents & MCP_REC_DEATH ) ) return;
	FString body;
	body.Format( "id=%d", id );
	MCP_RecAppendCause( body, source, inflictor );
	body.AppendFormat( " hp=%d", actor->health );
	MCP_RecWrite( "death", body );
}

static bool MCP_RecScriptWanted( int num )
{
	if ( !g_recScripts ) return false;
	if ( g_recAllScripts ) return true;
	for ( unsigned i = 0; i < g_recScriptNums.Size(); i++ )
		if ( g_recScriptNums[i] == num ) return true;
	return false;
}

// script=<n>, or for a named script script=-1 with name= last (a name may hold spaces).
static void MCP_RecAppendScript( FString &body, int num, const FString &rest )
{
	body.AppendFormat( " script=%d%s", ( num < 0 ) ? -1 : num, rest.GetChars() );
	if ( num < 0 ) body.AppendFormat( " name=%s", FName( ENamedName( -num ) ).GetChars() );
}

void MCP_Rec_ScriptStartImpl( const void *script, int num, const char *module, AActor *activator )
{
	// Before any guard, so a reused address never inherits an old serial.
	g_recSerials.erase( script );
	if ( !MCP_RecScriptWanted( num ) ) return;
	const int serial = ++g_recNextSerial;
	g_recSerials[script] = serial;
	FString body, rest;
	body.Format( "serial=%d", serial );
	rest.Format( " module=%s act=%s", module, ( activator != NULL ) ? MCP_ActorRef( activator ).GetChars() : "none" );
	MCP_RecAppendScript( body, num, rest );
	MCP_RecWrite( "script_start", body );
}

void MCP_Rec_ScriptEndImpl( const void *script, int num )
{
	// Before any guard; an end with no recorded start reads serial=0.
	int serial = 0;
	auto it = g_recSerials.find( script );
	if ( it != g_recSerials.end() )
	{
		serial = it->second;
		g_recSerials.erase( it );
	}
	if ( !MCP_RecScriptWanted( num ) ) return;
	FString body;
	body.Format( "serial=%d", serial );
	MCP_RecAppendScript( body, num, "" );
	MCP_RecWrite( "script_end", body );
}

static void MCP_RecSetupError( const FString &why )
{
	g_recBad = true;
	Printf( "error %s\n", why.GetChars() );
}

static void MCP_RecAddVar( FCommandLine &argv )
{
	if ( g_recVars.Size() >= MCP_REC_MAX_VARS )
	{
		FString err;
		err.Format( "too many vars (max %u)", MCP_REC_MAX_VARS );
		MCP_RecSetupError( err );
		return;
	}
	MCPRecVar v;
	FString err;
	if ( !MCP_AcsRefParse( argv, 2, v.ref, v.label, err ) ) { MCP_RecSetupError( err ); return; }
	v.last = 0;
	g_recVars.Push( v );
	Printf( "MCP_REC var n=%u\n", g_recVars.Size() );
}

// Calls fn on each item of a comma list, stopping at the first it refuses (an empty item is refused).
template <class F> static bool MCP_EachItem( const char *list, F fn )
{
	for ( const char *p = list; ; )
	{
		const char *comma = strchr( p, ',' );
		const FString item( p, ( comma != NULL ) ? size_t( comma - p ) : strlen( p ) );
		if ( item.IsEmpty() || !fn( item ) ) return false;
		if ( comma == NULL ) return true;
		p = comma + 1;
	}
}

// fields <a,b,...> into MCP_FIELDS indices; false names the unknown one in err.
static bool MCP_RecParseFields( const char *list, TArray<int> &out, FString &err )
{
	out.Clear();
	return MCP_EachItem( list, [&]( const FString &item ) {
		const int i = MCP_FieldIndex( item.GetChars() );
		if ( i >= 0 ) { out.Push( i ); return true; }
		err.Format( "unknown field %s (known:", item.GetChars() );
		for ( size_t k = 0; k < countof( MCP_FIELDS ); k++ )
			if ( MCP_FIELDS[k].kind != 't' ) err.AppendFormat( "%s%s", k ? "," : " ", MCP_FIELDS[k].name );
		err += ")";
		return false;
	} );
}

// watch [class=<Name>] [tid=<n>] [player=<n>]
static void MCP_RecAddWatch( FCommandLine &argv )
{
	const char *cls = MCP_StrArg( argv, "class" ), *tid = MCP_StrArg( argv, "tid" ), *player = MCP_StrArg( argv, "player" );
	MCPRecWatch w = { NULL, 0, -1 };
	FString err;
	if ( cls == NULL && tid == NULL && player == NULL ) err = "usage: mcp_rec watch [class=<name>] [tid=<n>] [player=<n>]";
	else if ( g_recNWatches >= MCP_REC_MAX_WATCHES ) err.Format( "too many watches (max %d)", MCP_REC_MAX_WATCHES );
	else if ( cls != NULL && ( w.type = PClass::FindClass( cls ) ) == NULL ) err.Format( "unknown class %s", cls );
	else if ( cls != NULL && !w.type->IsDescendantOf( RUNTIME_CLASS( AActor ) ) ) err.Format( "not an actor class %s", cls );
	else if ( tid != NULL && ( !MCP_ParseInt( tid, w.tid ) || w.tid < 1 ) ) err = "tid wants a number above 0";
	else if ( player != NULL && ( !MCP_ParseInt( player, w.player ) || w.player < 0 || w.player >= MAXPLAYERS ) )
		err.Format( "player wants 0..%d", MAXPLAYERS - 1 );
	if ( !err.IsEmpty() ) { MCP_RecSetupError( err ); return; }
	g_recWatches[g_recNWatches++] = w;
	Printf( "MCP_REC watch n=%d\n", g_recNWatches );
}

static void MCP_RecSetEvents( const char *list )
{
	int mask = 0;
	FString err;
	const bool ok = stricmp( list, "none" ) == 0 || MCP_EachItem( list, [&]( const FString &item ) {
		for ( const auto &e : MCP_REC_EVENTS )
			if ( item.CompareNoCase( e.name ) == 0 ) { mask |= e.bit; return true; }
		err.Format( "unknown event %s (known: ", item.GetChars() );
		for ( size_t i = 0; i < countof( MCP_REC_EVENTS ); i++ ) err.AppendFormat( "%s%s", i ? "," : "", MCP_REC_EVENTS[i].name );
		err += ")";
		return false;
	} );
	if ( !ok ) { MCP_RecSetupError( err.IsEmpty() ? FString( "usage: mcp_rec events <a,b,...|none>" ) : err ); return; }
	g_recEvents = mask;
	int n = 0;
	for ( const auto &e : MCP_REC_EVENTS ) n += ( mask & e.bit ) ? 1 : 0;
	Printf( "MCP_REC events n=%d\n", n );
}

// scripts <all|a,b,...>: numbers above 0 and names.
static void MCP_RecSetScripts( const char *list )
{
	g_recScriptNums.Clear();
	g_recAllScripts = stricmp( list, "all" ) == 0;
	FString err;
	const bool ok = g_recAllScripts || MCP_EachItem( list, [&]( const FString &item ) {
		int num;
		if ( !MCP_ParseInt( item.GetChars(), num ) ) num = -int( FName( item.GetChars() ) );
		else if ( num < 1 ) { err = "a script number is above 0"; return false; }
		if ( g_recScriptNums.Size() >= MCP_REC_MAX_SCRIPTS ) { err.Format( "too many scripts (max %u)", MCP_REC_MAX_SCRIPTS ); return false; }
		g_recScriptNums.Push( num );
		return true;
	} );
	if ( !ok )
	{
		g_recScripts = false;
		MCP_RecSetupError( err.IsEmpty() ? FString( "usage: mcp_rec scripts <all|a,b,...>" ) : err );
		return;
	}
	g_recScripts = true;
	if ( g_recAllScripts ) Printf( "MCP_REC scripts n=all\n" );
	else Printf( "MCP_REC scripts n=%u\n", g_recScriptNums.Size() );
}

// key=N within lo..hi, else def when absent; false when given but not such a number.
static bool MCP_RangeArg( FCommandLine &argv, const char *key, int def, int lo, int hi, int &out )
{
	const char *v = MCP_StrArg( argv, key );
	out = def;
	return v == NULL || ( MCP_ParseInt( v, out ) && out >= lo && out <= hi );
}

// go tics=<N> [run=1] [every=<n>] [changes=0|1]
static void MCP_RecGo( FCommandLine &argv )
{
	int tics, run, every, changes;
	if ( MCP_RecArmed ) { Printf( "error armed: mcp_rec stop first\n" ); return; }
	if ( g_recBad ) { Printf( "error bad setup: a line failed, mcp_rec clear first\n" ); return; }
	if ( g_recNWatches == 0 && !g_recScripts && g_recVars.Size() == 0 ) { Printf( "error nothing to record: add a watch, scripts or a var\n" ); return; }
	if ( !MCP_RangeArg( argv, "tics", 0, 1, MCP_REC_MAX_TICS, tics ) || tics < 1 || !MCP_RangeArg( argv, "run", 0, 0, 1, run ) ||
		!MCP_RangeArg( argv, "every", 1, 1, MCP_REC_MAX_TICS, every ) || !MCP_RangeArg( argv, "changes", 1, 0, 1, changes ) )
	{
		Printf( "error usage: mcp_rec go tics=<1-%d> [run=1] [every=<n>] [changes=0|1]\n", MCP_REC_MAX_TICS );
		return;
	}
	if ( NETWORK_InClientMode() ) { Printf( "error netgame client: record on the server\n" ); return; }
	if ( NETWORK_GetState() == NETSTATE_SERVER && run )
	{
		Printf( "error netgame server: run=1 needs a pause, which a server ignores; arm without run\n" );
		return;
	}
	if ( demoplayback ) { Printf( "error demo playback\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	if ( run && demorecording && !MCP_ClockFrozen )
	{
		Printf( "error recording: a pause would desync the demo; freeze the clock first\n" );
		return;
	}
	for ( unsigned i = 0; i < g_recVars.Size(); i++ )
	{
		int value;
		if ( !MCP_AcsRefRead( g_recVars[i].ref, value ) ) { Printf( "error var %u stale: mcp_rec clear first\n", i + 1 ); return; }
	}
	FString err;
	if ( !g_recFieldsSet ) MCP_RecParseFields( MCP_REC_DEFAULT_FIELDS, g_recFields, err );

	g_recRows.Clear();
	g_recIds.clear();
	g_recSerials.clear();
	g_recPsprites.clear();
	g_recRan = g_recNextId = g_recNextSerial = g_recLive = g_recDropped = g_recUntracked = 0;
	g_recTics = tics;
	g_recRun = run != 0;
	g_recEvery = every;
	g_recChanges = changes != 0;
	g_recReason = "-";
	g_recStart = g_recLast = level.maptime;
	g_recMap = level.mapname;
	MCP_RecArmed = true;
	// The baseline: every current match and its sample at this maptime.
	MCP_RecWalk( true, MCP_REC_ALL_WATCHES );
	MCP_RecReadVars( true );
	// Unpaused on the game thread, so the first counted tic is the next one that runs.
	if ( g_recRun && !MCP_ClockFrozen ) paused = 0;
	Printf( "MCP_REC armed watches=%d tracked=%d vars=%u tics=%d maptime=%d\n", g_recNWatches, g_recNextId, g_recVars.Size(), tics, level.maptime );
}

// dump <path>: the file's name must start with mcp-rec-, so the CCMD is no general file writer.
static void MCP_RecDump( FCommandLine &argv )
{
	if ( argv.argc() < 3 ) { Printf( "error usage: mcp_rec dump <path>\n" ); return; }
	const char *path = argv[2], *name = path;
	for ( const char *p = path; *p != '\0'; p++ )
		if ( *p == '/' || *p == '\\' ) name = p + 1;
	if ( strncmp( name, "mcp-rec-", 8 ) != 0 ) { Printf( "error dump writes only a file named mcp-rec-*\n" ); return; }
	if ( MCP_RecArmed && !MCP_RecSameLevel() ) MCP_RecDisarm( "level_change" );
	// The sample columns, for a reader that didn't arm the recording itself.
	FString fields;
	for ( unsigned i = 0; i < g_recFields.Size(); i++ ) fields.AppendFormat( "%s%s", i ? "," : "", MCP_FIELDS[g_recFields[i]].name );
	FILE *f = fopen( path, "w" );
	if ( f == NULL ) { Printf( "error cannot write %s\n", path ); return; }
	fprintf( f, "MCP_RECFILE v=1 engine=zandronum map=%s start=%d ran=%d rows=%u dropped=%d fields=%s reason=%s\n",
		g_recMap.IsEmpty() ? "-" : g_recMap.GetChars(), g_recStart, g_recRan, g_recRows.Size(), g_recDropped,
		fields.IsEmpty() ? "-" : fields.GetChars(), g_recReason );
	for ( unsigned i = 0; i < g_recRows.Size(); i++ ) fprintf( f, "%s\n", g_recRows[i].GetChars() );
	const bool ok = ferror( f ) == 0;
	if ( fclose( f ) != 0 || !ok ) { Printf( "error cannot write %s\n", path ); return; }
	Printf( "MCP_REC wrote rows=%u dropped=%d\n", g_recRows.Size(), g_recDropped );
}

static void MCP_RecClear()
{
	g_recPsprites.clear();
	g_recNWatches = 0;
	g_recFields.Clear();
	g_recFieldsSet = false;
	g_recEvents = MCP_REC_DEFAULT_EVENTS;
	g_recScripts = g_recAllScripts = false;
	g_recScriptNums.Clear();
	g_recBad = false;
	g_recVars.Clear();
	g_recRows.Clear();
	g_recTics = g_recRan = g_recStart = g_recNextId = g_recDropped = g_recUntracked = 0;
	g_recReason = "-";
	g_recMap = "";
	Printf( "MCP_REC cleared\n" );
}

// Unsafe: dump writes a file at the path it names, so menus and mod scripts can't run it.
UNSAFE_CCMD( mcp_rec )
{
	const char *sub = ( argv.argc() >= 2 ) ? argv[1] : "";
	const char *arg = ( argv.argc() >= 3 ) ? argv[2] : NULL;
	const bool setup = stricmp( sub, "watch" ) == 0 || stricmp( sub, "fields" ) == 0 || stricmp( sub, "events" ) == 0 ||
		stricmp( sub, "scripts" ) == 0 || stricmp( sub, "var" ) == 0;
	// Not marked bad: the armed recording isn't the setup being edited.
	if ( MCP_RecArmed && ( setup || stricmp( sub, "clear" ) == 0 ) ) { Printf( "error armed: mcp_rec stop first\n" ); return; }
	if ( setup && arg == NULL ) { MCP_RecSetupError( FString( "usage: mcp_rec " ) + sub + " <...>" ); return; }

	if ( stricmp( sub, "clear" ) == 0 ) MCP_RecClear();
	else if ( stricmp( sub, "watch" ) == 0 ) MCP_RecAddWatch( argv );
	else if ( stricmp( sub, "var" ) == 0 ) MCP_RecAddVar( argv );
	else if ( stricmp( sub, "fields" ) == 0 )
	{
		FString err;
		if ( !MCP_RecParseFields( arg, g_recFields, err ) )
		{
			MCP_RecSetupError( err.IsEmpty() ? FString( "usage: mcp_rec fields <a,b,...>" ) : err );
			return;
		}
		g_recFieldsSet = true;
		Printf( "MCP_REC fields n=%u\n", g_recFields.Size() );
	}
	else if ( stricmp( sub, "events" ) == 0 ) MCP_RecSetEvents( arg );
	else if ( stricmp( sub, "scripts" ) == 0 ) MCP_RecSetScripts( arg );
	else if ( stricmp( sub, "go" ) == 0 ) MCP_RecGo( argv );
	else if ( stricmp( sub, "status" ) == 0 )
	{
		if ( MCP_RecArmed && !MCP_RecSameLevel() ) MCP_RecDisarm( "level_change" );
		Printf( "MCP_REC active=%d ran=%d tics=%d rows=%u dropped=%d tracked=%d untracked=%d maptime=%d reason=%s\n",
			MCP_RecArmed ? 1 : 0, g_recRan, g_recTics, g_recRows.Size(), g_recDropped, g_recNextId, g_recUntracked,
			level.maptime, g_recReason );
	}
	else if ( stricmp( sub, "dump" ) == 0 ) MCP_RecDump( argv );
	else if ( stricmp( sub, "stop" ) == 0 )
	{
		if ( !MCP_RecArmed ) { Printf( "MCP_REC idle\n" ); return; }
		MCP_RecDisarm( "stopped" );
		Printf( "MCP_REC stopped ran=%d\n", g_recRan );
	}
	else Printf( "error usage: mcp_rec clear|watch|fields|events|scripts|var|go|status|dump|stop\n" );
}

// --- mcp_checkpoint: a replay-stable digest of the playsim, for demo sync checks.
enum { MCP_CP_POS, MCP_CP_VEL, MCP_CP_ANGLE, MCP_CP_HEALTH, MCP_CP_TICS, MCP_CP_STATE, MCP_CP_INV, MCP_CP_GROUPS };
static const char *const MCP_CP_NAMES[MCP_CP_GROUPS] = { "pos", "vel", "angle", "health", "tics", "state", "inv" };
static const DWORD MCP_FNV_BASIS = 2166136261u;

static void MCP_Fnv( DWORD &h, const void *data, size_t size )
{
	for ( size_t i = 0; i < size; i++ ) h = ( h ^ static_cast<const BYTE *>( data )[i] ) * 16777619u;
}
template <class T> static void MCP_FnvValue( DWORD &h, const T &v ) { MCP_Fnv( h, &v, sizeof( v ) ); }
static void MCP_FnvString( DWORD &h, const char *s ) { MCP_Fnv( h, s, strlen( s ) + 1 ); }

// One actor's group hashes, by sprite name and frame rather than the load-order sprite index or the
// state pointer and class, so a cosmetic replacement hashes the same.
static void MCP_CheckpointGroups( AActor *a, DWORD g[MCP_CP_GROUPS], FString &sprite, FString &frame )
{
	for ( int i = 0; i < MCP_CP_GROUPS; i++ ) g[i] = MCP_FNV_BASIS;
	MCP_FnvValue( g[MCP_CP_POS], a->x ); MCP_FnvValue( g[MCP_CP_POS], a->y ); MCP_FnvValue( g[MCP_CP_POS], a->z );
	MCP_FnvValue( g[MCP_CP_VEL], a->velx ); MCP_FnvValue( g[MCP_CP_VEL], a->vely ); MCP_FnvValue( g[MCP_CP_VEL], a->velz );
	MCP_FnvValue( g[MCP_CP_ANGLE], a->angle ); MCP_FnvValue( g[MCP_CP_ANGLE], a->pitch );
	MCP_FnvValue( g[MCP_CP_HEALTH], a->health );
	MCP_FnvValue( g[MCP_CP_TICS], a->tics );
	static const int spriteField = MCP_FieldIndex( "sprite" ), frameField = MCP_FieldIndex( "frame" );
	const MCPFieldCtx c = { NULL, 0, -1 };
	if ( !MCP_FIELDS[spriteField].value( sprite, a, c ) || !MCP_FIELDS[frameField].value( frame, a, c ) )
	{
		sprite = "----";
		frame = "-";
	}
	MCP_FnvString( g[MCP_CP_STATE], sprite );
	MCP_FnvString( g[MCP_CP_STATE], frame );
	for ( AInventory *item = a->Inventory; item != NULL; item = item->Inventory )
	{
		MCP_FnvString( g[MCP_CP_INV], item->GetClass()->TypeName.GetChars() );
		MCP_FnvValue( g[MCP_CP_INV], item->Amount );
	}
}

// mcp_checkpoint [rows]: read-only, so it works frozen, paused or live.
CCMD( mcp_checkpoint )
{
	const bool rows = argv.argc() >= 2 && stricmp( argv[1], "rows" ) == 0;
	if ( argv.argc() >= 2 && !rows ) { Printf( "error usage: mcp_checkpoint [rows]\n" ); return; }
	// GL dynamic lights are animated by the renderer per frame, not by the sim.
	static const PClass *dynLight = PClass::FindClass( "DynamicLight" );
	DWORD total[MCP_CP_GROUPS], all = MCP_FNV_BASIS;
	for ( int i = 0; i < MCP_CP_GROUPS; i++ ) total[i] = MCP_FNV_BASIS;
	unsigned n = 0;
	TArray<FString> rowLines;
	TThinkerIterator<AActor> it;
	for ( AActor *a; ( a = it.Next() ) != NULL; )
	{
		if ( ( dynLight != NULL && a->IsKindOf( dynLight ) ) || MCP_IsOwnedItem( a ) ) continue;
		DWORD g[MCP_CP_GROUPS], h = MCP_FNV_BASIS;
		FString sprite, frame;
		MCP_CheckpointGroups( a, g, sprite, frame );
		for ( int i = 0; i < MCP_CP_GROUPS; i++ )
		{
			MCP_FnvValue( total[i], g[i] );
			MCP_FnvValue( h, g[i] );
		}
		MCP_FnvValue( all, h );
		if ( rows )
		{
			FString &line = rowLines[rowLines.Push( FString() )];
			line.Format( "MCP_CHECKPOINT_ROW i=%u class=%s h=%08x x=%08x y=%08x z=%08x vx=%08x vy=%08x vz=%08x angle=%08x pitch=%08x "
				"health=%d tics=%d sprite=%s frame=%s", n, a->GetClass()->TypeName.GetChars(), h, DWORD( a->x ), DWORD( a->y ),
				DWORD( a->z ), DWORD( a->velx ), DWORD( a->vely ), DWORD( a->velz ), DWORD( a->angle ), DWORD( a->pitch ),
				a->health, a->tics, sprite.GetChars(), frame.GetChars() );
		}
		n++;
	}
	FString line;
	line.Format( "MCP_CHECKPOINT maptime=%d actors=%u rng=%08x hash=%08x", level.maptime, n, DWORD( FRandom::StaticSumSeeds() ), all );
	for ( int i = 0; i < MCP_CP_GROUPS; i++ ) line.AppendFormat( " %s=%08x", MCP_CP_NAMES[i], total[i] );
	Printf( "%s\n", line.GetChars() );
	for ( unsigned i = 0; i < rowLines.Size(); i++ ) Printf( "%s\n", rowLines[i].GetChars() );
}
