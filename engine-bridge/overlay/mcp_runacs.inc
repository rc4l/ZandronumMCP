// ==== MCP_RUNACS (overlay-appended to p_acs.cpp; not committed upstream) ====
// Hot-load a compiled ACS object as a temporary module in the current level and
// optionally start one of its scripts, or run a loaded one (offline only; here for the file-static P_GetScriptGoing).
static int MCP_RunAcsSerial = 0;

static unsigned MCP_RunAcsModuleCount()
{
	unsigned n = 0;
	while ( FBehavior::StaticGetModule( n ) != NULL ) n++;
	return n;
}

// A script given as a number, else as a name, numbered the way ACS names are.
int MCP_ScriptNumber( const char *script )
{
	char *end;
	long v = strtol( script, &end, 10 );
	return *end == 0 ? (int)v : -FName( script );
}

// A script number written as plain digits and above 0 (0 is reserved, as puke has it), else 0.
static int MCP_PlainScriptNumber( const char *script )
{
	size_t len = strlen( script );
	if ( len < 1 || len > 9 || strspn( script, "0123456789" ) != len ) return 0;
	return atoi( script );
}

// mcp_runacs <path> [script] [args...] [name=1] [open=1]
// Reply: MCP_RUNACS module=<index> scripts=<n> started=<script|none> deferred=<0|1>
// deferred=1 means the snippet holds DEATH/ENTER/RESPAWN/... scripts that fire later.
CCMD( mcp_runacs )
{
	if ( argv.argc() < 2 ) { Printf( "error usage: mcp_runacs <path> [script] [args...] [name=1] [open=1]\n" ); return; }
	if ( NETWORK_GetState() == NETSTATE_SERVER || NETWORK_InClientMode() ) { Printf( "error netgame\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }

	bool open = false, named = false;
	const char *script = NULL;
	int args[4] = { 0, 0, 0, 0 };
	int nargs = 0;
	for ( int i = 2; i < argv.argc(); i++ )
	{
		if ( strcmp( argv[i], "open=1" ) == 0 ) open = true;
		else if ( strcmp( argv[i], "name=1" ) == 0 ) named = true;
		else if ( script == NULL ) script = argv[i];
		else if ( nargs < 4 ) args[nargs++] = atoi( argv[i] );
		else { Printf( "error at most 4 script args\n" ); return; }
	}
	int num = script == NULL ? 0 : named ? -FName( script ) : MCP_ScriptNumber( script );

	FileReader fr;
	if ( !fr.Open( argv[1] ) ) { Printf( "error cannot open %s\n", argv[1] ); return; }

	unsigned before = MCP_RunAcsModuleCount();
	// A fresh LumpNum <= -2 (what mcp_status counts as acstemp=), since StaticLoadModule
	// returns any module whose LumpNum matches and the map's own BEHAVIOR is -1.
	FBehavior *b = new FBehavior( -2 - MCP_RunAcsSerial++, &fr, (int)fr.GetLength() );
	// Every refusal below leaves an inert module loaded until the map changes: the
	// constructor registers it before validating, and StaticModules is private.
	if ( MCP_RunAcsModuleCount() != before + 1 )
	{
		Printf( "error imports a library that is not loaded in this level (modules left loaded until the map changes)\n" );
		return;
	}
	if ( !b->IsGood() )
	{
		Printf( "error bad module (not an ACS object, unresolved import or import mismatch; inert module %u left loaded)\n", before );
		return;
	}

	const ScriptPtr *code = NULL;
	if ( script != NULL && ( code = b->FindScript( num ) ) == NULL )
	{
		Printf( "error no script %s in the snippet (module %u left loaded, unstarted)\n", script, before );
		return;
	}

	int nscripts = 0;
	bool deferred = false;
	for ( const ScriptPtr *p; ( p = b->GetScriptPtr( nscripts ) ) != NULL; nscripts++ )
	{
		if ( p->Type != SCRIPT_Closed && p->Type != SCRIPT_Open ) deferred = true;
	}

	// Run inside this call (as runNow does) so Log() lands in the reply; offline the
	// console player is never predicted, so no unpredict is needed.
	AActor *activator = playeringame[consoleplayer] ? players[consoleplayer].mo : NULL;
	{
		MCPBridgeReplySuspendGuard gameOutput;
		if ( open ) b->StartTypedScripts( SCRIPT_Open, NULL, false, 0, true );
		if ( code != NULL )
		{
			DLevelScript *s = P_GetScriptGoing( activator, NULL, num, code, b, args, nargs, ACS_ALWAYS );
			if ( s != NULL ) s->RunScript();
		}
	}

	Printf( "MCP_RUNACS module=%u scripts=%d started=%s deferred=%d\n",
		before, nscripts, script != NULL ? script : "none", deferred ? 1 : 0 );
}

// mcp_runscript <script> [always=1] [name=1] [args...]
// Reply: MCP_RUNSCRIPT script=<s> started=<0|1> result=<n> finished=<0|1> module=<index>
// Runs a loaded script inside the call until its first delay, as ACS_ExecuteWithResult does.
CCMD( mcp_runscript )
{
	if ( argv.argc() < 2 ) { Printf( "error usage: mcp_runscript <script> [always=1] [name=1] [args...]\n" ); return; }
	if ( NETWORK_GetState() == NETSTATE_SERVER || NETWORK_InClientMode() ) { Printf( "error netgame\n" ); return; }
	if ( gamestate != GS_LEVEL ) { Printf( "error not in a level\n" ); return; }

	bool always = false, named = false;
	int first = 2;
	for ( ; first < argv.argc(); first++ )
	{
		if ( strcmp( argv[first], "always=1" ) == 0 ) always = true;
		else if ( strcmp( argv[first], "name=1" ) == 0 ) named = true;
		else break;
	}
	int args[4] = { 0, 0, 0, 0 };
	int nargs = argv.argc() - first;
	if ( nargs > 4 ) { Printf( "error at most 4 script args\n" ); return; }
	for ( int i = 0; i < nargs; i++ ) args[i] = atoi( argv[first + i] );

	int num = named ? -FName( argv[1] ) : MCP_PlainScriptNumber( argv[1] );
	if ( !named && num == 0 ) { Printf( "error script wants a number above 0, or name=1 with a name\n" ); return; }
	// The first loaded module that has the script, as ACS_Execute finds it.
	FBehavior *module = NULL;
	const ScriptPtr *code = num != 0 ? FBehavior::StaticFindScript( num, module ) : NULL;
	if ( code == NULL ) { Printf( "error no script %s\n", argv[1] ); return; }

	// NULL when a copy is running and always=1 was not given (a suspended one resumes instead).
	AActor *activator = playeringame[consoleplayer] ? players[consoleplayer].mo : NULL;
	DLevelScript *s = P_GetScriptGoing( activator, NULL, num, code, module, args, nargs, always ? ACS_ALWAYS : 0 );
	int result = 0;
	bool finished = false;
	if ( s != NULL )
	{
		MCPBridgeReplySuspendGuard gameOutput;
		result = s->RunScript();
		// A finished script is only unlinked by RunScript, so its state is still readable.
		finished = s->GetState() == DLevelScript::SCRIPT_PleaseRemove;
	}
	Printf( "MCP_RUNSCRIPT script=%s started=%d result=%d finished=%d module=%d\n",
		argv[1], s != NULL ? 1 : 0, result, finished ? 1 : 0, module->GetLibraryID() >> LIBRARYID_SHIFT );
}
// ==== end MCP_RUNACS ====
