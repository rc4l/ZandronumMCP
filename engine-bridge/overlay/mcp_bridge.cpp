//
// mcp_bridge.cpp -- minimal local IPC seam (overlay file; see mcp_bridge.h).
//
// v0 seam: one loopback TCP client, NDJSON, hello + cmd + out. Hardening TODOs
// are noted inline (multi-client, locking around the client socket, reconnect).
//
// Cross-platform: the same implementation runs on Windows (Winsock) and on
// POSIX (BSD sockets). Only the socket primitives differ; they are bridged by
// the typedefs/macros below. Threading and locking use the C++ standard library
// so there is a single code path on every platform.
//
#include "mcp_bridge.h"

// --- Portable socket shim ---------------------------------------------------
// This file deliberately includes NO engine headers (it forward-declares the few
// engine entry points it needs), so the platform networking headers never clash
// with the engine's types.
#ifdef _WIN32
  #include <winsock2.h>
  #include <ws2tcpip.h>
  typedef SOCKET mcp_socket_t;
  #define MCP_INVALID_SOCKET INVALID_SOCKET
  #define mcp_close_socket   closesocket
  #pragma comment(lib, "ws2_32.lib")   // MSVC-only directive; ignored by GCC/Clang
#else
  #include <sys/socket.h>
  #include <netinet/in.h>
  #include <arpa/inet.h>
  #include <unistd.h>
  typedef int mcp_socket_t;
  #define MCP_INVALID_SOCKET (-1)
  #define mcp_close_socket   ::close
#endif

#include <thread>
#include <mutex>
#include <chrono>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <string>
#include <deque>

// Hand a command to the engine's console dispatcher, exactly like the dedicated
// server does for stdin. Forward-declared to avoid pulling in c_dispatch.h.
void AddCommandString(char *text, int keynum);

// The engine's global pause flag (defined in g_game.cpp). The MCP drives it
// directly so a backgrounded, defocused window can keep advancing tics — vital
// for automated testing, because single-player auto-pauses on focus loss
// (S_SetSoundPaused in i_input.cpp forces `paused = -1`, with no cvar to opt out).
extern int paused;

// Post a synthetic input event (implemented in mcp_event.cpp, which owns the
// engine-header includes so this socket TU doesn't have to).
void MCP_PostInputEvent( int type, int subtype, int data1, int data2 );

// Snapshot the just-drawn HUD frame (implemented in mcp_hud.cpp).
void MCP_HUD_BeginFrame();

namespace
{
	// One queued inbound message: either a console command or an input event.
	struct InboundMsg
	{
		bool        isEvent;
		bool        isPause;               // setpause control (isPause == true)
		int         pauseVal;              // target value for the engine `paused` flag
		std::string text;                  // command text (isEvent == false)
		int         evtype, subtype, d1, d2; // event fields (isEvent == true)
	};

	bool             g_initialized = false;
	bool             g_enabled     = false;
	mcp_socket_t     g_listen      = MCP_INVALID_SOCKET;
	mcp_socket_t     g_client      = MCP_INVALID_SOCKET;
	std::mutex       g_lock;
	std::deque<InboundMsg> g_inbound;  // messages awaiting the game thread
	std::string      g_rxbuf;          // partial inbound line buffer

	// Extract an integer JSON field ("key":N) from a single line. Minimal.
	bool ExtractInt( const std::string &line, const char *key, int &out )
	{
		std::string k = std::string( "\"" ) + key + "\"";
		size_t p = line.find( k );
		if ( p == std::string::npos ) return false;
		size_t colon = line.find( ':', p + k.size() );
		if ( colon == std::string::npos ) return false;
		size_t i = colon + 1;
		while ( i < line.size() && line[i] == ' ' ) ++i;
		bool neg = false;
		if ( i < line.size() && line[i] == '-' ) { neg = true; ++i; }
		if ( i >= line.size() || line[i] < '0' || line[i] > '9' ) return false;
		long v = 0;
		while ( i < line.size() && line[i] >= '0' && line[i] <= '9' )
		{
			v = v * 10 + ( line[i] - '0' );
			++i;
		}
		out = (int)( neg ? -v : v );
		return true;
	}

	int BridgePort()
	{
		const char *env = getenv( "ZANDRONUM_BRIDGE_PORT" );
		if ( env == NULL || env[0] == '\0' )
			return 0; // disabled / opt-in
		int port = atoi( env );
		return ( port > 0 && port < 65536 ) ? port : 0;
	}

