import { cleanConsoleLines, matchLines } from "./lines.js";

const TAG = "MCP_RUNACS";
const REPLY = new RegExp(`^${TAG} module=(\\d+) scripts=(\\d+) started=(\\S+) deferred=([01])$`);

/** The `MCP_RUNACS` reply line of `mcp_runacs` (overlay mcp_runacs.inc). */
export interface RunAcsReply {
  module: number;
  scripts: number;
  /** The started script as given (number or name), or "none". */
  started: string;
  /** The snippet holds DEATH/ENTER/RESPAWN/... scripts that fire on later events. */
  deferred: boolean;
}

export interface RunAcsResult {
  reply: RunAcsReply;
  /** What the snippet printed inside the call. */
  printed: string[];
}

/** The reply line and the snippet's own prints from `mcp_runacs` output, or undefined without a reply line. */
export function parseRunAcs(lines: string[]): RunAcsResult | undefined {
  // Matched whole, not as loose key=value: the snippet's own prints share the reply's output.
  const reply = matchLines(lines, REPLY, (m) => ({
    module: Number(m[1]),
    scripts: Number(m[2]),
    started: m[3],
    deferred: m[4] === "1",
  }))[0];
  if (!reply) return undefined;
  return { reply, printed: cleanConsoleLines(lines).filter((l) => !l.startsWith(`${TAG} `)) };
}

/** The text of a `run_acs` reply; `later` is the log read after stepping `stepTics`, if there was a log. */
export function runAcsText({ reply, printed }: RunAcsResult, stepTics: number, later?: string[]): string {
  const lines = [
    `loaded snippet as module ${reply.module} (${reply.scripts} script(s)), started ${reply.started}`,
    ...printed,
  ];
  if (stepTics > 0) {
    lines.push(later ? `log after ${stepTics} tic(s):` : `ran ${stepTics} tic(s); no engine log to read`, ...(later ?? []));
  }
  if (reply.deferred) {
    lines.push("The snippet has DEATH/ENTER/RESPAWN/... scripts: they fire on later events until the map changes.");
  }
  lines.push("save_game refuses until the map changes (a save now could not be loaded back); in-game saves and hub exits carry the same hazard.");
  return lines.join("\n");
}
