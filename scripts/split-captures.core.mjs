// The split behind split-captures.mjs, kept apart so the tests can import it.
import { isCorrelatorLine } from "../src/correlation/sentinel.ts";

const MARKER = /^CAPTURE (\S+)$/;

/** One fixture per `CAPTURE <name>` marker but `end`, holding the lines after its correlator up to the
 *  next marker, or for a marker-only `status*` capture the correlator line itself. */
export function splitCaptures(logLines) {
  const captures = [];
  for (const line of logLines) {
    const m = MARKER.exec(line);
    if (m) captures.push({ name: m[1], status: undefined, body: [] });
    else if (captures.length === 0) continue;
    else if (isCorrelatorLine(line)) captures.at(-1).status ??= line;
    else if (captures.at(-1).status !== undefined) captures.at(-1).body.push(line);
  }
  return captures
    .filter(({ name }) => name !== "end")
    .map(({ name, status, body }) => {
      while (body.length && body.at(-1) === "") body.pop();
      return { name, lines: name.startsWith("status") ? [status ?? ""] : body };
    });
}
