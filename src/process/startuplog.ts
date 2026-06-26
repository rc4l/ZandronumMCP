// Pull the actionable errors out of an engine console log (ZANDRONUM_BRIDGE_LOG).
// The killer case is a DECORATE/ACS compile error or other fatal that aborts the
// engine during startup, before the bridge socket ever opens — so the only trace
// is what the engine printed to this log.

/**
 * Lines the ZDoom/Zandronum console prints for script/compile and fatal load
 * failures. Kept broad on purpose — better to surface a near-miss line than to
 * hide the one that mattered.
 */
const ERROR_RX =
  /script error|execution could not continue|errors? (?:while|in) |bad syntax|unexpected|expected|unknown (?:actor|flag|function|identifier|class)|tried to (?:set|use)|could not find|undefined|fatal error|\bfailed\b/i;

/** Error-relevant lines from an engine console log, in order, de-blanked. */
export function parseStartupErrors(log: string): string[] {
  return log
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0 && ERROR_RX.test(l));
}

/** Last `n` non-empty lines of the log, for context when no error matched. */
export function tailLines(log: string, n = 40): string[] {
  const lines = log.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}
