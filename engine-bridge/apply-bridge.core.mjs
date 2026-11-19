//
// apply-bridge.core.mjs -- logic for applying the MCP engine bridge overlay to a
// Zandronum source tree. fs-backed helpers, unit-tested at 100%. The runnable CLI
// is apply-bridge.mjs, which just parses argv and calls applyBridge().
//
// Strategy (see anchors.md + the project README):
//   * NEW files are copied in (zero conflict, ever).
//   * Existing files get ONE anchored, idempotent one-line insertion each.
//   * ACS CCMD blocks are appended to p_acs.cpp (where the file-static arrays live),
//     and replaced in place when the overlay's copy changes.
//
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join, basename } from "node:path";

// Overlay files copied verbatim (standalone translation units / headers).
export const OVERLAY_FILES = [
  "mcp_bridge.h",
  "mcp_bridge.cpp",
  "mcp_crash.cpp",
  "mcp_event.cpp",
  "mcp_renderinfo.cpp",
  "mcp_actorstate.cpp",
  "mcp_hud.cpp",
  "mcp_hud.h",
  "mcp_input.cpp",
  "mcp_steer.h",
  "mcp_clock.cpp",
];

// Overlay blocks kept in p_acs.cpp: marker name, source file, log label.
export const ACS_BLOCKS = [
  ["MCP_ACSVARS", "mcp_acsvars.inc", "ACS var CCMDs"],
  ["MCP_MAPVARS", "mcp_mapvars.inc", "map var CCMDs"],
  ["MCP_MAPSLOT", "mcp_mapslot.inc", "map var slot CCMD"],
  ["MCP_ACSREF", "mcp_acsref.inc", "ACS var refs"],
  ["MCP_SCRIPTS", "mcp_scripts.inc", "script/function CCMDs"],
  ["MCP_RUNACS", "mcp_runacs.inc", "run_acs and run_script CCMDs"],
];

// Marker of the -host tee (3b), kept in the line's trailing comment.
export const HOST_TEE = "MCP: -host returns before the tee below";

// The bridge header include, on a file's first unconditional #include.
const BRIDGE_INCLUDE = {
  anchor: "^\\s*#include", requireTopLevel: true,
  line: '#include "mcp_bridge.h"', marker: '#include "mcp_bridge.h"',
};

// The mcp_rec recorder's playsim hooks (mcp_actorstate.cpp), each marker its hook's name, unique per file.
export const REC_HOOKS = [
  ["g_game.cpp", [
    { anchor: "^\\{", scopeAfter: "^void GAME_ResetMap", line: "\tMCP_Rec_Reset();", marker: "MCP_Rec_Reset" },
  ]],
  ["p_pspr.cpp", [
    { anchor: "^\\s*psp->state = NULL;", scopeAfter: "^void P_SetPsprite \\(", line: "\t\t\tMCP_Rec_PspriteClear( player->mo, position );", marker: "MCP_Rec_PspriteClear" },
    { anchor: "^\\s*// \\[BB\\] Some action functions", position: "Before", scopeAfter: "^void P_SetPsprite \\(",
      line: "\t\tMCP_Rec_PspriteSet( player->mo, NULL, position );", marker: "MCP_Rec_PspriteSet" },
  ]],
  ["p_tick.cpp", [
    // Right after the tic's maptime++, so once per simulated tic, after everything in it.
    { anchor: "^\\s*level\\.maptime\\+\\+;", scopeAfter: "^void P_Ticker", line: "\tMCP_Rec_Tick();", marker: "MCP_Rec_Tick" },
  ]],
  ["p_mobj.cpp", [
    { anchor: "^\\s*return actor;", position: "Before", scopeAfter: "^AActor \\*AActor::StaticSpawn",
      line: "\tMCP_Rec_Spawn( actor );", marker: "MCP_Rec_Spawn" },
    // The exact signature: a looser scope lands on DestroyAllInventory, then FreeNetID's freeID.
    { anchor: "g_ActorNetIDList\\.freeID \\( NetID \\);", position: "Before", scopeAfter: "^void AActor::Destroy \\(\\)",
      line: "\tMCP_Rec_Destroy( this );", marker: "MCP_Rec_Destroy" },
    { anchor: "tics = GetTics\\(newstate\\);", scopeAfter: "^bool AActor::SetState \\(",
      line: "\t\tMCP_Rec_State( this );", marker: "MCP_Rec_State" },
  ]],
  ["p_interaction.cpp", [
    // After both health subtractions in P_DamageMobj.
    { anchor: "target->DamageTypeReceived = mod;", line: "\tMCP_Rec_Damage( target, inflictor, source, damage, mod );", marker: "MCP_Rec_Damage" },
    { anchor: "bool wasgibbed", position: "Before", scopeAfter: "^void AActor::Die \\(",
      line: "\tMCP_Rec_Death( this, source, inflictor );", marker: "MCP_Rec_Death" },
  ]],
  ["p_acs.cpp", [
    // The member functions pass plain values: DLevelScript's members are protected.
    { anchor: 'DPrintf\\("%s started\\.', scopeAfter: "^DLevelScript::DLevelScript \\(AActor",
      line: "\tMCP_Rec_ScriptStart( this, num, module->GetModuleName(), activator );", marker: "MCP_Rec_ScriptStart" },
    { anchor: "^\\s*if \\(state == SCRIPT_PleaseRemove\\)", position: "Before",
      line: "\tif (state == SCRIPT_PleaseRemove) MCP_Rec_ScriptEnd( this, script );", marker: "MCP_Rec_ScriptEnd" },
  ]],
];