	// Extract the value of the JSON "text" field from a single-line command.
	// Deliberately minimal: assumes the MCP sends well-formed single-line JSON.
	bool ExtractText( const std::string &line, std::string &out )
	{
		size_t k = line.find( "\"text\"" );
		if ( k == std::string::npos ) return false;
		size_t colon = line.find( ':', k );
		if ( colon == std::string::npos ) return false;
		size_t q1 = line.find( '"', colon );
		if ( q1 == std::string::npos ) return false;
		out.clear();
		for ( size_t i = q1 + 1; i < line.size(); ++i )
		{
			char c = line[i];
			if ( c == '\\' && i + 1 < line.size() )
			{
				char n = line[++i];
				switch ( n )
				{
					case 'n':  out.push_back( '\n' ); break;
					case 't':  out.push_back( '\t' ); break;
					case '"':  out.push_back( '"' );  break;
					case '\\': out.push_back( '\\' ); break;
					default:   out.push_back( n );    break;
				}
			}
			else if ( c == '"' )
			{
				return true; // closing quote
			}
			else
			{
				out.push_back( c );
			}
		}
		return false;
	}

	void JsonEscape( const char *in, std::string &out )
	{
		out.clear();
		for ( const char *p = in; *p; ++p )
		{
			unsigned char c = (unsigned char)*p;
			switch ( c )
			{
				case '"':  out += "\\\""; break;
				case '\\': out += "\\\\"; break;
				case '\n': out += "\\n";  break;
				case '\r': break; // drop CR
				case '\t': out += "\\t";  break;
				default:
					if ( c < 0x20 ) { char b[8]; sprintf( b, "\\u%04x", c ); out += b; }
					else out.push_back( (char)c );
			}
		}
	}

	void SendLine( const std::string &json )
	{
		mcp_socket_t s = g_client;
		if ( s == MCP_INVALID_SOCKET ) return;
		std::string wire = json;
		wire.push_back( '\n' );
		if ( send( s, wire.c_str(), (int)wire.size(), 0 ) < 0 )
		{
			mcp_close_socket( s );
			g_client = MCP_INVALID_SOCKET;
		}
	}

	// Append one console line to the startup logfile if ZANDRONUM_BRIDGE_LOG is set.
	// Opened lazily on the first console output -- which happens during early startup
	// (DECORATE/ACS parsing), BEFORE the socket bridge is up -- so this captures the
	// compile/fatal errors that abort the engine before any MCP client can connect.
	void LogWrite( const char *text )
	{
		static bool  checked = false;
		static FILE *logf    = NULL;
		if ( !checked )
		{
			checked = true;
			const char *path = getenv( "ZANDRONUM_BRIDGE_LOG" );
			if ( path && path[0] ) logf = fopen( path, "w" );
		}
		if ( logf )
		{
			fputs( text, logf );
			fflush( logf ); // per-line flush so a crash still leaves the error on disk
		}
	}

	void ListenThread()
	{
		for ( ;; )
		{
			mcp_socket_t s = accept( g_listen, NULL, NULL );
			if ( s == MCP_INVALID_SOCKET )
			{
				std::this_thread::sleep_for( std::chrono::milliseconds( 50 ) );
				continue;
			}

			// One client at a time; replace any previous.
			{
				std::lock_guard<std::mutex> lk( g_lock );
				if ( g_client != MCP_INVALID_SOCKET ) mcp_close_socket( g_client );
				g_client = s;
				g_rxbuf.clear();
			}

			SendLine( "{\"v\":1,\"t\":\"hello\",\"engine\":\"zandronum\",\"bridge\":\"0.3.0\",\"caps\":[\"cmd\",\"event\",\"time\"]}" );

			char buf[1024];
			for ( ;; )
			{
				int n = (int)recv( s, buf, sizeof( buf ), 0 );
				if ( n <= 0 ) break;
				std::lock_guard<std::mutex> lk( g_lock );
				g_rxbuf.append( buf, n );
				size_t nl;
				while ( ( nl = g_rxbuf.find( '\n' ) ) != std::string::npos )
				{
					std::string line = g_rxbuf.substr( 0, nl );
					g_rxbuf.erase( 0, nl + 1 );

					if ( line.find( "\"t\":\"setpause\"" ) != std::string::npos )
					{
						InboundMsg msg;
						msg.isEvent = false;
						msg.isPause = true;
						msg.pauseVal = 0;
						msg.evtype = msg.subtype = msg.d1 = msg.d2 = 0;
						ExtractInt( line, "paused", msg.pauseVal );
						g_inbound.push_back( msg );
					}
					else if ( line.find( "\"t\":\"event\"" ) != std::string::npos )
					{
						InboundMsg msg;
						msg.isEvent = true;
						msg.isPause = false;
						msg.evtype = msg.subtype = msg.d1 = msg.d2 = 0;
						ExtractInt( line, "evtype", msg.evtype );
						ExtractInt( line, "subtype", msg.subtype );
						ExtractInt( line, "data1", msg.d1 );
						ExtractInt( line, "data2", msg.d2 );
						g_inbound.push_back( msg );
					}
					else
					{
						std::string text;
						if ( ExtractText( line, text ) && !text.empty() )
						{
							InboundMsg msg;
							msg.isEvent = false;
							msg.isPause = false;
							msg.text = text;
							msg.evtype = msg.subtype = msg.d1 = msg.d2 = 0;
							g_inbound.push_back( msg );
						}
					}
				}
			}

			if ( g_client == s ) g_client = MCP_INVALID_SOCKET;
			mcp_close_socket( s );
		}
	}

