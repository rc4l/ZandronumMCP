import { matchLines } from "./lines.js";

/** The `MCP_RUNACS` reply line of `mcp_runacs` (overlay mcp_runacs.inc). */
export interface RunAcsReply {
  module: number;
  scripts: number;
  /** The started script as given (number or name), or "none". */
  started: string;
  /** The snippet holds DEATH/ENTER/RESPAWN/... scripts that fire on later events. */
  deferred: boolean;
}

/** The `MCP_RUNSCRIPT` reply line of `mcp_runscript` (overlay mcp_runacs.inc). */
export interface RunScriptReply {
  /** The script as given (number or name). */
  script: string;
  /** False when a copy was already running and `always` wasn't given. */
  started: boolean;
  /** The script's `SetResultValue` so far (engine default 1); 0 when it didn't start. */
  result: number;
  /** False when the script paused at a delay instead of ending inside the call. */
  finished: boolean;
  /** The module that owns the script, numbered as `dumpmodules` and `MCP_RUNACS module=` do. */
  module: number;
}

export function parseRunScript(lines: string[]): RunScriptReply | undefined {
  return matchLines(
    lines,
    /^MCP_RUNSCRIPT script=(.+) started=([01]) result=(-?\d+) finished=([01]) module=(\d+)$/,
    (m) => ({
      script: m[1],
      started: m[2] === "1",
      result: Number(m[3]),
      finished: m[4] === "1",
      module: Number(m[5]),
    }),
  )[0];
}

/** A script-running CCMD's non-blank, right-trimmed output lines, and those minus its own `<tag> ...` reply (what the script printed). */
export function scriptOutput(output: string[], tag: string): { lines: string[]; printed: string[] } {
  const lines = output
    .join("\n")
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);
  return { lines, printed: lines.filter((l) => !l.startsWith(`${tag} `)) };
}

export function parseRunAcs(lines: string[]): RunAcsReply | undefined {
  return matchLines(
    lines,
    /^MCP_RUNACS module=(\d+) scripts=(\d+) started=(\S+) deferred=([01])$/,
    (m) => ({ module: Number(m[1]), scripts: Number(m[2]), started: m[3], deferred: m[4] === "1" }),
  )[0];
}

/** The caveats every `run_acs` reply ends on: later-firing scripts, then the save hazard. */
export function runAcsCaveats(reply: RunAcsReply): string[] {
  return [
    ...(reply.deferred ? ["The snippet has DEATH/ENTER/RESPAWN/... scripts: they fire on later events until the map changes."] : []),
    "save_game refuses until the map changes (a save now could not be loaded back); in-game saves and hub exits carry the same hazard.",
  ];
}

/** The text of a `run_acs` reply: the load line, then `body` (profile, print and step lines), then the caveats. */
export function runAcsText(reply: RunAcsReply, body: string[]): string {
  return [
    `loaded snippet as module ${reply.module} (${reply.scripts} script(s)), started ${reply.started}`,
    ...body,
    ...runAcsCaveats(reply),
  ].join("\n");
}
