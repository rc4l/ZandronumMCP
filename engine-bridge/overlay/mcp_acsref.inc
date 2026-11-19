// ==== MCP_ACSREF (overlay-appended after MCP_MAPSLOT in p_acs.cpp) ====
enum { MCP_REF_WORLD, MCP_REF_GLOBAL, MCP_REF_SCALAR, MCP_REF_ARRAY };

static FBehavior *MCP_AcsRefModule( int n ) { return FBehavior::StaticGetModule( n ); }

static int MCP_AcsRefArraySize( FBehavior *m, int slot )
{
	for ( auto *c = m->FindChunk( MAKE_ID('A','R','A','Y') ); c != NULL; c = m->NextChunk( c ) )
	{
		const unsigned int *words = (const unsigned int *)c;
		for ( unsigned i = 0; i + 1 < LittleLong( words[1] ) / 4; i += 2 )
			if ( LittleLong( words[2 + i] ) == unsigned( slot ) ) return int( LittleLong( words[3 + i] ) );
	}
	return -1;
}

bool MCP_AcsRefParse( FCommandLine &argv, int first, MCPAcsRef &ref, FString &label, FString &err )
{
	const char *usage = "usage: mcp_rec var map=<name>|world=<n>|global=<n>|slot=<s> [digest tokens] [index=<k>] [label=<text>]";
	if ( gamestate != GS_LEVEL ) { err = "not in a level"; return false; }
	ref = { -1, -1, -1, -1, NULL };
	label = "";
	const char *name = NULL;
	bool bySlot = false, hasLabel = false;
	int selectors = 0;
	for ( int i = first; i < argv.argc(); i++ )
	{
		const char *a = argv[i];
		bool ok = true;
		if ( strncmp( a, "map=", 4 ) == 0 ) { name = a + 4; ref.kind = MCP_REF_SCALAR; selectors++; ok = *name != 0; }
		else if ( strncmp( a, "world=", 6 ) == 0 ) { ref.kind = MCP_REF_WORLD; selectors++; ok = MCP_ParseInt( a + 6, ref.num ); }
		else if ( strncmp( a, "global=", 7 ) == 0 ) { ref.kind = MCP_REF_GLOBAL; selectors++; ok = MCP_ParseInt( a + 7, ref.num ); }
		else if ( strncmp( a, "slot=", 5 ) == 0 ) { bySlot = true; ref.kind = MCP_REF_SCALAR; selectors++; ok = MCP_ParseInt( a + 5, ref.num ); }
		else if ( strncmp( a, "index=", 6 ) == 0 ) ok = MCP_ParseInt( a + 6, ref.index ) && ref.index >= 0;
		else if ( strncmp( a, "label=", 6 ) == 0 ) { label = a + 6; hasLabel = true; }
		else if ( strncmp( a, "v=", 2 ) && strncmp( a, "code=", 5 ) && strncmp( a, "first=", 6 ) && strncmp( a, "md5=", 4 ) ) ok = false;
		if ( !ok ) { err = usage; return false; }
	}
	if ( selectors != 1 ) { err = usage; return false; }
	// Digest tokens only make sense for a slot selector.
	if ( !bySlot ) for ( int i = first; i < argv.argc(); i++ )
		if ( !strncmp( argv[i], "v=", 2 ) || !strncmp( argv[i], "code=", 5 ) || !strncmp( argv[i], "first=", 6 ) || !strncmp( argv[i], "md5=", 4 ) ) { err = usage; return false; }
	if ( ref.kind == MCP_REF_WORLD || ref.kind == MCP_REF_GLOBAL )
	{
		const bool world = ref.kind == MCP_REF_WORLD;
		if ( ref.num < 0 || ref.num >= ( world ? NUM_WORLDVARS : NUM_GLOBALVARS ) ) { err = "var out of range"; return false; }
		if ( !hasLabel ) label.Format( "%s[%d]", world ? "world" : "global", ref.num );
		if ( !hasLabel && ref.index >= 0 ) label.AppendFormat( "[%d]", ref.index );
		return true;
	}
	FBehavior *m = NULL;
	if ( bySlot )
	{
		MCPMapSlotArgs args;
		if ( !MCP_MapSlotResolve( argv, first, ref.num, false, true, usage, args, err ) ) return false;
		m = args.module;
		ref.module = args.at;
		ref.index = args.index;
		if ( !hasLabel ) label.Format( "slot%d", ref.num );
	}
	else
	{
		m = MCP_FindModule( name, ref.num, false );
		if ( m == NULL ) { err.Format( "mapvar %s not found", name ); return false; }
		for ( int i = 0; MCP_AcsRefModule( i ) != NULL; i++ ) if ( MCP_AcsRefModule( i ) == m ) { ref.module = i; break; }
		if ( !hasLabel ) { label = name; if ( ref.index >= 0 ) label.AppendFormat( "[%d]", ref.index ); }
	}
	if ( ref.num < 0 || ref.num >= NUM_MAPVARS || m->MapVars[ref.num] == NULL ) { err = "slot out of range or unbound"; return false; }
	const int size = MCP_AcsRefArraySize( m, ref.num );
	if ( ref.index >= 0 )
	{
		if ( size < 0 ) { err = "slot is not an array in ARAY"; return false; }
		if ( ref.index >= size ) { err = "index out of range"; return false; }
		ref.kind = MCP_REF_ARRAY;
	}
	else if ( size >= 0 ) { err = "array requires index"; return false; }
	ref.behavior = m;
	return true;
}

bool MCP_AcsRefRead( const MCPAcsRef &ref, int &value )
{
	if ( gamestate != GS_LEVEL ) return false;
	if ( ref.kind == MCP_REF_WORLD || ref.kind == MCP_REF_GLOBAL )
	{
		const bool world = ref.kind == MCP_REF_WORLD;
		if ( ref.num < 0 || ref.num >= ( world ? NUM_WORLDVARS : NUM_GLOBALVARS ) || ref.index < -1 ) return false;
		if ( ref.index < 0 ) value = world ? ACS_WorldVars[ref.num] : ACS_GlobalVars[ref.num];
		else
		{
			const int *v = world ? ACS_WorldArrays[ref.num].CheckKey( ref.index ) : ACS_GlobalArrays[ref.num].CheckKey( ref.index );
			value = v != NULL ? *v : 0;
		}
		return true;
	}
	if ( ref.kind != MCP_REF_SCALAR && ref.kind != MCP_REF_ARRAY ) return false;
	if ( ref.module < 0 || ref.num < 0 || ref.num >= NUM_MAPVARS ) return false;
	FBehavior *m = MCP_AcsRefModule( ref.module );
	// Never dereference the stored pointer: the module may have been torn down since Parse.
	if ( m == NULL || m != ref.behavior || m->MapVars[ref.num] == NULL ) return false;
	if ( ref.kind == MCP_REF_ARRAY )
	{
		if ( ref.index < 0 || ref.index >= MCP_AcsRefArraySize( m, ref.num ) ) return false;
		value = m->GetArrayVal( *m->MapVars[ref.num], ref.index );
	}
	else value = *m->MapVars[ref.num];
	return true;
}
// ==== end MCP_ACSREF ====