	void Init()
	{
		g_initialized = true;
		int port = BridgePort();
		if ( port == 0 ) return; // opt-in: only runs with ZANDRONUM_BRIDGE_PORT set

#ifdef _WIN32
		WSADATA wsa;
		if ( WSAStartup( MAKEWORD( 2, 2 ), &wsa ) != 0 ) return;
#endif

		g_listen = socket( AF_INET, SOCK_STREAM, IPPROTO_TCP );
		if ( g_listen == MCP_INVALID_SOCKET ) return;

		int yes = 1;
		setsockopt( g_listen, SOL_SOCKET, SO_REUSEADDR, (const char *)&yes, sizeof( yes ) );

		sockaddr_in addr;
		memset( &addr, 0, sizeof( addr ) );
		addr.sin_family = AF_INET;
		addr.sin_port = htons( (unsigned short)port );
		inet_pton( AF_INET, "127.0.0.1", &addr.sin_addr ); // loopback only

		if ( bind( g_listen, (sockaddr *)&addr, sizeof( addr ) ) < 0 ||
			 listen( g_listen, 1 ) < 0 )
		{
			mcp_close_socket( g_listen );
			g_listen = MCP_INVALID_SOCKET;
			return;
		}

		std::thread( ListenThread ).detach();
		g_enabled = true;
	}
}

void MCP_Bridge_Poll()
{
	MCP_Crash_Init(); // belt-and-suspenders: also arm from the frame loop (idempotent)
	if ( !g_initialized ) Init();
	if ( !g_enabled ) return;

	MCP_HUD_BeginFrame(); // snapshot the frame the engine just drew

	for ( ;; )
	{
		InboundMsg msg;
		bool have = false;
		{
			std::lock_guard<std::mutex> lk( g_lock );
			if ( !g_inbound.empty() ) { msg = g_inbound.front(); g_inbound.pop_front(); have = true; }
		}
		if ( !have ) break;
		if ( msg.isPause )
			paused = msg.pauseVal;
		else if ( msg.isEvent )
			MCP_PostInputEvent( msg.evtype, msg.subtype, msg.d1, msg.d2 );
		else
			AddCommandString( const_cast<char *>( msg.text.c_str() ), 0 );
	}
}

void MCP_Bridge_TeeOutput( const char *text )
{
	if ( text == NULL ) return;
	MCP_Crash_Init(); // arm the crash handler as early as the first console line (idempotent)
	LogWrite( text ); // capture to the startup logfile even before the bridge is up
	if ( !g_enabled || g_client == MCP_INVALID_SOCKET ) return;
	std::string esc;
	JsonEscape( text, esc );
	std::string json = "{\"v\":1,\"t\":\"out\",\"level\":0,\"text\":\"";
	json += esc;
	json += "\"}";
	SendLine( json );
}

void MCP_Bridge_Shutdown()
{
	if ( g_client != MCP_INVALID_SOCKET ) { mcp_close_socket( g_client ); g_client = MCP_INVALID_SOCKET; }
	if ( g_listen != MCP_INVALID_SOCKET ) { mcp_close_socket( g_listen ); g_listen = MCP_INVALID_SOCKET; }
}
