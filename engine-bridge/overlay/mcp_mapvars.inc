// ==== MCP_MAPVARS (overlay-appended to p_acs.cpp; not committed upstream) ====
// Read/write map-scope ACS variables and arrays by name, across all loaded ACS
// modules. Uses only public FBehavior API, all of which is internally bounds-
// checked (GetArrayVal/SetArrayVal no-op on OOB, FindMap* return -1, StaticGet-
// Module returns NULL past the end), so bad input can't crash. Map vars are live
// only while a map is loaded.
static FBehavior *MCP_FindModule( const char *name, int &outIndex, bool isArray )
{
	for ( int lib = 0; ; lib++ )
	{
		FBehavior *m = FBehavior::StaticGetModule( lib );
		if ( m == NULL ) break;
		int idx = isArray ? m->FindMapArray( name ) : m->FindMapVarName( name );
		if ( idx >= 0 ) { outIndex = idx; return m; }
	}
	return NULL;
}

CCMD( getmapvar )
{
	if ( argv.argc() < 2 ) { Printf( "usage: getmapvar <name>\n" ); return; }
	int idx;
	FBehavior *m = MCP_FindModule( argv[1], idx, false );
	if ( m == NULL || m->MapVars[idx] == NULL ) { Printf( "mapvar %s not found\n", argv[1] ); return; }
	Printf( "mapvar %s = %d\n", argv[1], *m->MapVars[idx] );
}

CCMD( setmapvar )
{
	if ( argv.argc() < 3 ) { Printf( "usage: setmapvar <name> <value>\n" ); return; }
	int idx;
	FBehavior *m = MCP_FindModule( argv[1], idx, false );
	if ( m == NULL || m->MapVars[idx] == NULL ) { Printf( "mapvar %s not found\n", argv[1] ); return; }
	*m->MapVars[idx] = atoi( argv[2] );
	Printf( "mapvar %s = %d\n", argv[1], *m->MapVars[idx] );
}

CCMD( getmaparray )
{
	if ( argv.argc() < 3 ) { Printf( "usage: getmaparray <name> <index>\n" ); return; }
	int arrnum;
	FBehavior *m = MCP_FindModule( argv[1], arrnum, true );
	if ( m == NULL ) { Printf( "maparray %s not found\n", argv[1] ); return; }
	int index = atoi( argv[2] );
	Printf( "maparray %s[%d] = %d\n", argv[1], index, m->GetArrayVal( arrnum, index ) );
}

CCMD( setmaparray )
{
	if ( argv.argc() < 4 ) { Printf( "usage: setmaparray <name> <index> <value>\n" ); return; }
	int arrnum;
	FBehavior *m = MCP_FindModule( argv[1], arrnum, true );
	if ( m == NULL ) { Printf( "maparray %s not found\n", argv[1] ); return; }
	int index = atoi( argv[2] );
	m->SetArrayVal( arrnum, index, atoi( argv[3] ) );
	Printf( "maparray %s[%d] = %d\n", argv[1], index, m->GetArrayVal( arrnum, index ) );
}

CCMD( dumpmodules )
{
	Printf( "MCP_MODULES\n" );
	for ( int lib = 0; ; lib++ )
	{
		FBehavior *m = FBehavior::StaticGetModule( lib );
		if ( m == NULL ) break;
		Printf( "module %d %s\n", lib, m->GetModuleName() );
	}
}
// ==== end MCP_MAPVARS ====
