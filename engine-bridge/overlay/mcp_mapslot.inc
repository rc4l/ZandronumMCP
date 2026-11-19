// ==== MCP_MAPSLOT (overlay-appended to p_acs.cpp; not committed upstream) ====
// Read or write a map variable by slot for vars no MEXP name reaches, picking the module by image
// digest, never by name or index, since a wrong module reads a plausible 0 instead of failing.
#include "md5.h"

// The digest after header plus code: these chunks, id by id, each id's chunks in file order.
static const DWORD MCP_MapSlotChunks[] = {
	MAKE_ID('A','R','A','Y'), MAKE_ID('A','I','M','P'), MAKE_ID('M','I','M','P'), MAKE_ID('M','E','X','P'),
	MAKE_ID('M','I','N','I'), MAKE_ID('A','I','N','I'), MAKE_ID('L','O','A','D'),
};

// Whether a module is the image the host digested, trusting chunk sizes as the loader does (FindChunk
// is NULL without chunks and stays inside the image).
static bool MCP_MapSlotMatches( FBehavior *m, DWORD len, DWORD first, const BYTE want[16] )
{
	BYTE *start = m->FindChunk( first );
	if ( start == NULL || m->PC2Ofs( (int *)start ) != len ) return false;
	MD5Context md5;
	md5.Update( (const BYTE *)m->Ofs2PC( 0 ), len );
	for ( size_t i = 0; i < countof( MCP_MapSlotChunks ); i++ )
	{
		for ( BYTE *c = m->FindChunk( MCP_MapSlotChunks[i] ); c != NULL; c = m->NextChunk( c ) )
			md5.Update( c, 8 + ((DWORD *)c)[1] );
	}
	BYTE got[16];
	md5.Final( got );
	return memcmp( got, want, 16 ) == 0;
}

// Exactly 32 hex digits, as 16 bytes.
static bool MCP_MapSlotHex( const char *s, BYTE out[16] )
{
	if ( strlen( s ) != 32 || strspn( s, "0123456789abcdefABCDEF" ) != 32 ) return false;
	for ( int i = 0; i < 16; i++ )
	{
		char pair[3] = { s[2 * i], s[2 * i + 1], 0 };
		out[i] = (BYTE)strtoul( pair, NULL, 16 );
	}
	return true;
}

// mcp_mapslot <slot> v=1 code=<len> first=<fourcc> md5=<32 hex> [index=<k>] [set=<value>]
// Reply: MCP_MAPSLOT module=<i> slot=<s> [index=<k>] value=<n> name=<module name>
CCMD( mcp_mapslot )
{
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }
	const char *usage = "error usage: mcp_mapslot <slot> v=1 code=<len> first=<fourcc> md5=<32 hex> [index=<k>] [set=<value>]\n";
	int slot, v = 0, len = -1, index = -1, value = 0;
	bool hasV = false, hasFirst = false, hasMd5 = false, hasIndex = false, hasSet = false;
	DWORD first = 0;
	BYTE md5[16];
	if ( argv.argc() < 2 || !MCP_ParseInt( argv[1], slot ) ) { Printf( "%s", usage ); return; }
	for ( int i = 2; i < argv.argc(); i++ )
	{
		const char *a = argv[i];
		bool ok;
		if ( strncmp( a, "v=", 2 ) == 0 ) ok = hasV = MCP_ParseInt( a + 2, v );
		else if ( strncmp( a, "code=", 5 ) == 0 ) ok = MCP_ParseInt( a + 5, len ) && len >= 0;
		else if ( strncmp( a, "first=", 6 ) == 0 )
		{
			const char *f = a + 6;
			ok = hasFirst = strlen( f ) == 4;
			if ( ok ) first = MAKE_ID( f[0], f[1], f[2], f[3] );
		}
		else if ( strncmp( a, "md5=", 4 ) == 0 ) ok = hasMd5 = MCP_MapSlotHex( a + 4, md5 );
		else if ( strncmp( a, "index=", 6 ) == 0 ) ok = hasIndex = MCP_ParseInt( a + 6, index ) && index >= 0;
		else if ( strncmp( a, "set=", 4 ) == 0 ) ok = hasSet = MCP_ParseInt( a + 4, value );
		else ok = false;
		if ( !ok ) { Printf( "%s", usage ); return; }
	}
	if ( !hasV || len < 0 || !hasFirst || !hasMd5 ) { Printf( "%s", usage ); return; }
	if ( v != 1 ) { Printf( "error unsupported v=%d\n", v ); return; }
	// Before MapVars is touched: its operator[] calls I_Error out of range.
	if ( slot < 0 || slot >= NUM_MAPVARS ) { Printf( "error slot out of range\n" ); return; }

	FBehavior *found = NULL;
	int at = -1, count = 0;
	for ( FBehavior *m; ( m = FBehavior::StaticGetModule( count ) ) != NULL; count++ )
	{
		if ( !MCP_MapSlotMatches( m, (DWORD)len, first, md5 ) ) continue;
		if ( found != NULL ) { Printf( "error ambiguous modules=%d,%d\n", at, count ); return; }
		found = m;
		at = count;
	}
	if ( found == NULL ) { Printf( "error no module matches map=%s modules=%d\n", level.mapname, count ); return; }

	// An element is read as PCD_PUSHMAPARRAY reads it: the slot holds the array's number.
	SDWORD *var = found->MapVars[slot];
	if ( hasIndex )
	{
		if ( hasSet ) found->SetArrayVal( *var, index, value );
		Printf( "MCP_MAPSLOT module=%d slot=%d index=%d value=%d name=%s\n",
			at, slot, index, found->GetArrayVal( *var, index ), found->GetModuleName() );
		return;
	}
	if ( hasSet ) *var = value;
	Printf( "MCP_MAPSLOT module=%d slot=%d value=%d name=%s\n", at, slot, *var, found->GetModuleName() );
}
// ==== end MCP_MAPSLOT ====
