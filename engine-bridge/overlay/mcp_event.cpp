//
// mcp_event.cpp -- posts a synthetic input event into the engine.
//
// Overlay file (copied into src/zandronum/src/ by apply-bridge). Kept apart from
// mcp_bridge.cpp because this needs the engine headers (event_t, D_PostEvent)
// while the bridge keeps its socket/Windows headers isolated; mixing the two
// translation units' headers is a recipe for type clashes. mcp_bridge.cpp calls
// MCP_PostInputEvent() via a forward declaration.
//
// The body is plain portable engine C++ (no platform calls), so it builds on
// Windows, Linux, and macOS alike.
//
#include <string.h>
#include "doomtype.h"
#include "d_event.h"

void MCP_PostInputEvent( int type, int subtype, int data1, int data2 )
{
	event_t ev;
	memset( &ev, 0, sizeof( ev ) );
	ev.type = (BYTE)type;
	ev.subtype = (BYTE)subtype;
	ev.data1 = (SWORD)data1;
	ev.data2 = (SWORD)data2;
	D_PostEvent( &ev );
}
