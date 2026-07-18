//
// mcp_crash.cpp -- crash backtrace handler for the MCP bridge (overlay file).
//
// GENERIC: this is part of the engine-bridge overlay, applied by apply-bridge to
// ANY Zandronum source tree (stock or fork). It is not specific to any fork.
//
// On a fatal signal (SIGSEGV/SIGABRT/SIGBUS/SIGILL/SIGFPE on POSIX, or an
// unhandled SEH exception on Windows) it writes the signal, faulting address,
// and a symbolized backtrace to a crash-log file, then lets the process die
// normally (so the socket bridge closes and the MCP notices). The MCP
// `get_crash` tool reads that file back.
//
// Opt-in: like the rest of the bridge, it only arms when ZANDRONUM_BRIDGE_PORT
// is set, so a normal (non-MCP) launch is completely unaffected.
//
// Includes NO engine headers (mirrors mcp_bridge.cpp) so platform system headers
// never clash with the engine's types.
//
#include "mcp_bridge.h"

#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
  #include <windows.h>
  #include <dbghelp.h>
  #pragma comment(lib, "dbghelp.lib")   // MSVC-only; ignored by GCC/Clang
#else
  #include <signal.h>
  #include <unistd.h>
  #include <fcntl.h>
  #include <execinfo.h>
#endif

namespace
{
	char g_crashPath[1024] = { 0 };
	bool g_installed = false;

	// Resolve where to write the crash log: an explicit ZANDRONUM_CRASH_LOG wins;
	// otherwise derive it from ZANDRONUM_BRIDGE_LOG (<log>.crash); otherwise fall
	// back to a file in the current directory so a crash is never lost.
	void ResolveCrashPath()
	{
		const char *p = getenv( "ZANDRONUM_CRASH_LOG" );
		if ( p && p[0] )
		{
			strncpy( g_crashPath, p, sizeof( g_crashPath ) - 1 );
			return;
		}
		const char *log = getenv( "ZANDRONUM_BRIDGE_LOG" );
		if ( log && log[0] )
		{
			snprintf( g_crashPath, sizeof( g_crashPath ), "%s.crash", log );
			return;
		}
		strncpy( g_crashPath, "zandronum-crash.log", sizeof( g_crashPath ) - 1 );
	}

#ifdef _WIN32
	// Unhandled-exception filter: capture and symbolize the stack, write it out,
	// then let the OS continue the normal crash path.
	LONG WINAPI MCP_CrashFilter( EXCEPTION_POINTERS *info )
	{
		FILE *f = fopen( g_crashPath, "w" );
		if ( f )
		{
			fprintf( f, "=== MCP ENGINE CRASH ===\ncode: 0x%08lx\nfault_addr: %p\npid: %lu\n\nbacktrace:\n",
				(unsigned long)( info ? info->ExceptionRecord->ExceptionCode : 0 ),
				info ? (void *)info->ExceptionRecord->ExceptionAddress : (void *)0,
				(unsigned long)GetCurrentProcessId() );

			void *frames[128];
			USHORT n = CaptureStackBackTrace( 0, 128, frames, NULL );

			HANDLE proc = GetCurrentProcess();
			SymSetOptions( SYMOPT_UNDNAME | SYMOPT_DEFERRED_LOADS );
			SymInitialize( proc, NULL, TRUE );

			char symbuf[sizeof( SYMBOL_INFO ) + 256];
			SYMBOL_INFO *sym = (SYMBOL_INFO *)symbuf;
			sym->SizeOfStruct = sizeof( SYMBOL_INFO );
			sym->MaxNameLen = 255;

			for ( USHORT i = 0; i < n; ++i )
			{
				DWORD64 addr = (DWORD64)(uintptr_t)frames[i];
				if ( SymFromAddr( proc, addr, 0, sym ) )
					fprintf( f, "  #%u %s + 0x%llx  [0x%p]\n", i, sym->Name,
						(unsigned long long)( addr - sym->Address ), frames[i] );
				else
					fprintf( f, "  #%u [0x%p]\n", i, frames[i] );
			}
			fflush( f );
			fclose( f );
		}
		return EXCEPTION_CONTINUE_SEARCH; // let the process crash as usual
	}
#else
	const char *SignalName( int sig )
	{
		switch ( sig )
		{
			case SIGSEGV: return "SIGSEGV (segmentation fault)";
			case SIGABRT: return "SIGABRT (abort)";
			case SIGBUS:  return "SIGBUS (bus error)";
			case SIGILL:  return "SIGILL (illegal instruction)";
			case SIGFPE:  return "SIGFPE (floating point exception)";
			default:      return "signal";
		}
	}

	// Signal handler. Kept close to async-signal-safe: open()/write() are safe,
	// and backtrace_symbols_fd() writes without malloc. backtrace() itself is
	// warmed up at install time so it does no lazy dlopen/allocation here.
	void CrashHandler( int sig, siginfo_t *si, void *ucontext )
	{
		(void)ucontext;
		int fd = open( g_crashPath, O_WRONLY | O_CREAT | O_TRUNC, 0644 );
		if ( fd >= 0 )
		{
			char hdr[256];
			int n = snprintf( hdr, sizeof( hdr ),
				"=== MCP ENGINE CRASH ===\nsignal: %d %s\nfault_addr: %p\npid: %d\n\nbacktrace:\n",
				sig, SignalName( sig ), si ? si->si_addr : (void *)0, (int)getpid() );
			if ( n > 0 )
			{
				ssize_t w = write( fd, hdr, (size_t)n );
				(void)w;
			}
			void *frames[128];
			int nf = backtrace( frames, 128 );
			backtrace_symbols_fd( frames, nf, fd );
			close( fd );
		}
		// Restore the default handler and re-raise so the process dies normally
		// (core dump / abort), which closes the bridge socket for the MCP.
		signal( sig, SIG_DFL );
		raise( sig );
	}
#endif
}

// Arm the crash handler once. Safe to call repeatedly (cheap no-op after the
// first). No-op unless the bridge is opted in via ZANDRONUM_BRIDGE_PORT.
void MCP_Crash_Init()
{
	if ( g_installed ) return;
	const char *port = getenv( "ZANDRONUM_BRIDGE_PORT" );
	if ( port == NULL || port[0] == '\0' ) return; // opt-in, same gate as the bridge
	g_installed = true;
	ResolveCrashPath();

#ifdef _WIN32
	SetUnhandledExceptionFilter( MCP_CrashFilter );
#else
	// Warm up the unwinder so the handler does no lazy work.
	void *warm[4];
	(void)backtrace( warm, 4 );

	struct sigaction sa;
	memset( &sa, 0, sizeof( sa ) );
	sa.sa_sigaction = CrashHandler;
	sa.sa_flags = SA_SIGINFO;
	sigemptyset( &sa.sa_mask );

	int sigs[] = { SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE };
	for ( unsigned i = 0; i < sizeof( sigs ) / sizeof( sigs[0] ); ++i )
		sigaction( sigs[i], &sa, NULL );
#endif
}
