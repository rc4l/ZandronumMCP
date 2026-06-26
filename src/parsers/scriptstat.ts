import type { RunningScript } from "../types.js";

/**
 * Parse the output of the `scriptstat` console command.
 *
 * Format (from p_acs.cpp DumpScriptStatus / ScriptPresentation):
 *   - "No scripts are running." when idle
 *   - otherwise one line per running script:
 *       "script 5: Running"
 *       "script \"OpenDoor\": Delayed"
 *
 * States: Running, Suspended, Delayed, TagWait, PolyWait, ScriptWaitPre,
 * ScriptWait, PleaseRemove.
 */
export function parseScriptStat(lines: string[]): RunningScript[] {
  const scripts: RunningScript[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^script (.+): (\S+)$/);
      if (!m) continue;
      const [, ref, state] = m;
      const quoted = ref.match(/^"(.*)"$/);
      if (quoted) {
        scripts.push({ number: null, name: quoted[1], state });
      } else if (/^-?\d+$/.test(ref)) {
        scripts.push({ number: Number.parseInt(ref, 10), name: null, state });
      }
      // anything else isn't a shape ScriptPresentation produces — skip it
    }
  }
  return scripts;
}
