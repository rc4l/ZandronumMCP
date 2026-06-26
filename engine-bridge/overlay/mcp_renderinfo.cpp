//
// mcp_renderinfo.cpp -- console command dumping renderer / video / HUD state
// (overlay file). Read-only inspection: active backend, GL info, screen size,
// 3D viewport rect, status bar Y, plus a few render/HUD cvars. Output is one
// key=value per line (values may contain spaces), captured by the MCP bridge.
//
// Groundwork for renderer/UI inspection and splitscreen development -- the
// renderer is already per-player (Renderer->RenderView(player)), so observing
// the viewport rect + backend is what a future split-view loop needs to verify.
//
#include "doomtype.h"
#include "c_dispatch.h"
#include "c_cvars.h"
#include "v_video.h"
#include "r_main.h"
#include "r_state.h"
#include "st_stuff.h"
#include "gl/system/gl_interface.h"

extern int currentrenderer;

static void PrintCVar( const char *name )
{
	FBaseCVar *cvar = FindCVar( name, NULL );
	if ( cvar != NULL )
		Printf( "%s=%s\n", name, cvar->GetGenericRep( CVAR_String ).String );
}

CCMD( dumprenderer )
{
	Printf( "MCP_RENDERER\n" );
	Printf( "renderer=%s\n", currentrenderer == 1 ? "opengl" : "software" );

	if ( screen != NULL )
	{
		Printf( "screen_width=%d\n", screen->GetWidth() );
		Printf( "screen_height=%d\n", screen->GetHeight() );
	}

	Printf( "view_x=%d\n", viewwindowx );
	Printf( "view_y=%d\n", viewwindowy );
	Printf( "view_width=%d\n", viewwidth );
	Printf( "view_height=%d\n", viewheight );
	Printf( "statusbar_y=%d\n", ST_Y );

	if ( currentrenderer == 1 && gl.vendorstring != NULL )
	{
		Printf( "gl_vendor=%s\n", gl.vendorstring );
		Printf( "gl_shadermodel=%u\n", gl.shadermodel );
		Printf( "gl_maxtexsize=%d\n", gl.max_texturesize );
	}

	static const char *const cvars[] = {
		"vid_renderer", "fullscreen", "vid_vsync", "vid_defwidth", "vid_defheight",
		"screenblocks", "st_scale", "hud_scale", "hud_althud", "crosshair", NULL
	};
	for ( int i = 0; cvars[i] != NULL; i++ )
		PrintCVar( cvars[i] );
}
