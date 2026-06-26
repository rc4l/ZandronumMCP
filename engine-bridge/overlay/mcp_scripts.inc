// ==== MCP_SCRIPTS (overlay-appended to p_acs.cpp; not committed upstream) ====
// List ACS scripts and functions across all loaded modules. Read-only, uses
// public bounds-safe API (GetScriptPtr returns NULL past the end; FindChunk
// returns NULL if absent), so it can't crash or perturb state.
CCMD( dumpscripts )
{
	Printf( "MCP_SCRIPTS\n" );
	for ( int lib = 0; ; lib++ )
	{
		FBehavior *m = FBehavior::StaticGetModule( lib );
		if ( m == NULL ) break;
		for ( int i = 0; ; i++ )
		{
			ScriptPtr *s = m->GetScriptPtr( i );
			if ( s == NULL ) break;
			// number < 0 encodes a named script (negated FName).
			if ( s->Number < 0 )
			{
				FName nm = FName( (ENamedName) -s->Number );
				Printf( "script %d %d %s %d %d\n", lib, s->Number, nm.GetChars(), (int)s->Type, (int)s->ArgCount );
			}
			else
			{
				Printf( "script %d %d - %d %d\n", lib, s->Number, (int)s->Type, (int)s->ArgCount );
			}
		}
	}
}

CCMD( dumpfunctions )
{
	Printf( "MCP_FUNCTIONS\n" );
	for ( int lib = 0; ; lib++ )
	{
		FBehavior *m = FBehavior::StaticGetModule( lib );
		if ( m == NULL ) break;
		DWORD *fnames = (DWORD *)m->FindChunk( MAKE_ID( 'F', 'N', 'A', 'M' ) );
		if ( fnames == NULL ) continue;
		int count = LittleLong( fnames[2] );
		for ( int i = 0; i < count; i++ )
		{
			const char *name = (char *)( fnames + 2 ) + LittleLong( fnames[3 + i] );
			Printf( "function %d %d %s\n", lib, i, name );
		}
	}
}
// ==== end MCP_SCRIPTS ====
