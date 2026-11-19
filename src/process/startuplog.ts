import { isSentinelLine } from "../correlation/sentinel.js";
import type { ChildExit } from "./registry.js";

// Pull the actionable errors out of an engine console log (<PREFIX>_BRIDGE_LOG).
// The killer case is a DECORATE/ACS compile error or other fatal that aborts the
// engine during startup, before the bridge socket ever opens — so the only trace
// is what the engine printed to this log.

/**
 * Lines the ZDoom-family console prints for script/compile and fatal load
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
  /** Case-insensitive; a matching line is dropped, after `pattern`. */
  exclude?: string;
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
  const drop = opts.exclude === undefined ? undefined : new RegExp(opts.exclude, "i");
  const matches = raw
    .map((text, i) => ({ line: i + 1, text: text.trimEnd() }))
    .slice(opts.sinceLine ?? 0)
    .filter(
      ({ text }) => text.length > 0 && !isSentinelLine(text) && (!rx || rx.test(text)) && !drop?.test(text),
    );
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
 * path (<PREFIX>_BRIDGE_LOG) with a `.crash` suffix. Mirrors the default in
 * engine-bridge/overlay/mcp_crash.cpp (ResolveCrashPath), so the server reads
 * back exactly what the engine wrote on a fatal signal.
 */
export function crashLogPath(logPath: string): string {
  return `${logPath}.crash`;
}

/** Where the host captures the engine's stderr, which gets a startup fatal the console log doesn't. */
export function stderrLogPath(logPath: string): string {
  return `${logPath}.stderr`;
}

/** `Engine stderr:` and its last 20 non-empty lines, or undefined when there are none. */
export function stderrSection(stderrText = ""): string | undefined {
  const lines = tailLines(stderrText, 20);
  return lines.length ? `Engine stderr:\n${lines.join("\n")}` : undefined;
}

export interface StartupFailure {
  instance: number;
  message: string;
  /** Set when the engine exited before its bridge opened; absent for a timeout or a bad attach. */
  exit?: ChildExit;
  logText?: string;
  stderrText?: string;
}

/** The whole reply for a launch whose bridge never came up. */
export function startupFailureText(f: StartupFailure): string {
  const stderr = stderrSection(f.stderrText);
  const errors = parseStartupErrors(f.logText ?? "");
  const sections = [`Instance ${f.instance} failed to come up: ${f.message}.`];
  if (stderr) sections.push(stderr);
  if (errors.length) sections.push(`Engine log shows:\n${errors.join("\n")}`);
  // Stderr explains an exit; on a timeout it may be harmless SDL/ALSA chatter.
  const explained = errors.length > 0 || (stderr !== undefined && f.exit !== undefined);
  const tail = tailLines(f.logText ?? "", 10);
  if (!explained && tail.length) sections.push(`Engine log tail:\n${tail.join("\n")}`);
  if (f.exit?.signal) sections.push("Call get_crash for the backtrace.");
  if (!f.exit && !errors.length) {
    sections.push("No compile errors found in the engine log. It may have crashed, or the bridge build is stale.");
  }
  return sections.join("\n\n");
}

/** The `pid:` line mcp_crash.cpp writes into every report, or undefined if absent. */
export function crashReportPid(report: string): number | undefined {
  const m = /^pid: (\d+)\r?$/m.exec(report);
  return m ? Number(m[1]) : undefined;
}

/** get_crash's reply for an existing crash file, which can outlive the engine that wrote it, so its pid is checked. */
export function crashReportText(crash: {
  instance: number;
  crashFile: string;
  report: string;
  enginePid: number | undefined;
  written: Date;
}): { text: string; noCrash: boolean } {
  const { instance, crashFile, report, enginePid } = crash;
  const reportPid = crashReportPid(report);
  if (enginePid !== undefined && reportPid === enginePid) return { text: report, noCrash: false };
  const written = crash.written.toISOString();
  if (enginePid !== undefined && reportPid !== undefined) {
    const text =
      `No crash recorded for instance ${instance} (PID ${enginePid}). ${crashFile} holds ` +
      `another engine's crash (PID ${reportPid}, written ${written}), not this one's.`;
    return { text, noCrash: true };
  }
  const why = enginePid === undefined ? "this instance's engine PID is unknown" : "the report has no pid line";
  const caveat = `so this may be another engine's crash (written ${written})`;
  return { text: `Unverified: ${why}, ${caveat}.\n\n${report}`, noCrash: false };
}
