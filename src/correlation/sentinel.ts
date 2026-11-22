const SENTINEL_PREFIX = "__MCPDONE_";
const SENTINEL_SUFFIX = "__";

/** Build a unique end-of-command marker for the given request id. */
export function makeSentinel(id: string): string {
  return `${SENTINEL_PREFIX}${id}${SENTINEL_SUFFIX}`;
}

/**
 * The `mcp_status` form of a correlator: the CCMD echoes the sentinel as its
 * leading token and appends the engine-state fields to the same line.
 */
export function statusRequest(sentinel: string): string {
  return `mcp_status ${sentinel}`;
}

/**
 * Wrap a console command so the engine echoes a unique marker when it finishes.
 * The bridge stays dumb: it just runs the string; correlation is entirely here.
 *
 * `status` rides the `mcp_status` CCMD instead of a plain `echo` when the
 * connected bridge advertises the `status` cap — the caller (`execCommand`)
 * decides that, so this stays a pure string builder with no `BridgeClient`
 * reference. The plain `echo` form MUST stay reachable: on a bridge without the
 * CCMD, `mcp_status` would never echo back and every command would hang to its
 * timeout instead of degrading.
 */
export function withSentinel(command: string, sentinel: string, status: boolean): string {
  return `${command} ; ${status ? statusRequest(sentinel) : `echo ${sentinel}`}`;
}

/** Whether a log line is correlation plumbing (any sentinel echo or `mcp_status` reply). */
export function isSentinelLine(line: string): boolean {
  return line.includes(SENTINEL_PREFIX);
}

export function lineContainsSentinel(line: string, sentinel: string): boolean {
  return line.includes(sentinel);
}

/** Whether a line is a correlator reply: it starts with a sentinel (an echo or `mcp_status` reply). */
export function isCorrelatorLine(line: string): boolean {
  return line.trimStart().startsWith(SENTINEL_PREFIX);
}

/**
 * Drop another request's correlator replies (lines that START with a sentinel,
 * e.g. a timed-out status probe answering late) from one output message; undefined
 * when nothing else is left. A sentinel merely quoted mid-line stays: `dumphud`
 * echoes on-screen notify text, which can show earlier status lines.
 */
export function stripForeignSentinels(text: string, sentinel: string): string | undefined {
  const lines = text.split("\n");
  const kept = lines.filter((l) => !isCorrelatorLine(l) || l.includes(sentinel));
  if (kept.length === lines.length) return text;
  const rest = kept.join("\n");
  return rest.trim() ? rest : undefined;
}
