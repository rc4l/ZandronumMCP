import { isSentinelLine } from "../correlation/sentinel.js";

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

export interface LogWindowOptions {
  /** Case-insensitive filter; only matching lines are returned. */
  pattern?: string;
  /** Resume after this raw line count (a previous call's `nextLine`); omitted means tail. */
  sinceLine?: number;
  maxLines: number;
}

export interface LogWindow {
  /** 1-based raw line numbers, so they line up with the file itself. */
  lines: Array<{ line: number; text: string }>;
  /** Pass back as `sinceLine` to read only what was appended after this call. */
  nextLine: number;
  /** Matching lines left out by `maxLines`. */
  omitted: number;
}

/**
 * A filtered slice of an engine console log, minus the sentinel plumbing every tool call
 * writes, counting only complete lines so `nextLine` never skips the rest of a half-flushed one.
 */
export function readLogWindow(log: string, opts: LogWindowOptions): LogWindow {
  const raw = log.split(/\r?\n/).slice(0, -1);
  const rx = opts.pattern === undefined ? undefined : new RegExp(opts.pattern, "i");
  const matches = raw
    .map((text, i) => ({ line: i + 1, text: text.trimEnd() }))
    .slice(opts.sinceLine ?? 0)
    .filter(({ text }) => text.length > 0 && !isSentinelLine(text) && (!rx || rx.test(text)));
  const omitted = Math.max(0, matches.length - opts.maxLines);
  if (opts.sinceLine === undefined) {
    return { lines: matches.slice(omitted), nextLine: raw.length, omitted };
  }
  // Forward read: stop at the cap and resume from the last line returned.
  const lines = matches.slice(0, opts.maxLines);
  return { lines, nextLine: omitted ? lines[lines.length - 1].line : raw.length, omitted };
}

/**
 * Where the bridge's crash handler writes its backtrace: the engine console-log
 * path (ZANDRONUM_BRIDGE_LOG) with a `.crash` suffix. Mirrors the default in
 * engine-bridge/overlay/mcp_crash.cpp (ResolveCrashPath), so the server reads
 * back exactly what the engine wrote on a fatal signal.
 */
export function crashLogPath(logPath: string): string {
  return `${logPath}.crash`;
}

/** The `pid:` line mcp_crash.cpp writes into every report, or undefined if absent. */
export function crashReportPid(report: string): number | undefined {
  const m = /^pid: (\d+)\r?$/m.exec(report);
  return m ? Number(m[1]) : undefined;
}

/** get_crash's reply for an existing crash file, which can outlive the engine that wrote it. */
export function crashReportText(crash: {
  instance: number;
  crashFile: string;
  report: string;
  enginePid: number | undefined;
  written: Date;
}): string {
  const { instance, crashFile, report, enginePid } = crash;
  const reportPid = crashReportPid(report);
  if (enginePid !== undefined && reportPid === enginePid) return report;
  const written = crash.written.toISOString();
  if (enginePid !== undefined && reportPid !== undefined) {
    return (
      `No crash recorded for instance ${instance} (PID ${enginePid}). ${crashFile} holds ` +
      `another engine's crash (PID ${reportPid}, written ${written}), not this one's.`
    );
  }
  const why =
    enginePid === undefined
      ? "this instance's engine PID is unknown"
      : "the report has no pid line";
  const caveat = `so this may be another engine's crash (written ${written})`;
  return `Unverified: ${why}, ${caveat}.\n\n${report}`;
}
