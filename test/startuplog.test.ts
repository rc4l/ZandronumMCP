import { describe, it, expect } from "vitest";
import { parseStartupErrors, tailLines, crashLogPath, crashReportPid, crashReportText, readLogWindow } from "../src/process/startuplog.js";
import { stderrLogPath, stderrSection, startupFailureText } from "../src/process/startuplog.js";

const SAMPLE = [
  "Resolving GL extensions",
  "adding doom2.wad, 2919 lumps",
  'Script error, "DECORATE" line 12:',
  "Expected '}' but got 'Foo'",
  "Execution could not continue.",
  "2 errors while parsing DECORATE scripts",
  "Init game engine.",
].join("\n");

describe("parseStartupErrors", () => {
  it("extracts compile/fatal error lines and ignores normal startup chatter", () => {
    const errs = parseStartupErrors(SAMPLE);
    expect(errs).toEqual([
      'Script error, "DECORATE" line 12:',
      "Expected '}' but got 'Foo'",
      "Execution could not continue.",
      "2 errors while parsing DECORATE scripts",
    ]);
    expect(errs).not.toContain("adding doom2.wad, 2919 lumps");
  });

  it("returns nothing for a clean log", () => {
    expect(parseStartupErrors("adding doom2.wad\nInit game engine.\nplaying")).toEqual([]);
  });

  it("handles CRLF line endings", () => {
    expect(parseStartupErrors("ok\r\nScript error, foo\r\nok")).toEqual(["Script error, foo"]);
  });
});

describe("tailLines", () => {
  it("returns the last n non-empty lines", () => {
    expect(tailLines("a\n\nb\nc\n\n", 2)).toEqual(["b", "c"]);
  });

  it("defaults to 40 lines and skips blanks", () => {
    const log = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n\n");
    const out = tailLines(log);
    expect(out).toHaveLength(40);
    expect(out[out.length - 1]).toBe("line 99");
  });
});

describe("crashLogPath", () => {
  it("derives <log>.crash from the console-log path (matches mcp_crash.cpp)", () => {
    expect(crashLogPath("/x/mcp-bridge-7777.log")).toBe("/x/mcp-bridge-7777.log.crash");
    expect(crashLogPath("C:/tmp/inst1.log")).toBe("C:/tmp/inst1.log.crash");
  });
});

describe("stderrLogPath", () => {
  it("derives <log>.stderr beside the console log", () => {
    expect(stderrLogPath("/x/mcp-bridge-7777.log")).toBe("/x/mcp-bridge-7777.log.stderr");
  });
});

describe("stderrSection", () => {
  it("keeps the last 20 non-empty lines under a header", () => {
    const text = Array.from({ length: 25 }, (_, i) => `e${i}`).join("\n\n");
    const lines = Array.from({ length: 20 }, (_, i) => `e${i + 5}`);
    expect(stderrSection(text)).toBe(`Engine stderr:\n${lines.join("\n")}`);
  });

  it("is undefined for missing or blank stderr", () => {
    expect(stderrSection()).toBeUndefined();
    expect(stderrSection("\n  \n")).toBeUndefined();
  });
});

