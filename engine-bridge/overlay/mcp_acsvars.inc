// ==== MCP_ACSVARS (overlay-appended to p_acs.cpp; not committed upstream) ====
// Read/write ACS world and global variables by index. World vars are a
// file-static array in p_acs.cpp, so these commands live here (appended) rather
// than in a separate overlay file. Indices are bounds-checked before access
// because the array's operator[] calls I_Error (fatal) on out-of-range.
CCMD( getacsvar )
{
	if ( argv.argc() < 3 ) { Printf( "usage: getacsvar <world|global> <index>\n" ); return; }
	int index = atoi( argv[2] );
	if ( !stricmp( argv[1], "world" ) )
	{
		if ( index < 0 || index >= NUM_WORLDVARS ) { Printf( "index out of range (0-%d)\n", NUM_WORLDVARS - 1 ); return; }
		Printf( "acsvar world %d = %d\n", index, ACS_WorldVars[index] );
	}
	else if ( !stricmp( argv[1], "global" ) )
	{
		if ( index < 0 || index >= NUM_GLOBALVARS ) { Printf( "index out of range (0-%d)\n", NUM_GLOBALVARS - 1 ); return; }
		Printf( "acsvar global %d = %d\n", index, ACS_GlobalVars[index] );
	}
	else { Printf( "unknown scope '%s' (use world|global)\n", argv[1] ); }
}

CCMD( setacsvar )
{
	if ( argv.argc() < 4 ) { Printf( "usage: setacsvar <world|global> <index> <value>\n" ); return; }
	int index = atoi( argv[2] );
	int value = atoi( argv[3] );
	if ( !stricmp( argv[1], "world" ) )
	{
		if ( index < 0 || index >= NUM_WORLDVARS ) { Printf( "index out of range (0-%d)\n", NUM_WORLDVARS - 1 ); return; }
		ACS_WorldVars[index] = value;
		Printf( "acsvar world %d = %d\n", index, ACS_WorldVars[index] );
	}
	else if ( !stricmp( argv[1], "global" ) )
	{
		if ( index < 0 || index >= NUM_GLOBALVARS ) { Printf( "index out of range (0-%d)\n", NUM_GLOBALVARS - 1 ); return; }
		ACS_GlobalVars[index] = value;
		Printf( "acsvar global %d = %d\n", index, ACS_GlobalVars[index] );
	}
	else { Printf( "unknown scope '%s' (use world|global)\n", argv[1] ); }
}

CCMD( dumpacsvars )
{
	Printf( "MCP_ACSVARS\n" );
	for ( int i = 0; i < NUM_WORLDVARS; i++ )
		if ( ACS_WorldVars[i] != 0 ) Printf( "acsvar world %d = %d\n", i, ACS_WorldVars[i] );
	for ( int i = 0; i < NUM_GLOBALVARS; i++ )
		if ( ACS_GlobalVars[i] != 0 ) Printf( "acsvar global %d = %d\n", i, ACS_GlobalVars[i] );
}
// ==== end MCP_ACSVARS ====
