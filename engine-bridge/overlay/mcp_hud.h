//
// mcp_hud.h -- capture what the engine paints on screen (overlay file).
//
#ifndef MCP_HUD_H
#define MCP_HUD_H

class FTexture;

// Tees, called from the engine's draw funnels (anchored inserts).
void MCP_HUD_TeeText( int x, int y, const char *string );
void MCP_HUD_TeeTexture( double x, double y, FTexture *img );

// Snapshot the frame just drawn (called once per frame from the bridge poll).
void MCP_HUD_BeginFrame();

#endif