describe("startupFailureText", () => {
  const HINT = "No compile errors found in the engine log. It may have crashed, or the bridge build is stale.";

  it("a timeout with nothing captured keeps the stale-build hint", () => {
    expect(startupFailureText({ instance: 1, message: "bridge port h:1 never opened" })).toBe(
      `Instance 1 failed to come up: bridge port h:1 never opened.\n\n${HINT}`,
    );
  });

  it("a timeout with log errors shows them and drops the hint", () => {
    expect(startupFailureText({ instance: 2, message: "timeout", logText: SAMPLE, stderrText: "" })).toBe(
      [
        "Instance 2 failed to come up: timeout.",
        [
          "Engine log shows:",
          'Script error, "DECORATE" line 12:',
          "Expected '}' but got 'Foo'",
          "Execution could not continue.",
          "2 errors while parsing DECORATE scripts",
        ].join("\n"),
      ].join("\n\n"),
    );
  });

  it("a timeout with a quiet log shows its last 10 lines, then the hint", () => {
    const log = Array.from({ length: 15 }, (_, i) => `line ${i}`).join("\n");
    const tail = Array.from({ length: 10 }, (_, i) => `line ${i + 5}`).join("\n");
    expect(startupFailureText({ instance: 1, message: "timeout", logText: log })).toBe(
      `Instance 1 failed to come up: timeout.\n\nEngine log tail:\n${tail}\n\n${HINT}`,
    );
  });

  it("a timeout with stderr chatter still shows the log tail and the hint", () => {
    expect(
      startupFailureText({
        instance: 1,
        message: "timeout",
        logText: "all quiet\n",
        stderrText: "ALSA lib pcm.c: Unknown PCM default\n",
      }),
    ).toBe(
      [
        "Instance 1 failed to come up: timeout.",
        "Engine stderr:\nALSA lib pcm.c: Unknown PCM default",
        "Engine log tail:\nall quiet",
        HINT,
      ].join("\n\n"),
    );
  });

  it("an exit code shows stderr, then the log errors", () => {
    expect(
      startupFailureText({
        instance: 1,
        message: "engine exited during startup (exit code 255)",
        exit: { code: 255, signal: null },
        logText: "ok\nScript error, bad syntax\n",
        stderrText: "Execution could not continue.\n\n1 errors while parsing DECORATE scripts\n",
      }),
    ).toBe(
      [
        "Instance 1 failed to come up: engine exited during startup (exit code 255).",
        "Engine stderr:\nExecution could not continue.\n1 errors while parsing DECORATE scripts",
        "Engine log shows:\nScript error, bad syntax",
      ].join("\n\n"),
    );
  });

  it("a stderr-only exit skips the log tail and the hint", () => {
    expect(
      startupFailureText({
        instance: 1,
        message: "engine exited during startup (exit code 255)",
        exit: { code: 255, signal: null },
        logText: "all quiet\n",
        stderrText: "Cannot find uzdoom.pk3\n",
      }),
    ).toBe(
      "Instance 1 failed to come up: engine exited during startup (exit code 255).\n\nEngine stderr:\nCannot find uzdoom.pk3",
    );
  });

  it("a signal exit points at get_crash", () => {
    expect(
      startupFailureText({
        instance: 3,
        message: "engine exited during startup (signal SIGSEGV)",
        exit: { code: null, signal: "SIGSEGV" },
        logText: "Init game engine.\n",
      }),
    ).toBe(
      [
        "Instance 3 failed to come up: engine exited during startup (signal SIGSEGV).",
        "Engine log tail:\nInit game engine.",
        "Call get_crash for the backtrace.",
      ].join("\n\n"),
    );
  });

  it("a spawn failure is just the message", () => {
    expect(
      startupFailureText({
        instance: 1,
        message: "engine exited during startup (could not start: spawn /x ENOENT)",
        exit: { code: null, signal: null, error: "spawn /x ENOENT" },
      }),
    ).toBe("Instance 1 failed to come up: engine exited during startup (could not start: spawn /x ENOENT).");
  });
});

describe("crashReportPid", () => {
  it("reads the pid line from either platform's report, or undefined", () => {
    expect(crashReportPid("=== MCP ENGINE CRASH ===\nsignal: 11 SIGSEGV\nfault_addr: 0x8\npid: 31337\n\nbacktrace:\n")).toBe(31337);
    expect(crashReportPid("code: 0xc0000005\r\npid: 7\r\n")).toBe(7);
    expect(crashReportPid("no pid here\n#0 pid: 5 in a frame")).toBeUndefined();
  });
});