// The definition, not d_main.cpp's earlier `void D_DoomLoop ();` prototype.
const DOOM_LOOP = "^void D_DoomLoop \\(\\)\\s*$";

// The frozen clock's hooks (mcp_clock.cpp).
const CLOCK_FRAC = {
  scopeAfter: "^fixed_t I_GetTimeFrac", line: "\tif ( MCP_ClockFrozen ) return MCP_ClockFracValue;", marker: "MCP_ClockFrozen",
};
export const CLOCK_HOOKS = [
  ["d_net.cpp", [
    // Before the waits: a held frame runs no tic and never reads the clock in a loop.
    { anchor: "^\\s*bool doWait = ", position: "Before", scopeAfter: "^void TryRunTics",
      line: "\tif ( MCP_Clock_Hold() ) return;", marker: "MCP_Clock_Hold" },
    { anchor: "^\\s*counts = 1;", scopeAfter: "^void TryRunTics", line: "\tMCP_Clock_Clamp( counts );", marker: "MCP_Clock_Clamp" },
  ]],
  // The frame-ms rewrite must run before the frozen frac return.
  [join("sdl", "i_system.cpp"), [
    { ...CLOCK_FRAC, anchor: "^\\s*if \\(ms\\) \\*ms = " },
    { anchor: "^\\s*if \\(ms\\) \\*ms = ", scopeAfter: "^fixed_t I_GetTimeFrac",
      line: "\tif ( ms && MCP_ClockFrameUsed ) *ms = MCP_Clock_FrameTime( MCP_FRAME_TICMS, *ms );", marker: "MCP_FRAME_TICMS" },
    { anchor: "^\\{", scopeAfter: "^unsigned int I_FPSTime\\(\\)",
      line: "\tif ( MCP_ClockFrameUsed ) return MCP_Clock_FrameTime( MCP_FRAME_FPS, SDL_GetTicks() );", marker: "MCP_FRAME_FPS" },
  ]],
  [join("win32", "i_system.cpp"), [
    { ...CLOCK_FRAC, anchor: "^\\s*DWORD step = TicNext - TicStart;", position: "Before" },
    { anchor: "^\\s*\\*ms = TicNext;", scopeAfter: "^fixed_t I_GetTimeFrac",
      line: "\t\tif ( MCP_ClockFrameUsed ) *ms = MCP_Clock_FrameTime( MCP_FRAME_TICMS, *ms );", marker: "MCP_FRAME_TICMS" },
    { anchor: "^\\{", scopeAfter: "^unsigned int I_FPSTime\\(\\)",
      line: "\tif ( MCP_ClockFrameUsed ) return MCP_Clock_FrameTime( MCP_FRAME_FPS, timeGetTime() );", marker: "MCP_FRAME_FPS" },
  ]],
  [join("gl", "scene", "gl_scene.cpp"), [
    { anchor: "^\\s*gl_frameMS = I_MSTime\\(\\);",
      line: "\tif ( MCP_ClockFrameUsed ) gl_frameMS = MCP_Clock_FrameTime( MCP_FRAME_GLMS, gl_frameMS );", marker: "MCP_FRAME_GLMS" },
  ]],
  // The single-player D_Display, the only call spelled with a space.
  ["d_main.cpp", [
    { anchor: "^\\s*D_Display \\(\\);", scopeAfter: DOOM_LOOP,
      line: "\t\t\t\tMCP_Clock_AfterDisplay();", marker: "MCP_Clock_AfterDisplay" },
  ]],
];

