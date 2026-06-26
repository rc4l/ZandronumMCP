//
// mcp_hud.cpp -- read-only capture of what the engine paints on screen (overlay).
//
// Two tees mirror the console-output tee in mcp_bridge.cpp:
//   * DrawTextV   -> every HUD string (strparam already resolved at draw time)
//   * DrawTexture -> every HUD image, by texture name (font glyphs filtered out)
// Both funnels are non-virtual DCanvas methods, so they fire under the software
// and OpenGL renderers alike. Plus dumphud walks the active ACS HudMessages for
// their full composed SourceText. Capture is double-buffered: the tees fill the
// current frame, the bridge poll swaps it to "last" once per frame, and dumphud
// reports "last" -- the most recently completed frame.
//
#include "doomtype.h"
#include "c_dispatch.h"
#include "zstring.h"
#include "v_text.h"
#include "textures/textures.h"
#include "g_shared/sbar.h"
#include "mcp_hud.h"

static FString g_curHud, g_lastHud;

// Append a string with color escapes stripped and control chars flattened to
// spaces, so each capture stays on one parseable line.
static void MCP_AppendSanitized( FString &out, const char *s )
{
	if ( s == NULL ) return;
	for ( const char *p = s; *p != '\0'; ++p )
	{
		BYTE c = (BYTE)*p;
		if ( c == TEXTCOLOR_ESCAPE ) { if ( p[1] != '\0' ) ++p; continue; } // skip escape + its color arg
		out += ( c < 0x20 ) ? ' ' : (char)c;
	}
}

void MCP_HUD_TeeText( int x, int y, const char *string )
{
	if ( string == NULL || g_curHud.Len() > 32000 ) return;
	g_curHud.AppendFormat( "text %d %d ", x, y );
	MCP_AppendSanitized( g_curHud, string );
	g_curHud += '\n';
}

void MCP_HUD_TeeTexture( double x, double y, FTexture *img )
{
	if ( img == NULL || g_curHud.Len() > 32000 ) return;
	if ( img->UseType == FTexture::TEX_FontChar || img->UseType == FTexture::TEX_Null ) return;
	if ( img->Name[0] == '\0' ) return; // generated/unnamed texture -- nothing to report
	g_curHud.AppendFormat( "image %d %d %.8s\n", (int)x, (int)y, img->Name );
}

void MCP_HUD_BeginFrame()
{
	g_lastHud = g_curHud;
	g_curHud = "";
}

// DBaseStatusBar member (declared via the sbar.h anchor): it is the friend that
// can read DHUDMessage's private SourceText / Next.
void DBaseStatusBar::MCP_DumpMessages()
{
	for ( size_t layer = 0; layer < NUM_HUDMSGLAYERS; ++layer )
	{
		for ( DHUDMessage *msg = Messages[layer]; msg != NULL; msg = msg->Next )
		{
			FString line;
			line.AppendFormat( "msg %d %.3f %.3f %d ", (int)layer, msg->Left, msg->Top, msg->Tics );
			MCP_AppendSanitized( line, msg->SourceText );
			Printf( "%s\n", line.GetChars() );
		}
	}
}

CCMD( dumphud )
{
	Printf( "MCP_HUD\n" );
	Printf( "%s", g_lastHud.GetChars() );
	if ( StatusBar != NULL ) StatusBar->MCP_DumpMessages();
}
