//
// mcp_actorstate.cpp -- read-only DECORATE/actor state inspection (overlay file).
// Dumps an actor's live state: class, health, position, current DECORATE state
// (sprite/frame/tics, e.g. "TNT1 A 0"), inventory chain, and -- for players --
// ready weapon and morph status. Plus the actors near the player. All reads.
//
#include "doomtype.h"
#include "c_dispatch.h"
#include "actor.h"
#include "d_player.h"
#include "doomstat.h"
#include "g_shared/a_pickups.h"
#include "r_state.h"
#include "r_data/sprites.h"
#include "m_fixed.h"
#include "tables.h"
#include <stdlib.h>

static void MCP_PrintState( const char *label, AActor *mo )
{
	if ( mo->state != NULL && mo->state->sprite < sprites.Size() )
	{
		Printf( "%s %s %c %d\n", label, sprites[mo->state->sprite].name,
			(char)( 'A' + mo->state->Frame ), mo->state->Tics );
	}
}

CCMD( dumpactor )
{
	AActor *mo = players[consoleplayer].mo;
	if ( argv.argc() >= 2 )
	{
		FActorIterator it( atoi( argv[1] ) );
		mo = it.Next();
	}

	Printf( "MCP_ACTOR\n" );
	if ( mo == NULL ) { Printf( "actor none\n" ); return; }

	Printf( "class %s\n", mo->GetClass()->TypeName.GetChars() );
	Printf( "health %d\n", mo->health );
	Printf( "pos %.1f %.1f %.1f\n", FIXED2FLOAT( mo->x ), FIXED2FLOAT( mo->y ), FIXED2FLOAT( mo->z ) );
	Printf( "angle %.1f\n", mo->angle / float( ANGLE_1 ) );
	MCP_PrintState( "state", mo );

	if ( mo->player != NULL )
	{
		if ( mo->player->ReadyWeapon != NULL )
			Printf( "weapon %s\n", mo->player->ReadyWeapon->GetClass()->TypeName.GetChars() );
		Printf( "morphtics %d\n", mo->player->morphTics );
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
		if ( a == me ) continue;
		if ( abs( a->x - me->x ) > r || abs( a->y - me->y ) > r ) continue;
		const char *spr = ( a->state != NULL && a->state->sprite < sprites.Size() )
			? sprites[a->state->sprite].name : "----";
		Printf( "near %s %d %.0f %.0f %s\n", a->GetClass()->TypeName.GetChars(), a->health,
			FIXED2FLOAT( a->x ), FIXED2FLOAT( a->y ), spr );
	}
}