/** Detect the dominant EOL so rewrites don't churn line endings. */
export function detectEol(text) {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Parse CLI args; accepts --src/-Src/-src, --src=<path>, and --revert/-Revert/-revert. */
export function parseArgs(argv) {
  let src = null;
  let revert = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--src" || a === "-Src" || a === "-src") src = argv[++i];
    else if (a === "--revert" || a === "-Revert" || a === "-revert") revert = true;
    else if (a.startsWith("--src=")) src = a.slice("--src=".length);
  }
  return { src, revert };
}

/** True if `file` already contains `marker` (the idempotency guard). */
export function hasMarker(file, marker) {
  return readFileSync(file, "utf8").includes(marker);
}

/**
 * Index of the first line matching `anchor` (a regex source string), optionally
 * only after the first line matching `scopeAfter`. Case-insensitive, mirroring
 * PowerShell's default -match. Throws (naming the pattern) if a landmark is gone.
 *
 * When `requireTopLevel` is set, only a match OUTSIDE every `#if/#ifdef/#ifndef`
 * block counts. This matters for the `#include "mcp_*.h"` insertions: the first
 * `#include` in a file can be platform-guarded (e.g. d_main.cpp opens with
 * Windows-only `#include <direct.h>` inside `#ifdef _WIN32`). Anchoring there
 * would bury the bridge include in a branch that non-Windows compiles out,
 * leaving its symbols undeclared — so we skip to the first unconditional include.
 */
export function findAnchorIndex(lines, anchor, scopeAfter, requireTopLevel = false) {
  let start = 0;
  if (scopeAfter) {
    start = -1;
    const re = new RegExp(scopeAfter, "i");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) { start = i; break; }
    }
    if (start < 0) throw new Error(`Scope anchor /${scopeAfter}/ not found.`);
  }
  const re = new RegExp(anchor, "i");
  let depth = 0;
  for (let i = start; i < lines.length; i++) {
    if (requireTopLevel) {
      if (depth === 0 && re.test(lines[i])) return i;
      const t = lines[i].trim();
      if (/^#\s*(if|ifdef|ifndef)\b/.test(t)) depth++;
      else if (/^#\s*endif\b/.test(t)) depth = Math.max(0, depth - 1);
      continue;
    }
    if (re.test(lines[i])) return i;
  }
  throw new Error(`Anchor /${anchor}/ not found (see anchors.md -- upstream may have moved).`);
}

/** Append `body` to a file, separated by one EOL, preserving the file's EOL style. */
export function appendBlock(file, body) {
  const text = readFileSync(file, "utf8");
  const eol = detectEol(text);
  writeFileSync(file, text + eol + body + (body.endsWith("\n") ? "" : eol));
}

/** Idempotent, marker-guarded one-line insertion before/after an anchor, first deleting the first
 *  match after `scopeAfter` of each older form of the line in `replaces` (a string or an array). */
export function insertLine(file, { anchor, line, marker, position = "After", scopeAfter, requireTopLevel = false, replaces = [] }, log) {
  const name = basename(file);
  if (hasMarker(file, marker)) {
    log(`  = already patched: ${name} (${marker})`);
    return;
  }
  const text = readFileSync(file, "utf8");
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const forms = [replaces].flat();
  const from = forms.length > 0 && scopeAfter ? findAnchorIndex(lines, scopeAfter) : 0;
  for (const form of forms) {
    const old = lines.findIndex((l, i) => i >= from && l === form);
    if (old >= 0) {
      lines.splice(old, 1);
      log(`  ~ migrated: ${name} (${form.trim()})`);
    }
  }
  const idx = findAnchorIndex(lines, anchor, scopeAfter, requireTopLevel);
  const at = position === "After" ? idx + 1 : idx;
  lines.splice(at, 0, line);
  writeFileSync(file, lines.join(eol));
  log(`  + patched: ${name} (${marker})`);
}

/** Keep the one line of `file` starting with `prefix` equal to `line`: appended under `header` when absent, replaced when it differs. */
export function syncLine(file, { prefix, line, header }, label, log) {
  const text = readFileSync(file, "utf8");
  const eol = detectEol(text);
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.startsWith(prefix));
  if (at < 0) {
    appendBlock(file, header + eol + line + eol);
    log(`  + patched: ${basename(file)} (${label})`);
  } else if (lines[at] === line) {
    log(`  = already patched: ${basename(file)} (${label})`);
  } else {
    lines[at] = line;
    writeFileSync(file, lines.join(eol));
    log(`  ~ updated: ${basename(file)} (${label})`);
  }
}