describe("crashReportText", () => {
  const withPid = "signal: 11 SIGSEGV\npid: 99\n\nbacktrace:\n#0 R_DrawColumn";
  const written = "written 2026-09-22T06:10:00.000Z";
  const reply = (report: string, enginePid: number | undefined) =>
    crashReportText({
      instance: 2,
      crashFile: "/x/inst2.log.crash",
      report,
      enginePid,
      written: new Date("2026-09-22T06:10:00Z"),
    });

  it("returns the report verbatim when its pid is this engine's", () => {
    expect(reply(withPid, 99)).toEqual({ text: withPid, noCrash: false });
  });

  it("names another engine's report without returning it", () => {
    expect(reply(withPid, 4242)).toEqual({
      text:
        "No crash recorded for instance 2 (PID 4242). /x/inst2.log.crash holds " +
        `another engine's crash (PID 99, ${written}), not this one's.`,
      noCrash: true,
    });
  });

  it("marks the report unverified when the engine PID is unknown", () => {
    expect(reply(withPid, undefined)).toEqual({
      text:
        "Unverified: this instance's engine PID is unknown, " +
        `so this may be another engine's crash (${written}).\n\n${withPid}`,
      noCrash: false,
    });
  });

  it("marks the report unverified when it has no pid line", () => {
    expect(reply("SIGSEGV\n#0 x", 4242)).toEqual({
      text:
        "Unverified: the report has no pid line, " +
        `so this may be another engine's crash (${written}).\n\nSIGSEGV\n#0 x`,
      noCrash: false,
    });
  });
});

describe("readLogWindow", () => {
  const LOG = ["one", "__MCPDONE_1__", "Degreelessness Mode ON", "", "two", "partial"].join("\n");

  it("tails the last maxLines, skipping sentinels, blanks and a half-written last line", () => {
    expect(readLogWindow(LOG, { maxLines: 2 })).toEqual({
      lines: [
        { line: 3, text: "Degreelessness Mode ON" },
        { line: 5, text: "two" },
      ],
      nextLine: 5,
      omitted: 1,
    });
  });

  it("filters by a case-insensitive pattern", () => {
    expect(readLogWindow(LOG, { pattern: "degreeless", maxLines: 10 }).lines).toEqual([
      { line: 3, text: "Degreelessness Mode ON" },
    ]);
  });

  it("reads forward from sinceLine, resuming at the last line returned when capped", () => {
    expect(readLogWindow(LOG, { sinceLine: 1, maxLines: 1 })).toEqual({
      lines: [{ line: 3, text: "Degreelessness Mode ON" }],
      nextLine: 3,
      omitted: 1,
    });
    expect(readLogWindow(LOG, { sinceLine: 3, maxLines: 5 })).toEqual({
      lines: [{ line: 5, text: "two" }],
      nextLine: 5,
      omitted: 0,
    });
  });

  it("returns nothing past the end (a relaunch overwrote the log)", () => {
    expect(readLogWindow(LOG, { sinceLine: 99, maxLines: 5 })).toEqual({ lines: [], nextLine: 5, omitted: 0 });
  });

  it("throws on an invalid pattern", () => {
    expect(() => readLogWindow(LOG, { pattern: "(", maxLines: 5 })).toThrow();
  });

  it("drops lines matching a case-insensitive exclude", () => {
    expect(readLogWindow(LOG, { exclude: "DEGREE", maxLines: 10 }).lines).toEqual([
      { line: 1, text: "one" },
      { line: 5, text: "two" },
    ]);
  });

  it("applies exclude after pattern", () => {
    expect(readLogWindow(LOG, { pattern: "o", exclude: "^two$", maxLines: 10 }).lines).toEqual([
      { line: 1, text: "one" },
      { line: 3, text: "Degreelessness Mode ON" },
    ]);
  });

  it("counts excluded lines out of the cap, so a capped forward read still resumes right", () => {
    const log = ["a1", "skip", "a2", "skip", "a3", ""].join("\n");
    expect(readLogWindow(log, { exclude: "skip", sinceLine: 0, maxLines: 2 })).toEqual({
      lines: [
        { line: 1, text: "a1" },
        { line: 3, text: "a2" },
      ],
      nextLine: 3,
      omitted: 1,
    });
    expect(readLogWindow(log, { exclude: "skip", sinceLine: 3, maxLines: 2 })).toEqual({
      lines: [{ line: 5, text: "a3" }],
      nextLine: 5,
      omitted: 0,
    });
  });

  it("throws on an invalid exclude", () => {
    expect(() => readLogWindow(LOG, { exclude: "[", maxLines: 5 })).toThrow();
  });
});