/** Keep the block of `file` from `// ==== NAME` to `// ==== end NAME ====` equal to `body`, appending or replacing it. */
export function syncBlock(file, name, body, label, log) {
  const text = readFileSync(file, "utf8");
  const begin = text.indexOf(`// ==== ${name} `);
  if (begin < 0) {
    appendBlock(file, body);
    log(`  + patched: ${basename(file)} (${label})`);
    return;
  }
  const endMark = `// ==== end ${name} ====`;
  const end = text.indexOf(endMark, begin);
  if (end < 0) {
    throw new Error(`${basename(file)}: the ${name} block has no "${endMark}" line, so it can't be replaced.`);
  }
  const block = body.trimEnd();
  if (text.slice(begin, end + endMark.length) === block) {
    log(`  = already patched: ${basename(file)} (${label})`);
    return;
  }
  writeFileSync(file, text.slice(0, begin) + block + text.slice(end + endMark.length));
  log(`  ~ updated: ${basename(file)} (${label})`);
}

/**
 * Apply (or revert) the overlay against a Zandronum repo root (`src`). `overlayDir`
 * is engine-bridge/overlay. `log` receives progress lines (defaults to a no-op).
 */
export function applyBridge({ src, revert = false, overlayDir, log = () => {} }) {
  const srcSrc = join(src, "src"); // -> <src>/src/...
  if (!existsSync(srcSrc)) {
    throw new Error(`Source tree not found: ${srcSrc}  (pass the zandronum repo root as --src)`);
  }

  if (revert) {
    for (const f of OVERLAY_FILES) rmSync(join(srcSrc, f), { force: true });
    log("Removed overlay files.");
    log("NOTE: the one-line hooks are dropped by your next clean engine update (hg revert/update).");
    return;
  }

  log(`Applying MCP engine bridge to ${srcSrc}`);

  // 1. New files -- copy overlay verbatim (zero-conflict).
  for (const f of OVERLAY_FILES) copyFileSync(join(overlayDir, f), join(srcSrc, f));
  log(`  + copied overlay: ${OVERLAY_FILES.join(" ")}`);

  const dmain = join(srcSrc, "d_main.cpp");
  const cconsole = join(srcSrc, "c_console.cpp");
  const vtext = join(srcSrc, "v_text.cpp");
  const vdraw = join(srcSrc, "v_draw.cpp");
  const sbar = join(srcSrc, "g_shared", "sbar.h");
  const ggame = join(srcSrc, "g_game.cpp");
  const pacs = join(srcSrc, "p_acs.cpp");
  const cmake = join(srcSrc, "CMakeLists.txt");

  // 2. d_main.cpp -- include + per-frame poll inside D_DoomLoop (all modes).
  insertLine(dmain, BRIDGE_INCLUDE, log);
  insertLine(dmain, {
    anchor: "switch \\( NETWORK_GetState\\( \\)\\)", position: "Before",
    scopeAfter: DOOM_LOOP,
    line: "\t\t\tMCP_Bridge_Poll();", marker: "MCP_Bridge_Poll();",
  }, log);

  // 3. c_console.cpp -- include + tee every printed line.
  insertLine(cconsole, BRIDGE_INCLUDE, log);
  insertLine(cconsole, {
    anchor: "I_PrintStr \\(outlinecopy\\)",
    line: "\t\tMCP_Bridge_TeeOutput( outlinecopy );", marker: "MCP_Bridge_TeeOutput",
  }, log);
  // A -host server returns before that tee, so tee its lines too (anchors.md row 4b; after the tee, whose marker this line contains).
  insertLine(cconsole, {
    anchor: "const int length = static_cast<int>\\(strlen \\(outlinecopy\\)\\);", position: "Before",
    scopeAfter: "For servers, dump message to console window",
    line: `\t\tMCP_Bridge_TeeOutput( outlinecopy ); // ${HOST_TEE}`, marker: HOST_TEE,
  }, log);
  // Bridge replies skip notify only; console, logfile and tee stay untouched (anchors.md row 4a).
  insertLine(cconsole, {
    anchor: "C_AddNotifyString \\(printlevel, outlinecopy\\);", position: "Before",
    line: "\t\t\tif ( MCP_Bridge_ShowInNotify( outlinecopy ) )", marker: "MCP_Bridge_ShowInNotify",
  }, log);

  // 3a. v_text.cpp -- tee every drawn HUD string (DrawTextV is the funnel).
  insertLine(vtext, {
    anchor: "^\\s*#include", requireTopLevel: true,
    line: '#include "mcp_hud.h"', marker: '#include "mcp_hud.h"',
  }, log);
  insertLine(vtext, {
    anchor: "if \\(normalcolor >= NumTextColors\\)", position: "Before",
    scopeAfter: "void DCanvas::DrawTextV",
    line: "\tMCP_HUD_TeeText( x, y, string );", marker: "MCP_HUD_TeeText",
  }, log);

  // 3a'. v_draw.cpp -- tee every drawn HUD image (non-virtual DrawTexture funnel;
  //      font glyphs are filtered out inside the tee).
  insertLine(vdraw, {
    anchor: "^\\s*#include", requireTopLevel: true,
    line: '#include "mcp_hud.h"', marker: '#include "mcp_hud.h"',
  }, log);
  insertLine(vdraw, {
    anchor: "va_start\\(tags, tags_first\\)", position: "Before",
    scopeAfter: "void STACK_ARGS DCanvas::DrawTexture ",
    line: "\tMCP_HUD_TeeTexture( x, y, img );", marker: "MCP_HUD_TeeTexture",
  }, log);

  // 3a''. sbar.h -- declare the HudMessage-walk member (friend access to DHUDMessage).
  insertLine(sbar, {
    anchor: "void DetachAllMessages \\(\\);",
    line: "\tvoid MCP_DumpMessages();", marker: "MCP_DumpMessages",
  }, log);

  // 3a'''. g_game.cpp -- include + the ticcmd override, before a recording demo writes the net cmd,
  //       returning a copy so the net slot the next tic delta-decodes over keeps the real input.
  insertLine(ggame, BRIDGE_INCLUDE, log);
  insertLine(ggame, {
    anchor: "^\\s*if \\(demorecording\\)\\s*$", position: "Before",
    scopeAfter: "void G_Ticker",
    line: "\t\t\t\tnewcmd = MCP_Input_Override( i, newcmd );", marker: "newcmd = MCP_Input_Override( i, newcmd )",
    replaces: ["\t\t\t\tMCP_Input_Override( i, cmd );", "\t\t\t\tMCP_Input_Override( i, newcmd );"],
  }, log);

  // 3a''''. The mcp_rec recorder's and the frozen clock's hooks.
  for (const [file, hooks] of [...REC_HOOKS, ...CLOCK_HOOKS]) {
    const at = join(srcSrc, file);
    insertLine(at, BRIDGE_INCLUDE, log);
    for (const hook of hooks) insertLine(at, hook, log);
  }

  // 3b. p_acs.cpp -- append the ACS world/global var, map var, and script CCMDs.
  //     They need access to file-static ACS arrays, so they live inside p_acs.cpp
  //     (appended at EOF -- the most update-stable spot) rather than a new file.
  insertLine(pacs, BRIDGE_INCLUDE, log);
  for (const [name, inc, label] of ACS_BLOCKS) {
    syncBlock(pacs, name, readFileSync(join(overlayDir, inc), "utf8"), label, log);
  }

  // 4. CMakeLists.txt -- compile the overlay into the zdoom target.
  const units = OVERLAY_FILES.filter((f) => f.endsWith(".cpp"));
  const target = {
    prefix: "target_sources( zdoom PRIVATE mcp_bridge.cpp",
    line: `target_sources( zdoom PRIVATE ${units.join(" ")} )`,
    header: "# MCP dev bridge (overlay -- not committed upstream)",
  };
  syncLine(cmake, target, "target_sources zdoom", log);

  log("Done. Rebuild the engine, then launch with ZANDRONUM_BRIDGE_PORT set to enable the bridge.");
}
