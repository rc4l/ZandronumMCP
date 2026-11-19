import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z, type ZodRawShape } from "zod";
import path from "node:path";
import type { LastLaunch, LaunchArgs, ServerContext } from "./context.js";
import { parseStartupErrors, tailLines, crashLogPath, crashReportPid, crashReportText, readLogWindow } from "./process/startuplog.js";
import { stderrLogPath, stderrSection, startupFailureText } from "./process/startuplog.js";
import { EngineExitedError, LaunchSetupError } from "./process/registry.js";
import { parseProcMemory, procMismatch, procName, procStatusPath } from "./process/procstatus.js";
import type { LogWindow, LogWindowOptions } from "./process/startuplog.js";
import { parseDumpActors } from "./parsers/dumpactors.js";
import { parseScriptStat } from "./parsers/scriptstat.js";
import { parseAcsVars } from "./parsers/acsvars.js";
import { parseMapVar, parseMapArray, parseMapSlot, parseMapSlotNoMatch, parseModules } from "./parsers/mapvars.js";
import { parseScripts, parseFunctions } from "./parsers/scripts.js";
import {
  DEFAULT_PROFILE_LIMIT,
  isTruncated,
  parseAcsProfile,
  rankProfile,
  resolveProfileNames,
  type ProfileSort,
} from "./parsers/acsprofile.js";
import { parsePlayerState, parseTarget, playersReply, withLiveStatus, type PlayerState } from "./parsers/playerstate.js";
import { pollUntil } from "./poll.js";
import { parseActorState, parseActorsNear, parseFoundReply, expandFlags, describeRemoved } from "./parsers/actorstate.js";
import { FLAG_NAMES, FIND_ACTORS_LIMIT, filterFound, type FoundActors } from "./parsers/actorstate.js";
import { joinedBots, allHaveTid, addBotReport, botKey, type JoinedBot } from "./parsers/players.js";
import { parseKvLines, firstError, stripColor, cleanConsoleLines, hasHeader, failureText, outputText, markerText } from "./parsers/lines.js";
import type { KvRecord } from "./parsers/lines.js";
import { parseHud, filterHud } from "./parsers/hud.js";
import { parseMarks, formatMark, resolveGamelog } from "./parsers/marks.js";
import { describeStatus, footerNote, isPaused, statusBlockers, requireField } from "./parsers/status.js";
import type { BridgeClient } from "./bridge/transport.js";
import { findSymbol } from "./acs/symbols.js";
import { sectorTags } from "./map/index.js";
import { collectAcsLumps, pickModules, type AcsModule } from "./acs/collect.js";
import { parseBehaviorNames, parseMapExports, isAcsObject, parseLoadNames, missingImports } from "./acs/bytecode.js";
import { parseRunAcs, parseRunScript, runAcsCaveats, runAcsText, scriptOutput } from "./parsers/runacs.js";
import { PROP_NAMES, FLAG_PROP, FORCEABLE_PROPS, encodePropValue } from "./actorprops.js";
import { parseRenderInfo, pick } from "./parsers/renderinfo.js";
import { command, kvArgs, realToken, isPlainToken, buildPuke, buildPukeName, buildRunAcs, buildSave } from "./commands/builders.js";
import { buildPrelude, type Prelude, type RunAcsProfile } from "./acs/profiles.js";
import { buildRunScript, buildAddBot, refToken, type RefArg } from "./commands/builders.js";
import { appendNote } from "./adapter.js";
import { bridgeMarker } from "./process/verify.js";
import { hasArg, argValue, configPathFor, isolatedConfigPathFor } from "./process/launch.js";
import {
  menuKeyEvent,
  menuKeyUpEvent,
  charEvent,
  mouseMoveEvent,
  mouseButtonEvent,
  wheelEvent,
  type MenuKey,
} from "./input/keys.js";
import { runMoveTo, describeMove, type MovePort, type Waypoint } from "./movement/moveto.js";
import { classArg, exactlyOneForm, mapCoord, waypointFields, toWaypoint } from "./movement/target.js";
import { FIELDS, DEFAULT_FIELDS, DETAIL_FIELDS, needsDetail, runWatch, describeWatch, type WatchPort } from "./sampler/watch.js";
import { capNote, pollArmedRun, stallTracker, stepWithin, STALL_TICS, type Reading } from "./sampler/stepping.js";
import {
  segmentArg,
  planTimeline,
  scheduleCommand,
  splitLog,
  summarizeSegments,
  describeTimeline,
  MAX_SEGMENTS,
} from "./input/timeline.js";
import { parseInputStatus, parseInputArmed, parseInputTrail, type InputRow, type InputStatus } from "./parsers/input.js";
import { netRole, joinAction, joinState, type NetInfo, type JoinState } from "./netgame.js";
import { ToolRegistry, type ToolHandler } from "./scenario/dispatch.js";
import { ToolRefusal } from "./types.js";
import { scenarioShape, SCENARIO_REFUSALS, MAX_STEPS, MAX_CALLS, MAX_ITERATIONS } from "./scenario/schema.js";
import { runScenario, describeScenario, scenarioRefusal, type ScenarioPort } from "./scenario/run.js";
import { STEP_TEXT_CHARS, STEP_ROWS, STEP_JSON_CHARS, REPLY_CHARS, SUMMARY_CHARS } from "./scenario/run.js";

const instanceArg = z.number().int().positive().default(1);
const acsScope = z.enum(["world", "global"]);
const acsSrcArg = z.string().optional();
const acsName = z.string().min(1);
// The map-var tools' sourceFile selectors.
const sourceFileArgs = {
  sourceFile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The module's main ACS source (bcc). With it, name is an expression with constant indices and members (sectors[3].pf_pit_checked) and reaches vars with no exported name (internal library vars, a map's own BEHAVIOR vars): two temp builds of the source (as is, and with a probe) find the slot, the as-is build must equal a deployed module byte for byte, and the engine uses only the loaded module whose image matches. A var the source imports from a library is refused: pass that library's source instead. A refusal names the check that failed.",
    ),
  object: z
    .string()
    .min(1)
    .optional()
    .describe("With sourceFile: the deployed WAD, PK3, directory or .o to find the source's build in, instead of the instance's launch files (needed for an attached instance)."),
  includeDirs: z
    .array(z.string().min(1))
    .optional()
    .describe("With sourceFile: include dirs searched after the source's own dir. Absolute paths; a relative one resolves against the MCP server's working directory."),
};
type SourceFileArgs = { instance: number; name: string; index?: number; value?: number } & {
  [K in keyof typeof sourceFileArgs]?: z.infer<(typeof sourceFileArgs)[K]>;
};
// Fresh per field, like mapCoord: run_acs's `name` alias must not be a $ref into `script`.
const runAcsName = () => z.string().regex(/^[^\s;"]+$/, "a script name has no spaces");
const mapFileArg = z.string().optional();

// A probe's size, bounded like a coordinate: a huge radius walks the whole blockmap per step.
const probeSize = () => z.number().positive().max(32767).optional();

/** Whether a reference sets exactly one form: {tid, index?}, {player}, {class} or {x, y, z?}. */
function oneRefForm(r: RefArg): boolean {
  const point = r.x !== undefined || r.y !== undefined || r.z !== undefined;
  const forms = [r.tid !== undefined, r.player !== undefined, r.class !== undefined, point];
  if (!exactlyOneForm(forms) || (r.index !== undefined && r.tid === undefined)) return false;
  return !point || (r.x !== undefined && r.y !== undefined);
}

/** A map probe's reference schema, held to exactly one of `forms`. */
function oneRef<T extends z.ZodType<RefArg>>(schema: T, forms: string) {
  return schema
    .refine(oneRefForm, `give exactly one of ${forms}`)
    .describe(`Exactly one of ${forms}. index picks the nth (0-based) actor sharing tid; class is the nearest one to the player (on a netgame server, which has no player of its own, the first one found).`);
}
const refFields = {
  tid: z.number().int().min(1).optional(),
  index: z.number().int().min(0).optional(),
  player: z.number().int().min(0).max(63).optional(),
  class: classArg.optional(),
};
/** An actor or a map point. */
const actorRef = oneRef(
  z
    .object({ ...refFields, x: mapCoord().optional(), y: mapCoord().optional(), z: mapCoord().optional() })
    .strict(),
  "{tid, index?}, {player}, {class} or {x, y, z?}",
);
/** An actor only. */
const moverRef = oneRef(z.object(refFields).strict(), "{tid, index?}, {player} or {class}");

/** The target of a tool that acts on one live actor, as `mcp_setprop` and the CCMDs after it take it. */
const targetArgs = {
  tid: z.number().int().min(0).optional().describe("The actor's TID; omitted or 0 = the console player's body."),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("The nth (0-based) actor sharing the TID, as find_actors' index=; needs a tid of 1 or more."),
};

/** Why a target can't be sent: index picks among actors sharing a tid, and tid 0 is one body. */
function targetRefusal(tid: number | undefined, index: number | undefined): string | undefined {
  return index !== undefined && !tid ? "index needs a tid" : undefined;
}

/** Why a one-token arg can't be sent as typed (see `isPlainToken`), if it can't. */
function tokenRefusal(name: string, value: string | undefined): string | undefined {
  return value !== undefined && !isPlainToken(value) ? `bad ${name} ${JSON.stringify(value)}` : undefined;
}

/** `set_cheat` names: each is its own stock toggle CCMD, keyed to its `CF_*` bit (d_player.h). */
const CHEATS = {
  noclip: 1 << 0,
  god: 1 << 1,
  notarget: 1 << 3,
  fly: 1 << 4,
  buddha: 1 << 27,
  noclip2: 1 << 30,
} as const;
const CHEAT_NAMES = Object.keys(CHEATS) as [keyof typeof CHEATS, ...(keyof typeof CHEATS)[]];
// A queued cheat lands on the next tic; about 2s of polling covers a busy frame.
const CHEAT_POLLS = 20;
const CHEAT_POLL_MS = 100;

// Log lines a stepping tool returns; the rest are named with a read_log resume point.
const STEP_LOG_MAX_LINES = 50;
function validRegex(p: string): boolean {
  try {
    new RegExp(p, "i");
    return true;
  } catch {
    return false;
  }
}
/** A case-insensitive regex arg, validated up front: a bad pattern fails before anything is sent or stepped. */
const regexArg = () => z.string().min(1).refine(validRegex, "not a valid regex");
const logPatternArg = regexArg()
  .optional()
  .describe("Case-insensitive regex: return only the log lines printed during the step that match it.");

// wait_for_log polls the log file this often, for up to WAIT_LOG_MAX_SEC.
const WAIT_LOG_POLL_MS = 100;
const WAIT_LOG_MAX_SEC = 120;
// join_game polls each client's status this often; a join lands about 2 tics after it is sent.
const JOIN_POLL_MS = 100;

// read_hud's default per-kind cap: dumphud holds up to 32 KB, which overflowed the tool-result limit.
const HUD_MAX_ITEMS = 100;

// Tics `ensure_live` runs the sim for to see `maptime` move.
const LIVE_PROBE_TICS = 5;
// A status read a tool depends on waits out a map load before calling it a timeout.
const STATUS_READ_MS = 3000;
// Engine log lines `read_log` returns at most, unless asked otherwise.
const LOG_LINES = 200;

/** `step_until` comparisons. */
const COMPARE = {
  "==": (a: number, b: number) => a === b,
  "!=": (a: number, b: number) => a !== b,
  "<": (a: number, b: number) => a < b,
  "<=": (a: number, b: number) => a <= b,
  ">": (a: number, b: number) => a > b,
  ">=": (a: number, b: number) => a >= b,
} as const;
const compareOp = z.enum(Object.keys(COMPARE) as [keyof typeof COMPARE, ...(keyof typeof COMPARE)[]]);
const PLAYER_FIELDS = [
  "x",
  "y",
  "z",
  "angle",
  "floorHeight",
  "sector",
  "light",
  "health",
  "armor",
] as const;
const playerField = z.enum(PLAYER_FIELDS);
/** find_actors' flag filter: a flag name or the derived alive, true = must have, false = must not. */
const actorFlags = z.object(Object.fromEntries([...FLAG_NAMES, "alive"].map((n) => [n, z.boolean().optional()]))).strict();
const conditionArg = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("mapvar"), name: acsName, op: compareOp, value: z.number() }),
  z.object({
    kind: z.literal("maparray"),
    name: acsName,
    index: z.number().int().min(0),
    op: compareOp,
    value: z.number(),
  }),
  z.object({
    kind: z.literal("acsvar"),
    scope: acsScope,
    index: z.number().int().min(0),
    op: compareOp,
    value: z.number(),
  }),
  z.object({
    kind: z.literal("player"),
    field: playerField,
    op: compareOp,
    // A second field compares against the same live read, e.g. z == floorHeight.
    value: z.union([z.number(), playerField]),
  }),
  z.object({
    kind: z.literal("actors"),
    class: classArg.optional(),
    tid: z.number().int().min(1).optional(),
    radius: z.number().int().positive().optional(),
    flags: actorFlags.optional(),
    op: compareOp,
    value: z.number(),
  }),
  z.object({ kind: z.literal("log"), pattern: regexArg() }),
]);
type Condition = z.infer<typeof conditionArg>;

const MENU_KEYS = ["up", "down", "left", "right", "enter", "back", "backspace"] as const;

const profileSort = z.enum(["total", "avg", "min", "max", "runs"]).optional();
const profileLimit = z.number().int().positive().optional();

/** Every profiled row, ranked and limited host-side, with the shown rows' truncated names resolved
 *  from the dumps, fetched only when one needs it. */
async function profileEntries(client: BridgeClient, over: string, sort: ProfileSort = "total", limit = DEFAULT_PROFILE_LIMIT) {
  const ranked = rankProfile(parseAcsProfile(await client.runCommand("acsprofile total 0")), sort, limit);
  const cut = ranked.entries.filter(isTruncated);
  const entries =
    cut.length === 0
      ? ranked.entries
      : resolveProfileNames(
          ranked.entries,
          parseModules(await client.runCommand("dumpmodules")),
          cut.some((e) => e.section === "script") ? parseScripts(await client.runCommand("dumpscripts")) : [],
          cut.some((e) => e.section === "function") ? parseFunctions(await client.runCommand("dumpfunctions")) : [],
        );
  const { scripts, functions } = ranked.profiled;
  return {
    content: [{ type: "text" as const, text: `${entries.length} of ${scripts + functions} profiled${over} (top ${limit} per section by ${sort})` }],
    // limit and sort ride along: Claude Code shows only the structured half, and they say the list is a slice.
    structuredContent: { entries, profiled: ranked.profiled, limit, sort },
  };
}

/** What both profiling tools' descriptions say about the rows they return. */
const profileRows = (note: string) =>
  appendNote(
    `Rows are the top ${DEFAULT_PROFILE_LIMIT} per section (scripts, functions) by \`sort\` (default total, all descending); ` +
      "`limit` raises that, and the reply counts every profiled row. A name the engine's 20-character column cuts " +
      "(a script name over 18 characters, since it prints quoted, or a function name over 20) is resolved from dumpscripts/dumpfunctions when exactly one name fits, else kept as the printed prefix " +
      "with truncated: true.",
    note,
  );

/** `script`, or its string-only alias `name` (a client may send a digits-only string as a number); null when both are given. */
function scriptOrName<S>(script: S | undefined, name: string | undefined): S | string | undefined | null {
  return script !== undefined && name !== undefined ? null : (script ?? name);
}

/** An isError result carrying `text`. */
function fail(text: string) {
  return { isError: true, content: [{ type: "text" as const, text }] };
}

/** `structured` plus the reply's caveat lines as `notes`, so a structured-only reader sees them too; unchanged when there are none. */
function withNotes<T extends Record<string, unknown>>(structured: T, notes: string[]): T & { notes?: string[] } {
  return notes.length > 0 ? { ...structured, notes } : structured;
}

/** The isError result for a CCMD that gave no usable reply (see `failureText`). */
function failed(output: string[]) {
  return fail(failureText(output));
}

/** One live numeric read: the value, or why there is none. */
type LiveRead = { value: number } | { error: string };

/** A one-record CCMD reply as the tool result: `text` of its `tag` record (flags expanded), which is also the structured content; `failed` without one. */
function kvReply(output: string[], tag: string, text: (rec: KvRecord) => string) {
  const line = parseKvLines(output, tag)[0];
  if (!line) return failed(output);
  const rec = expandFlags(line);
  return { content: [{ type: "text" as const, text: text(rec) }], structuredContent: { ...rec } };
}

/** A map probe's block reason as text: `actor DoomImp#7`, `line 45`, `step (rise 32)`. */
function blockText(r: KvRecord): string {
  const what = r.blocker ?? r.line;
  const size = r.rise !== undefined ? ` (rise ${r.rise})` : r.drop !== undefined ? ` (drop ${r.drop})` : "";
  return `${r.reason}${what !== undefined ? ` ${what}` : ""}${size}`;
}

/**
 * How often a slow tool reports that it's still working.
 *
 * Several tools legitimately block for a long time — `profile_window` samples
 * for up to 30s, `launch_instance` waits up to ~42s for the engine to open its
 * bridge, `screenshot` can wait ~19s on a busy frame. MCP clients apply their
 * own request timeout (often 10s) and would give up on all of these. A client
 * that resets its timeout on progress won't, so heartbeat while we wait.
 */
const PROGRESS_INTERVAL_MS = 1000;

/** A tool's registration; `scenario` (a SCENARIO_REFUSALS reason) makes run_scenario refuse it. */
interface ToolConfig<Input extends ZodRawShapeCompat> {
  title?: string;
  description?: string;
  inputSchema: Input;
  outputSchema?: ZodRawShapeCompat;
  scenario?: string;
}

/** The slice of the SDK's handler `extra` that progress reporting needs. */
interface ToolExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

// The TICRATE (35 tics/sec) is fixed in Doom.
const TICRATE = 35;
/** The refusal for a bridge without each optional cap a tool needs (`requireCap`, `missingCap`). */
const CAP_REFUSALS = {
  time:
    "This engine bridge has no time-control support (rebuild/redownload with the latest bridge).",
  event:
    "This engine bridge has no input support (rebuild with the latest bridge).",
  input:
    "This engine bridge has no scripted-input support (rebuild the engine with the latest overlay).",
  spawnfind:
    "This engine build has no free-spot search for findSpot (rebuild the engine with the latest overlay, or retry without findSpot).",
  runacsname:
    "This engine build would run a script name made of digits as a script number (rebuild the engine with the latest overlay, or rename the script); nothing sent to the engine.",
  mapslot:
    "This engine build has no slot-addressed map var access for sourceFile (rebuild the engine with the latest overlay, or retry without sourceFile for an exported name); nothing compiled or sent.",
};
type OptionalCap = keyof typeof CAP_REFUSALS;

/** The refusal when the bridge lacks `cap`, else undefined. */
function missingCap(client: BridgeClient, cap: OptionalCap): string | undefined {
  return client.supports(cap) ? undefined : CAP_REFUSALS[cap];
}

/** Throws the refusal (an error reply) when the bridge lacks `cap`. */
function requireCap(client: BridgeClient, cap: OptionalCap): void {
  const refusal = missingCap(client, cap);
  if (refusal) throw new ToolRefusal(refusal);
}
// The cleanup stop gives up quickly: when it fails the bridge is gone and an error is already on its way.
const ARMED_STOP_MS = 1000;
// Log lines kept for a timeline: its own poll replies plus what the level printed per tic.
const TIMELINE_LOG_BASE = 200;
const TIMELINE_LOG_PER_TIC = 8;

// A load tool polls status until its queued load runs: about 5 s in all.
const LOAD_READ_MS = 500;
const LOAD_WAIT_MS = 50;
const LOAD_WAITS = 9;
// About 2 tics: posted input events are processed on the next tic, not on receipt.
const INPUT_SETTLE_MS = 60;

// relaunch_instance waits up to ~2 s for a force-killed engine to free its old port.
const RELAUNCH_PORT_WAITS = 10;
const RELAUNCH_PORT_WAIT_MS = 200;

/** launch_instance's options, shared with relaunch_instance. */
function launchArgsSchemaFor(ctx: ServerContext) {
  const engine = ctx.engine;
  return {
    iwad: z
      .string()
      .optional()
      .describe(`Path to the IWAD. Defaults to ${ctx.env("IWAD")} if set, otherwise the engine's own IWAD search.`),
    files: z.array(z.string()).optional(),
    map: z.string().optional(),
    skill: z.number().int().min(1).max(5).optional(),
    fullscreen: z.boolean().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    extraArgs: z
      .array(z.string())
      .optional()
      .describe(
        `Extra engine args. A -config here replaces the default ini (${ctx.env("CONFIG")}, else ${engine.serverName}.ini beside the engine); for a private copy of it, use config: "isolated" instead.`,
      ),
    config: z
      .enum(["shared", "isolated"])
      .optional()
      .describe(
        `"shared" (default) runs on ${ctx.env("CONFIG")}, else ${engine.serverName}.ini beside the engine. "isolated" copies that ini to ${engine.serverName}-<port>.ini beside it and runs on the copy, so this instance never writes the shared one (netgame peers, parallel sessions). The copy is redone on every launch and relaunch, dropping what the previous run saved there. Can't be combined with a -config in extraArgs.`,
      ),
    wait: z
      .boolean()
      .optional()
      .describe(
        "true (default) waits for the engine's bridge and attaches. false returns once the process is spawned; the instance attaches on its first tool call, which waits for the bridge then. For an engine whose bridge opens late, e.g. a netgame host waiting for its lobby to fill.",
      ),
  };
}

/** Register every MCP tool against a context. */
export function registerTools(server: McpServer, ctx: ServerContext): void {
  const sleep = (ms: number) => ctx.io.sleep(ms);
  const engine = ctx.engine;
  const notes = engine.notes;
  const consoleLines = (lines: string[]) => cleanConsoleLines(lines, engine.consoleBar);
  const launchArgsSchema = launchArgsSchemaFor(ctx);
  const clientRuns = engine.netgame?.stepLeavesClientRunning === true;
  const stepTicsArg = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(`After the action, run the sim this many tics (35 = 1 s), leave it paused${clientRuns ? " (a netgame client is left running, as by step)" : ""} and return the log lines printed meanwhile (up to ${STEP_LOG_MAX_LINES}).`);

  /**
   * Run `work`, reporting progress while it goes. `expectedMs` is only the
   * denominator for the progress ratio — overrunning it is fine, the count just
   * stops climbing. A no-op when the client didn't ask for progress (no token).
   */
  async function withProgress<T>(
    extra: ToolExtra,
    expectedMs: number,
    message: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const progressToken = extra._meta?.progressToken;
    if (progressToken === undefined) return work();
    let elapsed = 0;
    const stop = ctx.io.every(PROGRESS_INTERVAL_MS, () => {
      elapsed += PROGRESS_INTERVAL_MS;
      // Fire-and-forget: a client that has stopped listening must not break the
      // work we're actually here to do.
      void extra
        .sendNotification({
          method: "notifications/progress",
          params: {
            progressToken,
            progress: Math.min(elapsed, expectedMs),
            total: expectedMs,
            message,
          },
        })
        .catch(() => {});
    });
    try {
      return await work();
    } finally {
      stop();
    }
  }

  // The note each client's last reply was built from, so `registerLive` prints it only on a change.
  const printedNote = new WeakMap<BridgeClient, string>();
  const engineStateField = z
    .string()
    .optional()
    .describe("The engine-state note, present only on a reply that prints one.");
  const errorField = z.string().optional().describe("An error reply's text.");

  type CallExtra = Parameters<ToolCallback<ZodRawShapeCompat>>[1];
  // Every tool by name, for run_scenario to call server-side.
  const tools = new ToolRegistry<CallExtra>();

  /** Register a tool with the server, and in `tools` under `raw` (registerLive's handler without the note); `scenario` is why run_scenario refuses it. */
  function register<Input extends ZodRawShapeCompat>(
    name: string,
    config: ToolConfig<Input>,
    handler: ToolCallback<Input>,
    raw: unknown = handler,
  ): void {
    const { scenario, ...sdkConfig } = config;
    tools.add(name, config.inputSchema as ZodRawShape, raw as ToolHandler<CallExtra>, scenario);
    server.registerTool(name, sdkConfig, handler);
  }

  /**
   * Register a tool that talks to a live engine, so its response carries a
   * short "engine state" note when something about the game is unusual
   * (paused, in a menu, dead, at intermission, ...) and that note differs from
   * the one this client's last reply was built from (`footerNote` in `parsers/status.ts`).
   *
   * A reply with `structuredContent` also carries the note as `engineState` (and an error's
   * text as `error`), since a client may show the model only the structured half.
   *
   * The `commandCount` diff decides whether to refresh: if it didn't move
   * across the handler call, the handler ran no console command (an
   * input-only tool, or a client that didn't exist until the handler created
   * it — `attach_instance`/`launch_instance`), so the cached status predates
   * whatever the handler just did. If it DID move, the handler's own command
   * already refreshed it via that command's own sentinel line, so refreshing
   * again would just be a second wasted round trip. This subsumes a
   * hand-maintained list of "tools that run a command", which would get cases
   * like `verify_menu` (runs a command only when `open` is given) wrong.
   *
   * Two invariants the wrapper must not violate:
   * - It only ever PEEKS the registry (`ctx.attachedClient`), never
   *   `ctx.clientFor` — so it can never itself open a socket or turn a
   *   successful call into a failure.
   * - It does not try/catch the handler: a thrown error (unbound instance, a
   *   `loadMap` failure) must propagate byte-identically to a plain
   *   `server.registerTool` call.
   */
  function registerLive<Input extends ZodRawShapeCompat & { instance: typeof instanceArg }>(
    name: string,
    config: ToolConfig<Input>,
    handler: ToolCallback<Input>,
  ): void {
    // TS can't carry an abstract `Input` through the SDK's own generic
    // machinery inside this function body (a known limitation of generic
    // functions built on other generics) — so the args/extra/result shapes
    // are pinned to a concrete instantiation here and the two boundaries
    // (calling `handler`, registering `wrapped`) are cast back to `Input`.
    // Every *call site* of `registerLive` still gets full inference, because
    // there `Input` is concrete, not abstract.
    type Args = { instance: number } & Record<string, unknown>;
    type Extra = Parameters<ToolCallback<{ instance: typeof instanceArg }>>[1];
    type Result = Awaited<ReturnType<ToolCallback<{ instance: typeof instanceArg }>>>;
    const rawHandler = handler as unknown as (args: Args, extra: Extra) => Promise<Result>;
    const withError = (r: Result): Result => {
      if (!r.isError || !r.structuredContent) return r;
      type Text = Extract<Result["content"][number], { type: "text" }>;
      const text = r.content.filter((c): c is Text => c.type === "text").map((c) => c.text).join("\n");
      return { ...r, structuredContent: { ...r.structuredContent, error: text } };
    };

    const fresh = async (args: Args, extra: Extra): Promise<Result> => {
      const instance = args.instance;
      const prior = ctx.attachedClient(instance);
      const before = prior?.commandCount;
      const eventsBefore = prior?.eventCount ?? 0;
      const result = await rawHandler(args, extra);
      const client = ctx.attachedClient(instance);
      const advanced = before !== undefined && client !== undefined && client.commandCount > before;
      if (client && !advanced) {
        // Posted events run on a later tic, so a same-instant read would predate them.
        if (client.eventCount > eventsBefore) await sleep(INPUT_SETTLE_MS);
        await client.refreshStatus();
      }
      return result;
    };

    const wrapped = async (args: Args, extra: Extra): Promise<Result> => {
      const result = withError(await fresh(args, extra));
      const client = ctx.attachedClient(args.instance);
      const status = client?.lastStatus;
      // No snapshot (a failed read, a capless bridge) says nothing and keeps the remembered note.
      if (!client || !status) return result;
      const note = describeStatus(status);
      const footer = footerNote(printedNote.get(client), note, result.isError === true);
      if (note) printedNote.set(client, note);
      else printedNote.delete(client);
      if (!footer) return result;
      return {
        ...result,
        content: [...result.content, { type: "text", text: footer }],
        ...(result.structuredContent && { structuredContent: { ...result.structuredContent, engineState: footer } }),
      };
    };
    const liveConfig = config.outputSchema
      ? {
          ...config,
          outputSchema: { ...config.outputSchema, engineState: engineStateField, error: errorField },
        }
      : config;
    register(name, liveConfig, wrapped as unknown as ToolCallback<Input>, fresh);
  }

  /**
   * Run `map`/`load`/`playdemo`, which only queue a load for the next tic (so the
   * command's own status line predates it), then poll status until `pending=0`.
   * Returns the output plus what the engine printed meanwhile, e.g. a load error.
   */
  async function runLoad(client: BridgeClient, cmd: string): Promise<string[]> {
    const out = await client.runCommand(cmd);
    if (!client.supports("status")) return consoleLines(out);
    // pauseext stops every tic, so polling would only burn the whole wait.
    if (client.lastStatus?.pauseext === "1" && client.lastStatus.pending === "1") {
      return [...consoleLines(out), "(focus-paused (pauseext): the load runs once ensure_live fix clears it)"];
    }
    const { settled, printed } = await awaitLoad(client);
    const caveat = settled ? [] : ["(load still pending after ~5 s; the engine-state note may predate it)"];
    return [...consoleLines([...out, ...printed]), ...caveat];
  }

  /** Poll status until no load is pending (bounded, ~5 s), keeping what the engine printed meanwhile. */
  async function awaitLoad(client: BridgeClient): Promise<{ settled: boolean; printed: string[] }> {
    const printed: string[] = [];
    // A snapshot with no pending= field (an overlay that doesn't send it) counts as settled.
    const read = async () => {
      const got = await client.readStatus(LOAD_READ_MS);
      printed.push(...got.lines);
      return got.status !== undefined && got.status.pending !== "1";
    };
    const { value: settled } = await pollUntil(read, (s) => s, {
      waits: LOAD_WAITS,
      wait: () => sleep(LOAD_WAIT_MS),
    });
    return { settled, printed };
  }

  /** Unpause for `tics`, then pause again unless `pauseAfter` is false. */
  async function runTics(client: BridgeClient, tics: number, pauseAfter = true): Promise<void> {
    client.setPause(false);
    await sleep((tics / TICRATE) * 1000);
    if (pauseAfter) client.setPause(true);
  }

  /** An instance's engine log file, or undefined when it has none (an attached instance, a log not written yet). */
  function existingLog(instance: number): string | undefined {
    const logFile = ctx.logPathFor(instance);
    return logFile && ctx.io.existsSync(logFile) ? logFile : undefined;
  }

  /** The error for a log-reading tool on an instance without an engine log, naming the file it looked for. */
  function noLog(instance: number, then = "") {
    const where = ctx.logPathFor(instance);
    return fail(`No engine log for instance ${instance}${where ? ` (looked for ${where})` : ""}. Launch it via launch_instance, which enables logging${then}.`);
  }

  /** A window of an instance's engine log, or undefined when it has none. */
  function readInstanceLog(instance: number, opts: LogWindowOptions): LogWindow | undefined {
    const log = ctx.readLog(instance);
    return log === undefined ? undefined : readLogWindow(log, opts);
  }

  /** Where an instance's engine log ends now, as a read_log sinceLine; undefined without a log. */
  function logMark(instance: number): number | undefined {
    return readInstanceLog(instance, { maxLines: 1 })?.nextLine;
  }

  /** Mark an instance's engine log now (or at `since`); the returned reader gives the window it
   *  gained since, capped at `maxLines`, or undefined without a log. */
  function logSince(instance: number, since = logMark(instance)) {
    return (maxLines: number, pattern?: string) =>
      since === undefined ? undefined : readInstanceLog(instance, { sinceLine: since, maxLines, pattern });
  }
  type LogReader = ReturnType<typeof logSince>;

  /** An instance's netgame role from its stored launch args; undefined offline or attached. */
  const netInfo = (instance: number) => netRole(ctx.launchArgsFor(instance)?.args.extraArgs, engine.netgame);

  /** The pause caveat line for a netgame instance's reply; a stepped client may be left running. */
  function netPauseNote(net: NetInfo | undefined, stepped: boolean): string[] {
    if (!net) return [];
    return [stepped && net.leftRunning ? `left running: ${net.note}` : `netgame ${net.role}: ${net.note}`];
  }

  /** A stepping tool's run of `tics`: paused again after, except where the netgame role leaves it running. */
  function runStep(client: BridgeClient, instance: number, tics: number): Promise<void> {
    return runTics(client, tics, !netInfo(instance)?.leftRunning);
  }

  /** A read command's value, with the maptime its own sentinel refreshed. */
  async function readingOf<T>(client: BridgeClient, read: () => Promise<T>): Promise<Reading<T>> {
    const value = await read();
    return { value, maptime: Number(client.lastStatus?.maptime) };
  }

  /** Why stepTics/logPattern can't run on this client, or undefined when they can. */
  function stepArgsError(client: BridgeClient, stepTics: number, logPattern: string | undefined): string | undefined {
    if (logPattern !== undefined && stepTics === 0) return "logPattern needs stepTics";
    return stepTics > 0 ? missingCap(client, "time") : undefined;
  }

  /** Run `tics` after an action and return the log lines printed meanwhile, baselined now since the
   *  engine flushes the log on every print and the action's own output mustn't repeat. */
  async function stepAndCollect(
    client: BridgeClient,
    instance: number,
    tics: number,
    extra: ToolExtra,
    pattern?: string,
  ): Promise<LogWindow | undefined> {
    const readLater = logSince(instance);
    await withProgress(extra, (tics / TICRATE) * 1000, `advancing ${tics} tic(s)`, () => runStep(client, instance, tics));
    // Refresh here since registerLive won't once a command ran, and before reading the log since
    // this round trip lands after the last tic, so that tic's lines are in it.
    await client.refreshStatus();
    const got = readLater(STEP_LOG_MAX_LINES, pattern);
    return got;
  }

  /** The reply block for a step's log window, which `quiet` drops when empty. */
  function stepLogReply(tics: number, got: LogWindow | undefined, pattern?: string, opts: { quiet?: boolean } = {}) {
    if (!got) {
      const text = opts.quiet ? [] : [`ran ${tics} tic(s); no engine log to read`];
      return { text, structured: undefined, notes: text };
    }
    const log = got.lines.map((l) => l.text);
    const structured = { log, logOmitted: got.omitted, logNextLine: got.nextLine };
    if (opts.quiet && log.length === 0) return { text: [], structured, notes: [] };
    const filter = pattern === undefined ? "" : ` matching /${pattern}/`;
    const resume = `read_log sinceLine=${got.nextLine}${pattern === undefined ? "" : ` pattern=${pattern}`}`;
    const more = got.omitted ? [`(${got.omitted} more line(s); ${resume})`] : [];
    return { text: [`log after ${tics} tic(s)${filter}:`, ...log, ...more], structured, notes: [] };
  }

  type StepArgs = { stepTics: number; logPattern?: string };

  /** An action tool's step block, with the netgame role's note: empty without stepTics. */
  async function stepBlock(client: BridgeClient, instance: number, extra: ToolExtra, { stepTics, logPattern }: StepArgs) {
    if (stepTics === 0) return { text: [], structured: undefined, notes: [] };
    const block = stepLogReply(stepTics, await stepAndCollect(client, instance, stepTics, extra, logPattern), logPattern);
    const role = netPauseNote(netInfo(instance), true);
    return { ...block, text: [...role, ...block.text], notes: [...role, ...block.notes] };
  }

  /** An action tool's reply, `lines` then the step block when stepTics is set; `notes` are the caller's caveat lines. */
  async function replyAfterStep(
    client: BridgeClient,
    instance: number,
    extra: ToolExtra,
    step: StepArgs,
    lines: string[],
    structured?: Record<string, unknown>,
    notes: string[] = [],
  ) {
    const block = await stepBlock(client, instance, extra, step);
    const merged =
      structured || block.structured ? withNotes({ ...structured, ...block.structured }, [...notes, ...block.notes]) : undefined;
    return {
      content: [{ type: "text" as const, text: [...lines, ...block.text].join("\n") }],
      ...(merged && { structuredContent: merged }),
    };
  }

  /** The last status snapshot once it carries `field`, or why it doesn't. */
  function statusField(client: BridgeClient, field: string, hint?: string) {
    return requireField(client.lastStatus, client.supports("status"), field, hint);
  }

  async function readMapVar(client: BridgeClient, name: string): Promise<LiveRead> {
    const value = parseMapVar(await client.runCommand(command("getmapvar", name)));
    return value === null ? { error: `map var '${name}' not found` } : { value };
  }

  async function readMapArray(client: BridgeClient, name: string, index: number): Promise<LiveRead> {
    const value = parseMapArray(await client.runCommand(command("getmaparray", name, index)));
    return value === null ? { error: `map array '${name}' not found` } : { value };
  }

  async function readAcsVar(client: BridgeClient, scope: string, index: number): Promise<LiveRead> {
    const output = await client.runCommand(command("getacsvar", scope, index));
    const vars = parseAcsVars(output);
    return vars.length === 0 ? { error: output.join("\n") || "no value" } : { value: vars[0].value };
  }

  /** `currentpos` plus the health/armor/liveness fields its own sentinel refreshed. */
  async function readPlayerState(client: BridgeClient) {
    const parsed = parsePlayerState(await client.runCommand("currentpos"));
    return parsed ? withLiveStatus(parsed, client.lastStatus) : null;
  }

  /** The error for a chunked tool whose sim stopped advancing, with the blocker list. */
  function stalledResult(client: BridgeClient, maptime: number) {
    const blockers = statusBlockers(client.lastStatus);
    const why = blockers.length ? blockers.join(", ") : "no blocker reported";
    const at = Number.isNaN(maptime) ? "unreadable" : `stuck at ${maptime}`;
    return fail(`the sim stopped advancing (maptime ${at}); ${why}. Try ensure_live with fix.`);
  }

  /** An armed run still active after its poll: the stall error, with `fields` beside reason stalled. */
  function stalledReply(client: BridgeClient, fields: Record<string, unknown>) {
    return { ...stalledResult(client, Number(client.lastStatus?.maptime)), structuredContent: { reason: "stalled", ...fields } };
  }

  /** A finished `mcp_input` run's trail: every row, or only its start and end. */
  async function readTrail(client: BridgeClient, all: boolean): Promise<{ start: InputRow; rows: InputRow[] } | { error: string }> {
    const reply = await client.runCommand(all ? "mcp_input trail 0" : "mcp_input trail ends");
    const parsed = parseInputTrail(reply);
    return parsed?.start ? { start: parsed.start, rows: parsed.rows } : { error: failureText(reply) };
  }

  /** `cmd`'s reply through `parse`; throws the reply's failure text when it has no such line. */
  async function readOrThrow<T>(client: BridgeClient, cmd: string, parse: (lines: string[]) => T | undefined): Promise<T> {
    const reply = await client.runCommand(cmd);
    const parsed = parse(reply);
    if (parsed === undefined) throw new Error(failureText(reply));
    return parsed;
  }

  /** `findactors` with find_actors' filters, or its output when it failed. */
  async function findActors(
    client: BridgeClient,
    f: { class?: string; tid?: number; radius?: number; limit?: number; detail?: boolean; flags?: z.infer<typeof actorFlags> },
  ): Promise<{ found: FoundActors } | { output: string[] }> {
    // The engine cuts to its limit before the host sees rows, so a flag filter
    // fetches every row (limit=0 is unlimited) and cuts after filtering.
    const want = f.flags && Object.keys(f.flags).length > 0 ? f.flags : undefined;
    const args = kvArgs({ class: f.class, tid: f.tid, radius: f.radius, limit: want ? 0 : f.limit, detail: f.detail ? 1 : undefined });
    const output = await client.runCommand(command("findactors", ...args));
    const parsed = parseFoundReply(output);
    if (!parsed) return { output };
    return { found: want ? filterFound(parsed, want, f.limit ?? FIND_ACTORS_LIMIT) : parsed };
  }

  /** Both sides of a comparing condition, or why they can't be read. */
  async function readCondition(
    client: BridgeClient,
    c: Exclude<Condition, { kind: "log" }>,
  ): Promise<{ left: number; right: number } | { error: string }> {
    if (c.kind === "actors") {
      // limit=1 is enough: past it the engine, or the flag filter, still reports the total.
      const got = await findActors(client, { class: c.class, tid: c.tid, radius: c.radius, limit: 1, flags: c.flags });
      if ("output" in got) return { error: failureText(got.output) };
      return { left: got.found.truncated?.total ?? got.found.actors.length, right: c.value };
    }
    if (c.kind === "player") {
      const state = await readPlayerState(client);
      if (!state) return { error: "no player (not in a level?)" };
      const left = state[c.field];
      const right = typeof c.value === "number" ? c.value : state[c.value];
      if (left === undefined || right === undefined) {
        return { error: "health/armor need a bridge with the status cap" };
      }
      return { left, right };
    }
    const read =
      c.kind === "mapvar"
        ? await readMapVar(client, c.name)
        : c.kind === "maparray"
          ? await readMapArray(client, c.name, c.index)
          : await readAcsVar(client, c.scope, c.index);
    return "error" in read ? read : { left: read.value, right: c.value };
  }

  /** Whether a condition holds, with both sides and the comparison as text; a log condition reads `log`'s window. */
  async function checkCondition(
    client: BridgeClient,
    c: Condition,
    log: LogReader,
  ): Promise<{ met: boolean; left: number; right: number; text: string } | { error: string }> {
    if (c.kind === "log") {
      // It runs no command, so no sentinel would refresh the maptime a stepping caller counts by.
      await client.refreshStatus();
      const win = log(1, c.pattern);
      if (!win) return { error: `no engine log to match /${c.pattern}/ in (launch_instance writes one)` };
      const n = win.lines.length + win.omitted;
      return { met: n > 0, left: n, right: 1, text: `${n} line(s) matching /${c.pattern}/` };
    }
    const r = await readCondition(client, c);
    if ("error" in r) return r;
    return { ...r, met: COMPARE[c.op](r.left, r.right), text: `${r.left} ${c.op} ${r.right}` };
  }

  function postMenuKey(
    client: { sendEvent: (a: number, b: number, c: number, d: number) => void },
    key: MenuKey,
  ) {
    const down = menuKeyEvent(key);
    client.sendEvent(down.evtype, down.subtype, down.data1, down.data2);

    // The RELEASE, which used to be missing. M_Responder latches a key into MenuButtons[] on the way
    // down and unlatches it on the way up, and M_Ticker repeats whatever is still latched -- so a
    // single unreleased "down" walked the selection down the whole list and kept going. Without this
    // the caller is testing an auto-repeat, not a keypress.
    const up = menuKeyUpEvent(key);
    client.sendEvent(up.evtype, up.subtype, up.data1, up.data2);
  }

  // --- commands, cheats & input ---------------------------------------------
  registerLive(
    "run_command",
    {
      title: "Run console command",
      description:
        appendNote(
          `Send a raw console command to a running, bridge-patched ${engine.displayName} instance and return its captured output. Cheats and queued commands print their result a tic later, outside the reply: stepTics then runs the sim that many tics and returns the log lines printed meanwhile (logPattern filters them), leaving the game paused like step.`,
          notes.runCommand,
        ),
      inputSchema: { instance: instanceArg, text: z.string().min(1), stepTics: stepTicsArg, logPattern: logPatternArg },
    },
    async ({ instance, text, stepTics, logPattern }, extra) => {
      const refusal = engine.refuseCommand(text);
      if (refusal) return fail(refusal);
      const client = await ctx.clientFor(instance);
      const stepError = stepArgsError(client, stepTics, logPattern);
      if (stepError) return fail(stepError);
      // Each raw print carries its own newline; cleaned, a line is one entry.
      const output = consoleLines(await client.runCommand(text));
      // Without stepTics the reply stays text-only, so nothing in it is hidden.
      const structured = stepTics > 0 ? { output } : undefined;
      return replyAfterStep(client, instance, extra, { stepTics, logPattern }, [output.join("\n") || "(no output)"], structured);
    },
  );

  registerLive(
    "list_actor_classes",
    {
      title: "List actor classes",
      description:
        `Run \`dumpactors\` and return the registered ${notes.actorClasses} classes as structured data.`,
      inputSchema: { instance: instanceArg },
      outputSchema: {
        actors: z.array(
          z.object({
            name: z.string(),
            edNum: z.number(),
            spawnId: z.number(),
            filter: z.string(),
            source: z.string(),
          }),
        ),
      },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand("dumpactors");
      const actors = parseDumpActors(output);
      return {
        content: [{ type: "text", text: `${actors.length} actor classes` }],
        structuredContent: { actors },
      };
    },
  );

  registerLive(
    "summon",
    {
      title: "Summon actor",
      description:
        "Spawn an actor of the given class at the player's position (use summon_at for exact map coordinates).",
      inputSchema: {
        instance: instanceArg,
        className: z.string().min(1),
        kind: z.enum(["normal", "friend", "foe"]).default("normal"),
      },
    },
    async ({ instance, className, kind }) => {
      const verb = kind === "friend" ? "summonfriend" : kind === "foe" ? "summonfoe" : "summon";
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command(verb, className));
      return { content: [{ type: "text", text: output.join("\n") || `summoned ${className}` }] };
    },
  );

  registerLive(
    "summon_at",
    {
      title: "Summon actor at coordinates",
      description:
        `Run \`mcp_spawnat\`: spawn an actor at exact map x/y (z defaults to the floor, angle in degrees, 0 east) and report it in the same call, even while ${notes.summonAtWhile} (it thinks once the sim runs). The reply's class is the actual spawned class after any mod replacement (requested= shows the asked-for name when it differs); use it and the returned tid for follow-ups with find_actors/actor_state. tid defaults to a fresh unique TID; tid 0 means none. kind friend/foe matches summonfriend/summonfoe. The spawn is refused, reporting why, ${notes.summonAtRefusals} ` +
        "With findSpot (a radius in map units), a blocked spot is searched outward instead: the actor goes to the nearest spot within that radius where it fits with no wall between (not a walkability check) and the reply reports moved=, its distance from the requested point; if none is free the spawn is refused with the requested spot's own reason. Lights and missiles are never moved. findSpot can't be combined with force. " +
        "Every spot tested, the requested one included, is a real collision check: a missile damages what it overlaps before it is refused, an overlapped TOUCHY actor dies and a BUMPSPECIAL actor's special can fire. " +
        "health, special + args (up to 5, zero-padded), ambush and dormant are set at spawn time. Missile classes spawn inert.",
      inputSchema: {
        instance: instanceArg,
        className: classArg,
        x: mapCoord(),
        y: mapCoord(),
        z: mapCoord().optional(),
        angle: z.number().finite().optional(),
        tid: z.number().int().min(0).optional(),
        kind: z.enum(["normal", "friend", "foe"]).default("normal"),
        force: z.boolean().optional(),
        findSpot: z.number().positive().max(256).optional(),
        health: z.number().int().min(1).optional(),
        special: z.number().int().min(0).max(255).optional(),
        args: z.array(z.number().int()).max(5).optional(),
        ambush: z.boolean().optional(),
        dormant: z.boolean().optional(),
      },
    },
    async ({ instance, className: cls, x, y, z: zPos, angle, tid, kind, force, findSpot, health, special, args, ambush, dormant }) => {
      if (args !== undefined && special === undefined) {
        return fail("args needs special");
      }
      // force skips the fit test the search is the answer to, so the engine would drop find.
      if (findSpot !== undefined && force) {
        return fail("findSpot needs force off");
      }
      const padded = args && [...args, 0, 0, 0, 0, 0].slice(0, 5).join(",");
      const kv = kvArgs({
        z: zPos,
        angle,
        tid,
        kind: kind === "normal" ? undefined : kind,
        force: force ? 1 : undefined,
        find: findSpot,
        health,
        special,
        args: padded,
        ambush: ambush ? 1 : undefined,
        dormant: dormant ? 1 : undefined,
      });
      const client = await ctx.clientFor(instance);
      // A bridge without the search ignores find=, and its plain reply would pass for a real one.
      if (findSpot !== undefined) requireCap(client, "spawnfind");
      const output = await client.runCommand(command("mcp_spawnat", cls, realToken(x), realToken(y), ...kv));
      return kvReply(output, "spawned", (spawned) => {
        const hint = spawned.tid
          ? `; follow up with actor_state(tid ${spawned.tid}) / find_actors(class, tid)`
          : "; no tid, so find it with find_actors(class) by position";
        const moved = spawned.moved === undefined ? "" : ` (moved ${spawned.moved} from the blocked spot)`;
        return `spawned ${spawned.class} tid=${spawned.tid} at ${spawned.x},${spawned.y},${spawned.z}${moved}${hint}`;
      });
    },
  );

  registerLive(
    "set_actor_prop",
    {
      title: "Read or set an actor property",
      description:
        "Run `mcp_setprop`: read or write one property on any live actor, the player's body included. Target: tid (omitted or 0 = the console player's body) and index (the nth actor sharing the tid, as find_actors' index=; needs a tid). " +
        `Props: ${PROP_NAMES.join(", ")}, or flag:NAME for any DECORATE/ZScript flag name (value true/false; a flag-group prefix such as ACTOR.SHOOTABLE or INVENTORY.QUIET is accepted, an actor class name is not). ` +
        "Numbers are map units/plain values, not ACS fixed point; alpha clamps to 0..1, scale sets both axes, renderstyle takes a DECORATE style name, nametag may hold spaces. " +
        "Omit value to read the prop instead (old= only). A write reports old= and new= (read back, so a clamp shows), plus the actor's class/tid/hp/position/flags/name; damage reads func/expr for computed damage. " +
        "health <= 0 kills the actor as a world kill (died=1, removed=1 if it was destroyed); a dead actor's health is refused. height/radius are refused, reporting what blocks, when the actor wouldn't fit; force skips that test. " +
        "friendly also updates the monster count; dormant reports noop=1 when the dormant bit didn't change (only a live monster's flips; lights and the like toggle without it). " +
        `The write is direct, so it works while paused, but the actor only acts on it once the sim runs. ${notes.setActorProp}`,
      inputSchema: {
        instance: instanceArg,
        ...targetArgs,
        prop: z.union([z.enum(PROP_NAMES), z.string().regex(FLAG_PROP)]),
        value: z.union([z.string(), z.number(), z.boolean()]).optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ instance, tid, index, prop, value, force }) => {
      const refusal = targetRefusal(tid, index);
      if (refusal) return fail(refusal);
      if (force !== undefined && (!FORCEABLE_PROPS.has(prop) || value === undefined)) {
        return fail("force only applies to writing height or radius");
      }
      let tokens: string[];
      try {
        tokens = encodePropValue(prop, value);
      } catch (e) {
        return fail((e as Error).message);
      }
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(
        command("mcp_setprop", tid ?? 0, index ?? 0, prop, ...tokens, ...kvArgs({ force: force ? 1 : undefined })),
      );
      return kvReply(output, "setprop", (rec) => {
        let text: string;
        if (prop === "nametag") text = value === undefined ? `nametag = ${rec.name}` : `${rec.class}#${rec.tid} nametag: ${rec.name}`;
        else if (value === undefined) text = `${prop} = ${rec.old}`;
        else text = `${rec.class}#${rec.tid} ${prop}: ${rec.old} -> ${rec.new}`;
        return text + markerText(rec, ["died", "removed", "noop"]);
      });
    },
  );

  registerLive(
    "place_actor",
    {
      title: "Move, turn or launch an actor",
      description:
        "Run `mcp_place`: move, turn and/or launch any live actor in one call and report it after (fromx/fromy/fromz: where it was). Target: tid and index, as set_actor_prop's. " +
        "x/y/z in map units: a missing x or y keeps the current one; without z, a given x or y puts the actor on the floor there, else z stays. " +
        "The move is Thing_Move's fit-tested teleport, judged as summon_at judges a spawn, and never telefrags: where the actor wouldn't fit it is refused, reporting what blocks (an actor, a line or the floor/ceiling fit), and then nothing is applied, angle and velocity included. force skips that test; fog spawns teleport fog at both spots. " +
        "The test is a real collision check, as summon_at's: an overlapped TOUCHY actor dies, a BUMPSPECIAL actor's special can fire and a missile damages what it overlaps. " +
        "angle and pitch in degrees (0 east, 90 north; pitch negative looks up). vx/vy/vz in map units per tic set the velocity (a missing axis keeps its own), or add to it with addVelocity. " +
        "Applied in that order (position, facing, velocity), so a move-and-launch isn't stopped. " +
        appendNote(`The write is direct, so it works while paused, but the actor only acts on it once the sim runs. ${notes.actorWrites}`, notes.placeActor),
      inputSchema: {
        instance: instanceArg,
        ...targetArgs,
        x: mapCoord().optional(),
        y: mapCoord().optional(),
        z: mapCoord().optional(),
        angle: z.number().finite().optional(),
        pitch: z.number().min(-90).max(90).optional(),
        vx: mapCoord().optional(),
        vy: mapCoord().optional(),
        vz: mapCoord().optional(),
        addVelocity: z.boolean().optional(),
        fog: z.boolean().optional(),
        force: z.boolean().optional(),
      },
    },
    async ({ instance, tid, index, x, y, z: zPos, angle, pitch, vx, vy, vz, addVelocity, fog, force }) => {
      const moving = [x, y, zPos].some((v) => v !== undefined);
      const launching = [vx, vy, vz].some((v) => v !== undefined);
      const refusal = targetRefusal(tid, index);
      if (refusal) return fail(refusal);
      if (!moving && !launching && angle === undefined && pitch === undefined) {
        return fail("give at least one of x, y, z, angle, pitch, vx, vy, vz");
      }
      if ((fog || force) && !moving) return fail("fog and force need x, y or z");
      if (addVelocity && !launching) return fail("addVelocity needs vx, vy or vz");
      const kv = kvArgs({
        x,
        y,
        z: zPos,
        angle,
        pitch,
        vx,
        vy,
        vz,
        addvel: addVelocity ? 1 : undefined,
        fog: fog ? 1 : undefined,
        force: force ? 1 : undefined,
      });
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command("mcp_place", tid ?? 0, index ?? 0, ...kv));
      return kvReply(
        output,
        "placed",
        (rec) =>
          `${rec.class}#${rec.tid} at ${rec.x},${rec.y},${rec.z} (from ${rec.fromx},${rec.fromy},${rec.fromz}), ` +
          `angle ${rec.angle}, pitch ${rec.pitch}, velocity ${rec.vx},${rec.vy},${rec.vz}${markerText(rec, ["fog", "forced"])}`,
      );
    },
  );

  registerLive(
    "remove_actor",
    {
      title: "Remove an actor",
      description:
        "Run `mcp_remove`: remove the actor with this tid (index: the nth sharing it) or, with all, every actor with it, as Thing_Remove does: no death, and it leaves the kill/item totals. " +
        "A live player's body is never removed; it is reported as skipped. The reply lists each removed actor as it was, plus the count. " +
        appendNote(notes.actorWrites, notes.removeActor),
      inputSchema: {
        instance: instanceArg,
        tid: z.number().int().min(1).describe("The actor's TID; required, so the player's body can't be named."),
        index: targetArgs.index,
        all: z.boolean().optional().describe("Remove every actor with the tid; can't be combined with index."),
      },
    },
    async ({ instance, tid, index, all }) => {
      if (all && index !== undefined) return fail("all and index can't be combined");
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command("mcp_remove", tid, index ?? 0, ...kvArgs({ all: all ? 1 : undefined })));
      const total = parseKvLines(output, "removed_total")[0];
      if (!total) return failed(output);
      const removed = parseKvLines(output, "removed");
      const { text, skipped } = describeRemoved(total, removed);
      return { content: [{ type: "text", text }], structuredContent: { removed, count: total.count, ...(skipped && { skipped }) } };
    },
  );

  registerLive(
    "damage_actor",
    {
      title: "Damage an actor",
      description:
        "Run `mcp_damage`: damage any live actor through the engine's own damage path, as Thing_Damage does: per-type damage factors, pain and death states apply (damageType Extreme forces the extreme death). Target: tid and index, as set_actor_prop's. " +
        "amount 1..1000000; 1000000 is telefrag damage and gets through god mode and invulnerability. " +
        "sourceTid (0 = the console player's body) names who dealt it: the target turns on it (target= in find_actors) and, in a netgame, a player source gets the kill credit; single player credits every counted kill to player 0 whatever the source. " +
        "The reply reports hp before and after (oldhp=, dealt=), nodamage=1 when nothing was lost (not shootable, invulnerable, god mode or a damage factor of 0), died=1 and removed=1. A dead target is refused; heal with set_actor_prop health. " +
        `The write is direct, so it works while paused; the actor reacts once the sim runs. ${notes.actorWrites}`,
      inputSchema: {
        instance: instanceArg,
        ...targetArgs,
        amount: z.number().int().min(1).max(1000000),
        damageType: classArg.optional().describe("A damage type name such as Fire or Extreme; default None."),
        sourceTid: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Who dealt it: an actor's TID, 0 = the console player's body; omitted = no source."),
      },
    },
    async ({ instance, tid, index, amount, damageType, sourceTid }) => {
      const refusal = targetRefusal(tid, index) ?? tokenRefusal("damageType", damageType);
      if (refusal) return fail(refusal);
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(
        command("mcp_damage", tid ?? 0, index ?? 0, amount, ...kvArgs({ type: damageType, source: sourceTid })),
      );
      return kvReply(
        output,
        "damaged",
        (rec) =>
          `${rec.class}#${rec.tid} took ${rec.dealt} ${rec.type} damage: hp ${rec.oldhp} -> ${rec.hp}` +
          markerText(rec, ["nodamage", "died", "removed"]),
      );
    },
  );

  registerLive(
    "set_cheat",
    {
      title: "Set a cheat on or off",
      description:
        `Idempotently turn a player cheat on or off. Reads the cheat bit from the engine-state snapshot and only runs the stock toggle CCMD (god, notarget, ...) when it differs, then waits for the bit to flip, so a blind toggle can never switch it the wrong way. ${notes.setCheat} Needs a bridge with the status cap and a cheats= field.`,
      inputSchema: {
        instance: instanceArg,
        name: z.enum(CHEAT_NAMES),
        on: z.boolean(),
      },
    },
    async ({ instance, name, on }) => {
      const client = await ctx.clientFor(instance);
      const bit = CHEATS[name];
      const read = () => {
        const cheats = client.lastStatus?.cheats;
        return cheats === undefined ? undefined : (Number(cheats) & bit) !== 0;
      };
      await client.readStatus(STATUS_READ_MS);
      const snap = statusField(client, "cheats", ", or there is no player");
      if ("error" in snap) return fail(`can't read cheat state: ${snap.error}`);
      // Fires only when the overlay sends pauseext.
      if (snap.status.pauseext === "1") {
        return fail("the engine is paused by focus loss (pauseext), so a cheat toggle would be deferred; run ensure_live with fix first");
      }
      const want = on ? "on" : "off";
      if (read() === on) {
        return { content: [{ type: "text", text: `${name} already ${want}; no change` }] };
      }
      const output = await client.runCommand(name);
      const { value } = await pollUntil(read, (v) => v === on, {
        waits: CHEAT_POLLS,
        wait: async () => {
          await sleep(CHEAT_POLL_MS);
          await client.refreshStatus();
        },
      });
      if (value !== on) {
        const said = outputText(output);
        return fail(`${name} did not turn ${want}; the engine said: ${said}`);
      }
      return { content: [{ type: "text", text: `${name} ${want}` }] };
    },
  );

  /** give/take's arguments: `tid` switches from the stock command to `mcp_inv`. */
  const inventoryArgs = {
    instance: instanceArg,
    item: classArg,
    amount: z.number().int().positive().optional(),
    ...targetArgs,
  };
  /** give/take's description from "With a tid" on; `held` says what held= names for that op. */
  const inventoryTidText = (acs: string, held: string) =>
    `With a tid (0 = the console player's body; index as set_actor_prop's), run \`mcp_inv\` on any live actor instead, as ACS ${acs} does (class names only), and report held=, ${held}, with before= and after=. `;
  const inventoryClose = appendNote(`The write is direct, so it works while paused. ${notes.actorWrites}`, notes.inventory);

  /** give/take: the stock command without a tid, else `mcp_inv` on the target, reporting before and after. */
  async function runInventory(
    op: "give" | "take",
    done: string,
    { instance, item, amount, tid, index }: { instance: number; item: string; amount?: number; tid?: number; index?: number },
  ) {
    const refusal = targetRefusal(tid, index) ?? (tid === undefined ? undefined : tokenRefusal("item", item));
    if (refusal) return fail(refusal);
    const client = await ctx.clientFor(instance);
    const amountArg = amount !== undefined ? [amount] : [];
    if (tid === undefined) {
      const output = await client.runCommand(command(op, item, ...amountArg));
      return { content: [{ type: "text" as const, text: output.join("\n") || `${done} ${item}` }] };
    }
    const output = await client.runCommand(command("mcp_inv", tid, index ?? 0, op, item, ...amountArg));
    return kvReply(output, "inv", (rec) => {
      const refused = rec.ok === 0 ? " (pickup refused)" : "";
      return `${op} ${rec.item} on ${rec.class}#${rec.tid}: ${rec.held} ${rec.before} -> ${rec.after}${refused}`;
    });
  }

  registerLive(
    "give",
    {
      title: "Give item",
      description:
        "Give an inventory item. Without a tid, the stock `give` command to the player (cheat names such as all, weapons and health work). " +
        inventoryTidText(
          "GiveInventory",
          "the class the amount is kept under (armor: the player's armor class; an ammo pickup: its parent ammo, e.g. ClipBox: Clip; a Health item: health; anything else: itself)",
        ) +
        "amount (default 1) is ACS's: it sets the item's amount, unclamped, so a Health item heals that much (a Medikit with the default 1 heals 1), an ammo pickup gives that many rounds (times the skill's ammo factor), not its pickup size (a ClipBox with the default 1 gives 1 Clip), and an armor pickup's armor is multiplied by it. " +
        "With a tid, a bare Armor gives nothing, as in ACS (it is a BasicArmorPickup worth 0), so name a real armor class such as GreenArmor or BlueArmor. " +
        "An item that turns into something else on pickup (a powerup giver, custom inventory) can read 0 -> 0. ok=0 when the pickup was refused (e.g. health already at max). A given weapon isn't raised. " +
        inventoryClose,
      inputSchema: inventoryArgs,
    },
    (args) => runInventory("give", "gave", args),
  );

  registerLive(
    "take",
    {
      title: "Take item",
      description:
        "Remove an inventory item. Without a tid, the stock `take` command on the player. " +
        inventoryTidText("TakeInventory", "the item class itself, the only class looked up") +
        "So taking an ammo or armor pickup or a Health item (ClipBox, GreenArmor, Medikit) takes nothing: name what is held (Clip, Armor). " +
        "amount (default 1) is taken from the item itself; ammo and armor stay in the inventory at 0. " +
        inventoryClose,
      inputSchema: inventoryArgs,
    },
    (args) => runInventory("take", "took", args),
  );

  registerLive(
    "load_map",
    {
      title: "Load map",
      description:
        "Load a map by its lump name (e.g. MAP01, E1M1). Cheats such as god and notarget reset with the map: set them again with set_cheat.",
      inputSchema: { instance: instanceArg, mapName: z.string().min(1) },
    },
    async ({ instance, mapName }) => {
      const client = await ctx.clientFor(instance);
      const output = await runLoad(client, command("map", mapName));
      return { content: [{ type: "text", text: output.join("\n") || `loaded ${mapName}` }] };
    },
  );

  registerLive(
    "list_running_scripts",
    {
      title: "List running ACS scripts",
      description:
        "Run `scriptstat` and return the currently running ACS scripts and their states.",
      inputSchema: { instance: instanceArg },
      outputSchema: {
        scripts: z.array(
          z.object({
            number: z.number().nullable(),
            name: z.string().nullable(),
            state: z.string(),
          }),
        ),
      },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand("scriptstat");
      const scripts = parseScriptStat(output);
      return {
        content: [{ type: "text", text: `${scripts.length} running script(s)` }],
        structuredContent: { scripts },
      };
    },
  );

  registerLive(
    "run_script",
    {
      title: "Run ACS script",
      description:
        "Run an ACS script by number or name, with up to 4 integer arguments. `name` is an alias for a named `script`; a string is always a name, even one made of digits. " +
        "The script runs inside this call until its first delay, so the reply carries its result value (what SetResultValue set; the engine default is 1 when it never did) and the Log() lines it printed (Print() is a HUD message: use read_hud). " +
        "A script that paused (at a delay or a wait) reports the value so far with finished=false. One that is already running is not started again (started=false) unless always is set; a suspended copy (ACS_Suspend) resumes instead, with its own args, and reports started=true. " +
        "The script comes from the first loaded module that has it (module in the reply, numbered as list_modules does), so a run_acs snippet loaded again under the same script name still runs the earlier copy: give the script a new name each time. " +
        "On a netgame, or a bridge without the runscript cap, the script is queued with puke/pukename instead: it runs a tic later and no result or output comes back. " +
        "stepTics then runs the sim that many tics and returns the log lines printed meanwhile (what the script logs after its delays; logPattern filters them), leaving the game paused like step.",
      inputSchema: {
        instance: instanceArg,
        script: z.union([z.number().int(), z.string().min(1)]).optional(),
        name: z.string().min(1).optional(),
        args: z.array(z.number().int()).optional(),
        always: z.boolean().optional(),
        stepTics: stepTicsArg,
        logPattern: logPatternArg,
      },
    },
    async ({ instance, script: byScript, name, args, always, stepTics, logPattern }, extra) => {
      const script = scriptOrName(byScript, name);
      if (script == null) return fail("pass exactly one of script or name");
      const client = await ctx.clientFor(instance);
      const stepError = stepArgsError(client, stepTics, logPattern);
      if (stepError) return fail(stepError);
      const respond = (lines: string[], structured?: Record<string, unknown>, notes?: string[]) =>
        replyAfterStep(client, instance, extra, { stepTics, logPattern }, lines, structured, notes);
      // The stock net command: the script runs a tic later, so there is no result to read.
      const puke = async (notes: string[]) => {
        const cmd =
          typeof script === "number" ? buildPuke(script, args, always) : buildPukeName(script, args, always);
        const output = consoleLines(await client.runCommand(cmd));
        const line = (output.join("\n") || `ran ${script}`) + notes.map((n) => ` (${n})`).join("");
        // As run_command: without stepTics the reply stays text-only.
        return respond([line], stepTics > 0 ? { output } : undefined, notes);
      };
      if (!client.supports("runscript")) return puke([]);
      const output = (await client.runCommand(buildRunScript(script, args, always))).map(stripColor);
      const reply = parseRunScript(output);
      if (!reply) return firstError(output) === "netgame" ? puke(["netgame: no result value"]) : failed(output);
      const { printed } = scriptOutput(output, "MCP_RUNSCRIPT");
      const paused = reply.finished ? "" : " (paused at a delay or a wait: the result is its value so far)";
      const which = `${script} (module ${reply.module})`;
      const head = reply.started
        ? `ran ${which}: result ${reply.result}${paused}`
        : `${which} is already running (pass always to start another copy)`;
      const { result, finished, started, module } = reply;
      return respond([head, ...printed], { result, finished, started, module, output: printed });
    },
  );

  registerLive(
    "run_acs",
    {
      title: "Hot-load and run an ACS snippet",
      description:
        `Compile full ACS source host-side (bcc by default: zt-bcc or bcc on PATH, with zt-bcc's lib/ found next to or one folder above the binary; or acc on PATH; ${ctx.env("BCC")}/${ctx.env("ACC")} override the executables) and load it into the running level as a temporary module, then optionally run one of its scripts by number or name with up to 4 args (a string script is always a name, even one made of digits; \`name\` is an alias for a named \`script\`). The script runs inside this call until its first delay, so its Log() output comes back in the reply (Print() is a HUD message: use read_hud); stepTics then runs the sim that many tics and returns the log lines printed meanwhile (logPattern filters them). A snippet that isn't a #library is compiled as one, so its strings resolve. It may #import a library the level already loaded (pass includeDirs for its source) and then shares that library's live functions and map vars; importing a library that isn't loaded is refused before anything is sent. ${ctx.env("RUNACS_PROFILES")} lists per-project profile files: a profile applies when the snippet #imports one of its libraries, adding its include dirs and its defines (which #import doesn't carry) ahead of the snippet, and the reply names it (profile: <file>); a profile with rawDefines makes the snippet's own #defines case-sensitive. open runs its OPEN scripts. Compile errors come back without touching the engine. ${notes.runAcs} save_game refuses: a save would fail to load (in-game saves and leaving a hub level carry the same hazard, which this tool can't intercept).`,
      inputSchema: {
        instance: instanceArg,
        source: z.string().min(1),
        script: z.union([z.number().int(), runAcsName()]).optional(),
        name: runAcsName().optional(),
        args: z.array(z.number().int()).max(4).optional(),
        compiler: z.enum(["bcc", "acc"]).default("bcc"),
        includeDirs: z
          .array(z.string().min(1))
          .optional()
          .describe("Absolute paths; a relative one resolves against the MCP server's working directory."),
        open: z.boolean().optional(),
        stepTics: stepTicsArg,
        logPattern: logPatternArg,
      },
    },
    async ({ instance, source, script: byScript, name, args, compiler, includeDirs, open, stepTics, logPattern }, extra) => {
      const script = scriptOrName(byScript, name);
      if (script === null) return fail("pass script or name, not both");
      if (args !== undefined && script === undefined) return fail("args needs script");
      const client = await ctx.clientFor(instance);
      const stepError = stepArgsError(client, stepTics, logPattern);
      if (stepError) return fail(stepError);
      // An older overlay would take name=1 as a script arg and a digits-only name as a number.
      const markName = client.supports("runacsname");
      if (!markName && typeof script === "string" && /^[+-]?\d+$/.test(script)) throw new ToolRefusal(CAP_REFUSALS.runacsname);
      // A blank env var means unset, so PATH is searched.
      const exe = ctx.config[compiler]?.trim() || undefined;
      let profiles: RunAcsProfile[];
      let prelude: Prelude | undefined;
      try {
        profiles = ctx.runAcsProfiles(source);
        prelude = buildPrelude(profiles, (p) => ctx.io.readTextSync(p));
      } catch (e) {
        return fail(`${(e as Error).message}; nothing sent to the engine`);
      }
      const profileLines = profiles.map((p) => `profile: ${p.file}`);
      const dirs = [...new Set([...(includeDirs ?? []).map((d) => path.resolve(d)), ...profiles.flatMap((p) => p.includeDirs)])];
      const built = ctx.io.compileAcs({ compiler, exe, source, includeDirs: dirs.length > 0 ? dirs : undefined, prelude, engine });
      let output: string[];
      try {
        if (!built.ok) {
          const which = built.exe === undefined ? compiler : `${compiler}: ${built.exe}`;
          return fail([`compile failed (${which}), nothing sent to the engine:`, built.diagnostics, ...profileLines].join("\n"));
        }
        // The engine can't unload a module it rejects, so catch what we can first.
        const obj = ctx.io.readFileSync(built.object);
        if (!isAcsObject(obj)) return fail(`${compiler} produced no ACS object; nothing sent to the engine`);
        const imports = parseLoadNames(obj);
        if (imports.length > 0) {
          const loaded = parseModules(await client.runCommand("dumpmodules")).map((m) => m.name);
          const missing = missingImports(imports, loaded);
          if (missing.length > 0) {
            return fail(`imports ${missing.join(", ")}, not loaded in this level; nothing sent to the engine`);
          }
        }
        // Engine errors like "Could not find ACS library" carry TEXTCOLOR_RED escapes.
        output = (await client.runCommand(buildRunAcs(built.token, script, args, open, markName))).map(stripColor);
      } finally {
        ctx.io.removeDir(built.dir);
      }
      const { lines: outLines, printed } = scriptOutput(output, "MCP_RUNACS");
      const reply = parseRunAcs(output);
      if (!reply) return fail(outputText(outLines));

      const block = await stepBlock(client, instance, extra, { stepTics, logPattern });
      return {
        content: [{ type: "text", text: runAcsText(reply, [...profileLines, ...printed, ...block.text]) }],
        structuredContent: withNotes(
          {
            ...reply,
            output: printed,
            ...(profiles.length > 0 ? { profiles: profiles.map((p) => p.file) } : {}),
            ...block.structured,
          },
          [...block.notes, ...runAcsCaveats(reply)],
        ),
      };
    },
  );

  registerLive(
    "screenshot",
    {
      scenario: SCENARIO_REFUSALS.image,
      title: "Screenshot",
      description: "Take a screenshot of the game and return it as an image so it can be viewed.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }, extra) => {
      const client = await ctx.clientFor(instance);
      const shot = await withProgress(extra, 19000, "capturing screenshot", () =>
        ctx.io.capture(client, ctx.config.screenshotDir),
      );
      return { content: [{ type: "image", data: shot.base64, mimeType: "image/png" }] };
    },
  );

  registerLive(
    "screenshot_file",
    {
      title: "Screenshot to a file",
      description:
        appendNote(
          "Take a screenshot and leave it on disk, returning only its absolute path (no image content). For measuring pixels with a script instead of viewing the frame. A reused `name` overwrites that file.",
          notes.screenshotFile,
        ),
      inputSchema: {
        instance: instanceArg,
        // No spaces or `;`: the name goes unquoted into a console command line.
        name: z
          .string()
          .regex(/^[\w-]+$/, "letters, digits, _ and - only (no extension)")
          .optional(),
      },
    },
    async ({ instance, name }, extra) => {
      const client = await ctx.clientFor(instance);
      const shot = await withProgress(extra, 19000, "capturing screenshot", () =>
        ctx.io.capture(client, ctx.config.screenshotDir, { name, keep: true }),
      );
      const file = path.resolve(shot.path);
      return { content: [{ type: "text", text: file }], structuredContent: { path: file } };
    },
  );

  registerLive(
    "menu_key",
    {
      title: "Press a menu key",
      description: "Send a single menu navigation key (GUI key event) to the active menu.",
      inputSchema: { instance: instanceArg, key: z.enum(MENU_KEYS) },
    },
    async ({ instance, key }) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "event");
      postMenuKey(client, key);
      return { content: [{ type: "text", text: `sent ${key}` }] };
    },
  );

  registerLive(
    "menu_nav",
    {
      title: "Navigate a menu",
      description:
        'Send a sequence of menu keys (e.g. ["down","down","enter"]) with a small delay between each.',
      inputSchema: { instance: instanceArg, steps: z.array(z.enum(MENU_KEYS)).min(1) },
    },
    async ({ instance, steps }, extra) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "event");
      await withProgress(extra, steps.length * 60, "sending menu keys", async () => {
        for (const key of steps) {
          postMenuKey(client, key);
          await sleep(60);
        }
      });
      return {
        content: [{ type: "text", text: `sent ${steps.length} key(s): ${steps.join(" ")}` }],
      };
    },
  );

  registerLive(
    "menu_text",
    {
      title: "Type into a menu text field",
      description:
        "Type a string into the active menu text-entry field (e.g. the player name box after pressing enter on it), one character at a time.",
      inputSchema: { instance: instanceArg, text: z.string().min(1) },
    },
    async ({ instance, text }, extra) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "event");
      await withProgress(extra, text.length * 40, "typing", async () => {
        for (const ch of text) {
          const ev = charEvent(ch);
          client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
          await sleep(40);
        }
      });
      return { content: [{ type: "text", text: `typed "${text}"` }] };
    },
  );

  registerLive(
    "mouse_move",
    {
      title: "Move the mouse pointer",
      description:
        "Move the pointer to a screen position, in pixels from the top-left of the game window. Drives hover-only UI -- tooltips, hot states -- which nothing else here can reach.",
      inputSchema: { instance: instanceArg, x: z.number().int(), y: z.number().int() },
    },
    async ({ instance, x, y }) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "event");
      const ev = mouseMoveEvent(x, y);
      client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
      return { content: [{ type: "text", text: `pointer at ${x},${y}` }] };
    },
  );

  registerLive(
    "mouse_click",
    {
      title: "Click or drag the mouse",
      description:
        "Press and release the left button at a position. Give toX/toY to DRAG: press at the first point, move through it, release at the second. `double` sends a double-click.",
      inputSchema: {
        instance: instanceArg,
        x: z.number().int(),
        y: z.number().int(),
        toX: z.number().int().optional(),
        toY: z.number().int().optional(),
        double: z.boolean().optional(),
      },
    },
    async ({ instance, x, y, toX, toY, double }) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "event");
      const post = (e: { evtype: number; subtype: number; data1: number; data2: number }) =>
        client.sendEvent(e.evtype, e.subtype, e.data1, e.data2);

      // Move first: menus track the pointer from motion, so a click at a position they have never
      // seen the pointer at lands on whatever was hovered last.
      post(mouseMoveEvent(x, y));
      await sleep(20);
      post(mouseButtonEvent(x, y, true, double === true));
      await sleep(30);

      if (toX !== undefined && toY !== undefined) {
        // Intermediate positions, because a drag that jumps straight to the end never gives the menu
        // the motion it is meant to be tracking.
        for (let i = 1; i <= 4; i++) {
          post(
            mouseMoveEvent(
              Math.round(x + ((toX - x) * i) / 4),
              Math.round(y + ((toY - y) * i) / 4),
            ),
          );
          await sleep(20);
        }
        post(mouseButtonEvent(toX, toY, false));
        return { content: [{ type: "text", text: `dragged ${x},${y} -> ${toX},${toY}` }] };
      }

      post(mouseButtonEvent(x, y, false));
      return { content: [{ type: "text", text: `clicked ${x},${y}${double ? " (double)" : ""}` }] };
    },
  );

  registerLive(
    "mouse_wheel",
    {
      title: "Scroll the mouse wheel",
      description:
        "Wheel notches at the current pointer position. Positive scrolls up, negative down.",
      inputSchema: { instance: instanceArg, notches: z.number().int() },
    },
    async ({ instance, notches }) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "event");
      const count = Math.min(Math.abs(notches), 30);
      for (let i = 0; i < count; i++) {
        const ev = wheelEvent(notches > 0);
        client.sendEvent(ev.evtype, ev.subtype, ev.data1, ev.data2);
        await sleep(25);
      }
      return {
        content: [{ type: "text", text: `${count} notch(es) ${notches > 0 ? "up" : "down"}` }],
      };
    },
  );

  registerLive(
    "verify_menu",
    {
      scenario: SCENARIO_REFUSALS.image,
      title: "Open, navigate, and screenshot a menu",
      description:
        "Open a menu (via a console command like `menu_options`), apply navigation steps, then return a screenshot to verify it.",
      inputSchema: {
        instance: instanceArg,
        open: z.string().optional(),
        steps: z.array(z.enum(MENU_KEYS)).default([]),
      },
    },
    async ({ instance, open, steps }, extra) => {
      const client = await ctx.clientFor(instance);
      if (steps.length > 0) requireCap(client, "event");
      // Opening a menu can load assets and the capture waits on a frame, so this
      // runs well past a default client timeout.
      const shot = await withProgress(extra, 34000, "opening and capturing menu", async () => {
        // Opening a menu can load assets, so give it more than the 5s default.
        if (open) await client.runCommand(open, 15000);
        for (const key of steps) {
          postMenuKey(client, key);
          await sleep(60);
        }
        return ctx.io.capture(client, ctx.config.screenshotDir);
      });
      return { content: [{ type: "image", data: shot.base64, mimeType: "image/png" }] };
    },
  );

  // --- time control ----------------------------------------------------------
  // An engine that pauses when its window loses focus freezes the simulation
  // whenever the MCP drives a backgrounded instance. These tools set the engine's pause flag directly so
  // time-based behavior — charge weapons, projectiles, animations, monster AI —
  // is actually testable headless.
  registerLive(
    "set_pause",
    {
      title: "Pause or resume the game",
      description:
        `Set the engine's master pause flag directly${notes.setPause} all applies it to every instance this session has bound instead of one, with a line per instance (e.g. to resume a whole netgame). Pausing a netgame server or client adds what pause means for that role.`,
      inputSchema: {
        instance: instanceArg,
        paused: z.boolean(),
        all: z.boolean().default(false).describe("Every bound instance; instance is ignored."),
      },
    },
    async ({ instance, paused, all }) => {
      const verb = paused ? "paused" : "resumed";
      const setOne = async (n: number): Promise<{ ok: boolean; lines: string[] }> => {
        const client = await ctx.clientFor(n);
        const noTime = missingCap(client, "time");
        if (noTime) return { ok: false, lines: [noTime] };
        client.setPause(paused);
        return { ok: true, lines: [verb, ...(paused ? netPauseNote(netInfo(n), false) : [])] };
      };
      if (!all) {
        const one = await setOne(instance);
        return { ...(!one.ok && { isError: true }), content: [{ type: "text", text: one.lines.join("\n") }] };
      }
      const targets = ctx.boundInstances();
      if (targets.length === 0) {
        return fail("no instances are bound in this session");
      }
      // One unreachable instance must not stop the rest.
      const lines = await Promise.all(
        targets.map(async (n) => {
          const got = await setOne(n).catch((e: Error) => ({ ok: false, lines: [e.message] }));
          return `instance ${n}: ${got.lines.join("; ")}`;
        }),
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  registerLive(
    "step",
    {
      title: "Advance the game by N tics",
      description:
        `Resume the game, let it run for the given number of tics (35 tics = 1 second), then pause again. Lets you advance the simulation a deterministic-ish amount to observe time-based effects (charging, projectiles, animations) without keeping the window focused. Returns the engine log lines printed meanwhile (up to ${STEP_LOG_MAX_LINES}, with a read_log resume point for the rest; logPattern filters them); a quiet step adds nothing. On a netgame the reply adds what pause means for the instance's role${clientRuns ? ", and a client is left running instead of paused again" : ""}.`,
      inputSchema: {
        instance: instanceArg,
        tics: z.number().int().positive().default(35),
        logPattern: logPatternArg,
      },
    },
    async ({ instance, tics, logPattern }, extra) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "time");
      const net = netInfo(instance);
      const got = await stepAndCollect(client, instance, tics, extra, logPattern);
      const block = stepLogReply(tics, got, logPattern, { quiet: true });
      const head = [`advanced ~${tics} tic(s)`, ...netPauseNote(net, true)];
      return {
        content: [{ type: "text", text: [...head, ...block.text].join("\n") }],
        ...(block.structured && { structuredContent: withNotes(block.structured, [...head, ...block.notes]) }),
      };
    },
  );

  registerLive(
    "ensure_live",
    {
      title: "Check that the sim is advancing",
      description:
        `Prove the simulation actually advances: list what could block it (${notes.ensureLiveBlockers}, a pending map/save/demo load), then run it ~5 tics and check the map tic counter moved. A pending load is waited out first (up to ~5 s)${notes.ensureLiveLoadWait}. The pause state is left as found, since \`paused\` is the normal driving state and \`step\` runs through it. With fix, first closes the menu (\`closemenu\`)${notes.ensureLiveUnblock}. Returns live plus the blockers found, fixed and remaining.`,
      inputSchema: { instance: instanceArg, fix: z.boolean().default(false) },
    },
    async ({ instance, fix }) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "time");
      await client.readStatus(STATUS_READ_MS);
      // A load finishing mid-probe resets maptime and reads as not live: let it run first.
      // pauseext stops every tic and so the load too; then only fix's mcp_unblock releases it.
      let waited = false;
      const awaitPending = async () => {
        const s = client.lastStatus;
        if (s?.pending !== "1" || s.pauseext === "1") return;
        if ((await awaitLoad(client)).settled) waited = true;
      };
      const liveness = () => {
        const snap = statusField(client, "maptime");
        return "error" in snap ? { failed: fail(`can't check liveness: ${snap.error}`) } : snap;
      };
      await awaitPending();
      const early = liveness();
      if ("failed" in early) return early.failed;
      const s = early.status;
      const found = statusBlockers(s);
      const wasPaused = isPaused(s);
      if (fix) {
        await client.runCommand("closemenu");
        await client.runCommand("mcp_unblock");
        await awaitPending();
        const late = liveness();
        if ("failed" in late) return late.failed;
      }
      // Fresh either way: the read above, a fix command's own sentinel, or the load wait.
      const before = Number(client.lastStatus?.maptime);
      await runTics(client, LIVE_PROBE_TICS, wasPaused);
      await client.readStatus(STATUS_READ_MS);
      const lost = liveness();
      if ("failed" in lost) return lost.failed;
      const after = Number(client.lastStatus?.maptime);
      const live = after > before;
      const remaining = statusBlockers(client.lastStatus);
      const fixed = fix ? found.filter((b) => !remaining.includes(b)) : undefined;
      const waitedNote = waited ? ["waited for a pending map/save/demo load first"] : [];
      const parts = [
        live ? `live (maptime ${before} -> ${after})` : `NOT live (maptime ${before} -> ${after})`,
        ...waitedNote,
        ...(fixed?.length ? [`fixed: ${fixed.join(", ")}`] : []),
        ...(remaining.length ? [`blockers: ${remaining.join(", ")}`] : []),
      ];
      return {
        content: [{ type: "text", text: parts.join("; ") }],
        structuredContent: withNotes(
          {
            live,
            maptime: { before, after },
            found,
            ...(fixed ? { fixed } : {}),
            remaining,
          },
          waitedNote,
        ),
      };
    },
  );

  registerLive(
    "step_until",
    {
      title: "Step until a condition holds",
      description:
        "Advance the sim in chunks of chunkTics until a condition holds or maxTics run out, then leave it paused like `step`. The condition compares a map var, map array element, ACS world/global var, player field (x, y, z, angle, floorHeight, sector, light, health, armor) or the count of actors find_actors' class/tid/radius/flags filter matches (a corpse counts unless flags rules it out, e.g. {alive: true}) against a number, or a player field against another field (e.g. z == floorHeight); or, kind log, holds once a line matching pattern (a case-insensitive regex) is printed after the call starts (value is the matching-line count). Reports the map tics that actually elapsed. Fails fast with the blocker list if the map tic counter stops for " + STALL_TICS + " tics, and fails if it goes back (a map change). On a netgame the reply adds what pause means for the instance's role" +
        (clientRuns ? ", and a client is left running instead of paused between chunks." : "."),
      inputSchema: {
        instance: instanceArg,
        condition: conditionArg,
        maxTics: z.number().int().positive(),
        chunkTics: z.number().int().positive().default(5),
      },
    },
    async ({ instance, condition, maxTics, chunkTics }, extra) => {
      const client = await ctx.clientFor(instance);
      requireCap(client, "time");
      const log = logSince(instance);
      const read = () => readingOf(client, () => checkCondition(client, condition, log));
      const first = await read();
      const snap = statusField(client, "maptime");
      if ("error" in snap) return fail(`can't count tics: ${snap.error}`);
      const net = netInfo(instance);
      const { value, elapsed, maptime, end } = await withProgress(extra, (maxTics / TICRATE) * 1000, "stepping until condition", () =>
        stepWithin({
          budget: maxTics,
          chunkTics,
          first,
          step: (n) => runStep(client, instance, n),
          read,
          done: (r) => "error" in r || r.met,
          levelChange: "stop",
        }),
      );
      if ("error" in value) return fail(value.error);
      // A log condition's own status refresh can time out, so only a missing snapshot fails here;
      // one without maptime is a stall below.
      const counted = statusField(client, "maptime");
      if (!client.lastStatus && "error" in counted) return fail(`can't count tics: ${counted.error}`);
      const now = Number(client.lastStatus?.maptime);
      if (end === "stalled") return stalledResult(client, now);
      if (end === "level_change") {
        return fail(`the map changed (maptime went from ${maptime} to ${now}) after ${elapsed} tic(s); the condition was not met`);
      }
      const { met, text: cmp } = value;
      const head = met ? `met after ${elapsed} tic(s): ${cmp}` : `not met within ${elapsed} tic(s): ${cmp}`;
      const notes = [...capNote({ end, elapsed }, maxTics), ...netPauseNote(net, true)];
      return {
        content: [{ type: "text", text: [head, ...notes].join("\n") }],
        structuredContent: withNotes({ met, tics: elapsed, value: value.left, right: value.right }, notes),
      };
    },
  );

  registerLive(
    "watch_actors",
    {
      title: "Watch actors for N tics",
      description:
        "Sample the actors of a class (subclasses included) and/or TID over the next `tics` map tics (35 = 1 second) in one call: snapshot with `findactors`, step everyTics paused, repeat, then leave the game paused like `step` (" +
        (clientRuns ? "a netgame client is never re-paused, and the reply adds the role's note" : "on a netgame the reply adds the role's note") +
        "). For short-lived projectiles and effects, or a monster's path, instead of find_actors/step polling. Returns one table (columns maptime plus fields, one row per actor per sample, a missing key null) and a per-class summary (first/last maptime seen, most at once, samples present). Rows are per-sample snapshots: there is no identity across samples for actors without a unique TID, so a class watch can't tell which row is which actor. An actor living under everyTics can fall between snapshots; use everyTics 1 for those. limit caps each snapshot (cut ones are counted), maxRows the table (past it the summary stays exact and dropped rows are counted). Reports reason done, gone (untilGone: matches were seen and the latest snapshot has none; an empty start waits for a spawn), level_change (the map tic counter went back: the map changed or restarted, and the table ends before it) or stalled (the counter stopped for " + STALL_TICS + " tics; the only error).",
      inputSchema: {
        instance: instanceArg,
        class: classArg.optional(),
        tid: z.number().int().min(1).optional(),
        radius: z.number().int().positive().optional().describe("Only actors within this distance of the player."),
        tics: z.number().int().positive().max(3500).default(35),
        everyTics: z.number().int().positive().default(2).describe("Map tics between snapshots (measured; a short step is topped up)."),
        fields: z
          .array(z.enum(FIELDS))
          .min(1)
          .optional()
          .describe(`Columns after maptime; default ${DEFAULT_FIELDS.join(", ")}. ${DETAIL_FIELDS.join(", ")} cost a detail read.`),
        untilGone: z.boolean().default(false),
        limit: z.number().int().positive().default(50).describe("Actors per snapshot, nearest first."),
        maxRows: z.number().int().positive().default(500),
      },
    },
    async ({ instance, class: cls, tid, radius, tics, everyTics, fields, untilGone, limit, maxRows }, extra) => {
      if (cls === undefined && tid === undefined) return fail("give class, tid or both");
      const columns = [...new Set(fields ?? DEFAULT_FIELDS)];
      const client = await ctx.clientFor(instance);
      requireCap(client, "time");
      const cmd = command("findactors", ...kvArgs({ class: cls, tid, radius, limit, detail: needsDetail(columns) ? 1 : undefined }));
      const port: WatchPort = {
        snapshot: async () => {
          const output = await client.runCommand(cmd);
          const found = parseFoundReply(output);
          if (!found) return { error: failureText(output) };
          return { maptime: Number(client.lastStatus?.maptime), actors: found.actors, truncated: !!found.truncated };
        },
        step: (n) => runStep(client, instance, n),
      };
      // The first snapshot's own sentinel is the fresh status the maptime baseline comes from.
      const first = await port.snapshot();
      if ("error" in first) return fail(first.error);
      const snap = statusField(client, "maptime");
      if ("error" in snap) return fail(`can't count tics: ${snap.error}`);
      const result = await withProgress(extra, (tics / TICRATE) * 1000, `watching for ${tics} tic(s)`, () =>
        runWatch(port, { tics, everyTics, fields: columns, untilGone, maxRows }, first),
      );
      if ("error" in result) return fail(result.error);
      const target = [cls, tid !== undefined ? `tid ${tid}` : undefined].filter(Boolean).join(" ");
      if (result.reason === "stalled") {
        return { ...stalledResult(client, Number(client.lastStatus?.maptime)), structuredContent: { ...result } };
      }
      const role = netPauseNote(netInfo(instance), true);
      const text = [describeWatch(target, result), ...role].join("\n");
      return { content: [{ type: "text", text }], structuredContent: withNotes({ ...result }, role) };
    },
  );

  registerLive(
    "move_to",
    {
      title: "Walk the player to a point, actor or route",
      description:
        "Walk the player to a map point ({x, y}), an actor ({tid}: the nearest with that TID, followed if it moves; {class}: the nearest of that class when its leg starts, walked to where it stood then) or through a route of up to 32 of them, with the steering loop inside the server: holds +forward, re-aims whenever the heading drifts and times the release from the player's measured speed, thrust and friction, without pausing between chunks. Straight legs only: walls are not avoided, so route around them with waypoints (pre-check a leg with trace_move). Intermediate waypoints are passed through; the last counts once the player is within radius (plus an actor target's own radius) and has stopped. Reports reason arrived, stuck (no progress in stuckTics: the closest approach gained under 8 units and the player didn't speed up toward the target), timeout (maxTics, whole route), died, player_gone (no player, or a level change), target_gone, or stalled (sim not advancing; the only error), plus the map tics elapsed, the final position and speed (above 0 after timeout/died/target_gone, the player is still sliding). +forward is always released and the pause state is left as found. Unverified on a netgame client. For setup moves where movement isn't under test, use run_command `warp x y` (cheats on) plus set_view instead.",
      inputSchema: {
        instance: instanceArg,
        to: z
          .array(z.object(waypointFields))
          .min(1)
          .max(32)
          .describe("Waypoints in order, each exactly one of {x, y}, {tid} or {class}."),
        radius: z.number().min(16).default(32).describe("Arrival radius in map units; the shortest tap is ~33 units, so smaller radii would oscillate."),
        maxTics: z.number().int().positive().default(350),
        chunkTics: z.number().int().positive().default(3),
        stuckTics: z.number().int().positive().default(35),
        trail: z.boolean().default(false).describe("Add per-chunk [maptime, x, y] samples."),
      },
    },
    async ({ instance, to, radius, maxTics, chunkTics, stuckTics, trail }, extra) => {
      const waypoints: Waypoint[] = [];
      for (const [i, w] of to.entries()) {
        const waypoint = toWaypoint(w);
        if (!waypoint) {
          return fail(`waypoint ${i + 1}: give exactly one of x and y, tid or class`);
        }
        waypoints.push(waypoint);
      }
      const client = await ctx.clientFor(instance);
      requireCap(client, "time");
      const toRead = (s: PlayerState) => ({ x: s.x, y: s.y, z: s.z, dead: s.player === "dead" || s.spectating === true });
      const start = await readPlayerState(client);
      if (!start) return fail("no player (not in a level?)");
      const snap = statusField(client, "maptime");
      if ("error" in snap) return fail(`can't count tics: ${snap.error}`);
      const port: MovePort = {
        readPlayer: async () => {
          const s = await readPlayerState(client);
          return s && toRead(s);
        },
        resolveTarget: async (w) => {
          const by = "tid" in w ? { tid: w.tid } : { class: w.class };
          const output = await client.runCommand(command("findactors", ...kvArgs({ ...by, limit: 2, detail: 1 })));
          const found = parseFoundReply(output);
          if (!found) throw new Error(failureText(output));
          // findactors includes the console player's own match at distance 0.
          const a = found.actors.find((r) => r.player === undefined || Number(r.dist) > 0);
          return a ? { x: Number(a.x), y: Number(a.y), radius: Number(a.radius) || 0 } : null;
        },
        setAngle: async (deg) => {
          const output = await client.runCommand(command("mcp_setview", deg.toFixed(2)));
          if (!parseKvLines(output, "view")[0]) throw new Error(failureText(output));
        },
        setForward: async (on) => {
          await client.runCommand(on ? "+forward" : "-forward");
        },
        waitTics: (n) => sleep((n / TICRATE) * 1000),
        maptime: () => Number(client.lastStatus?.maptime),
      };
      // Decided after the first read refreshed the status.
      const wasPaused = isPaused(client.lastStatus);
      client.setPause(false);
      let result;
      try {
        result = await withProgress(extra, (maxTics / TICRATE) * 1000, "walking the player", () =>
          runMoveTo(port, waypoints, { radius, maxTics, chunkTics, stuckTics, trail }, toRead(start)),
        );
      } finally {
        if (wasPaused) client.setPause(true);
      }
      // A frozen maptime at an intermission is a level exit, not a stall.
      if (result.reason === "stalled" && client.lastStatus?.gamestate === "level") {
        return { ...stalledResult(client, port.maptime()), structuredContent: { ...result } };
      }
      if (result.reason === "stalled") result = { ...result, reason: "player_gone" as const };
      return { content: [{ type: "text", text: describeMove(result) }], structuredContent: { ...result } };
    },
  );

  registerLive(
    "input_timeline",
    {
      title: "Run scripted player input, tic-exact",
      description:
        `Run a list of input segments in one call, each holding buttons, movement and a heading for N tics, injected into the player's input by the engine every tic for exactly the tics asked (35 tics = 1 second, up to ${MAX_SEGMENTS} segments and 60 s). A tap is a 1-tic segment, a hold is one long segment, a release is a segment without the button. Returns one line per segment with the map tics it ran in, where the player went, the heading and health after it, and the log lines printed during it; trail adds a per-tic row (position, angle, pitch, momentum, health, buttons). While it runs, the real keyboard and console-held buttons (+attack, +forward) are ignored; they come back after. Button rules: use needs a released tic between presses; attack refires while held unless the weapon has NOAUTOFIRE; jump needs the ground; a freshly spawned player needs one released tic before its first attack or use counts. Switch weapons with run_command first: a weapon change is not an input field. Offline only (refused on a server or client), and refused with a menu, console, chat or automap open or a dead player (ensure_live with fix clears those). Death mid-run doesn't stop it (health shows it). Reports reason done, level_change (the map ended or changed; later segments didn't run), stopped, or stalled (tics stopped running; the only error). The pause state is left as found (a run that ends at an intermission leaves it unpaused). A demo recorded meanwhile holds the real input, not the injected one.`,
      inputSchema: {
        instance: instanceArg,
        segments: z.array(segmentArg).min(1).max(MAX_SEGMENTS).describe("Run in order."),
        trail: z.boolean().default(false).describe("Add one row per tic to structuredContent."),
      },
    },
    async ({ instance, segments, trail }, extra) => {
      const plan = planTimeline(segments);
      if ("error" in plan) return fail(plan.error);
      const client = await ctx.clientFor(instance);
      requireCap(client, "input");
      // Also the first status read: an abandoned run is stopped first, which puts its pause back.
      await client.runCommand("mcp_input stop");
      const snap = statusField(client, "paused");
      if ("error" in snap) return fail(`can't run a timeline: ${snap.error}`);
      const blockers = statusBlockers(snap.status);
      if (blockers.length) return fail(`can't run a timeline: ${blockers.join(", ")}. Try ensure_live with fix.`);
      const wasPaused = isPaused(snap.status);
      const readLater = logSince(instance);
      const armed = await client.runCommand(scheduleCommand(plan.commands, wasPaused));
      if (!parseInputArmed(armed)) return fail(failureText(armed));

      const runMs = (plan.total / TICRATE) * 1000;
      let status: InputStatus | undefined;
      try {
        status = await withProgress(extra, runMs, `running ${plan.total} tic(s) of input`, () =>
          pollArmedRun(() => readOrThrow(client, "mcp_input status", parseInputStatus), (s) => s.consumed, { tics: plan.total, runMs, sleep }),
        );
      } finally {
        // The engine restores the pause on every disarm; a failed stop (the bridge died) mustn't hide the error.
        if (status?.active !== false) await client.runCommand("mcp_input stop", ARMED_STOP_MS).catch(() => {});
      }
      if (status.active) return stalledReply(client, { tics: status.consumed });

      // Before the trail fetch, whose rows would otherwise crowd the window.
      const log = readLater(TIMELINE_LOG_BASE + TIMELINE_LOG_PER_TIC * plan.total);
      const parsed = await readTrail(client, trail);
      if ("error" in parsed) return fail(parsed.error);
      const logs = splitLog(consoleLines(log?.lines.map((l) => l.text) ?? []));
      const summaries = summarizeSegments(parsed.start, parsed.rows, logs);
      const caveats = [
        ...(log ? [] : ["(no engine log to read)"]),
        ...(log?.omitted ? [`(${log.omitted} more log line(s) not read)`] : []),
      ];
      const head = describeTimeline(status.reason, summaries, { segments: segments.length, tics: plan.total }, status.consumed);
      return {
        content: [{ type: "text", text: [head, ...caveats].join("\n") }],
        structuredContent: withNotes(
          {
            reason: status.reason,
            tics: status.consumed,
            segments: summaries,
            ...(trail ? { trail: parsed.rows } : {}),
          },
          caveats,
        ),
      };
    },
  );

  // --- ACS world/global variable read/write ---------------------------------
  registerLive(
    "get_acs_var",
    {
      title: "Get ACS variable",
      description: "Read an ACS world or global variable by index.",
      inputSchema: { instance: instanceArg, scope: acsScope, index: z.number().int().min(0) },
    },
    async ({ instance, scope, index }) => {
      const client = await ctx.clientFor(instance);
      const read = await readAcsVar(client, scope, index);
      if ("error" in read) return fail(read.error);
      return {
        content: [{ type: "text", text: String(read.value) }],
        structuredContent: { scope, index, value: read.value },
      };
    },
  );

  registerLive(
    "set_acs_var",
    {
      title: "Set ACS variable",
      description: "Write an ACS world or global variable by index.",
      inputSchema: {
        instance: instanceArg,
        scope: acsScope,
        index: z.number().int().min(0),
        value: z.number().int(),
      },
    },
    async ({ instance, scope, index, value }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(command("setacsvar", scope, index, value));
      const vars = parseAcsVars(output);
      if (vars.length === 0) {
        return fail(output.join("\n") || "set failed");
      }
      return {
        content: [{ type: "text", text: `${scope}[${index}] = ${vars[0].value}` }],
        structuredContent: { scope, index, value: vars[0].value },
      };
    },
  );

  registerLive(
    "list_acs_vars",
    {
      title: "List non-zero ACS variables",
      description:
        "Run `dumpacsvars` and return all non-zero ACS world/global variables, optionally filtered by scope.",
      inputSchema: { instance: instanceArg, scope: acsScope.optional() },
    },
    async ({ instance, scope }) => {
      const client = await ctx.clientFor(instance);
      let vars = parseAcsVars(await client.runCommand("dumpacsvars"));
      if (scope) vars = vars.filter((v) => v.scope === scope);
      return {
        content: [{ type: "text", text: `${vars.length} non-zero ACS var(s)` }],
        structuredContent: { vars },
      };
    },
  );

  // --- static ACS source index (number <-> name <-> file:line) --------------
  register(
    "acs_index",
    {
      title: "Index ACS source",
      description:
        "Parse a directory of .acs source files and return symbol counts (scripts, functions, numeric defines). Reads files directly; no game needed.",
      inputSchema: { dir: acsSrcArg },
    },
    async ({ dir }) => {
      const idx = ctx.loadAcsIndex(dir);
      const info = {
        scripts: idx.symbols.filter((s) => s.kind === "script").length,
        functions: idx.symbols.filter((s) => s.kind === "function").length,
        defines: Object.keys(idx.defines).length,
      };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  register(
    "find_acs_symbol",
    {
      title: "Find ACS symbol",
      description:
        "Resolve a script number or a script/function name to its symbol(s) — name, number, file:line. Turns a profiler 'script 1017' into a source location.",
      inputSchema: { ref: z.string().min(1), dir: acsSrcArg },
    },
    async ({ ref, dir }) => {
      const matches = findSymbol(ctx.loadAcsIndex(dir), ref);
      return {
        content: [{ type: "text", text: `${matches.length} match(es) for ${ref}` }],
        structuredContent: { matches },
      };
    },
  );

  register(
    "behavior_names",
    {
      title: "Read ACS names from compiled bytecode",
      description:
        "Read function and named-script names from a mod's compiled ACS (BEHAVIOR/library lumps) in a WAD or PK3 — for source-less mods. Numbered scripts have no names in bytecode (use find_acs_symbol with source for those).",
      inputSchema: { file: z.string().min(1) },
    },
    async ({ file }) => {
      const functions = new Set<string>();
      const namedScripts = new Set<string>();
      for (const lump of collectAcsLumps(ctx.io.readFileSync(file))) {
        const names = parseBehaviorNames(lump);
        names.functions.forEach((n) => functions.add(n));
        names.namedScripts.forEach((n) => namedScripts.add(n));
      }
      const result = { functions: [...functions], namedScripts: [...namedScripts] };
      return {
        content: [
          {
            type: "text",
            text: `${result.functions.length} functions, ${result.namedScripts.length} named scripts`,
          },
        ],
        structuredContent: result,
      };
    },
  );

  register(
    "list_map_exports",
    {
      title: "List exported map variables from compiled bytecode",
      description:
        "List each ACS module's exported map variables and arrays (MEXP/ARAY chunks) from a WAD, PK3, directory or compiled .o, with slot index and array size. These are the names get_map_var/get_map_array find by name; anything else needs their sourceFile. `lump` narrows to modules whose name or basename matches (e.g. `mymod` for `acs/mymod.o`); a map's BEHAVIOR also matches `BEHAVIOR` or its map marker.",
      inputSchema: { file: z.string().min(1), lump: z.string().min(1).optional() },
    },
    async ({ file, lump }) => {
      const all = ctx.deployedModules(file);
      const picked = pickModules(all, lump);
      if (picked.length === 0) {
        const known = all.map((m) => m.name).join(", ") || "none";
        return fail(`No ACS module matches "${lump}" in ${file}. Modules: ${known}`);
      }
      const modules = picked.map((m) => ({ module: m.name, exports: parseMapExports(m.data) }));
      const text = modules
        .map(({ module, exports }) => {
          const rows = exports.map((e) => `  ${e.index}: ${e.name}${e.isArray ? `[${e.size}]` : ""}`);
          return [`${module}: ${exports.length} export(s)`, ...rows].join("\n");
        })
        .join("\n");
      return { content: [{ type: "text", text }], structuredContent: { modules } };
    },
  );

  // --- savegames & demos -----------------------------------------------------
  register(
    "list_saves",
    {
      title: "List savegames",
      description:
        `${notes.listSaves} No running game needed.`,
      inputSchema: { dir: z.string().optional() },
    },
    async ({ dir }) => {
      const d = ctx.resolveSaveDir(dir);
      // A fresh install may have no save dir until the first save; a missing explicit dir is a typo.
      if (!ctx.io.existsSync(d)) {
        return dir === undefined ? { content: [{ type: "text", text: `0 save(s) in ${d}` }], structuredContent: { dir: d, saves: [] } } : fail(`no such directory: ${d}`);
      }
      const saves = ctx.saveFiles(d).map((f) => engine.readSaveMeta(f, ctx.io.readFileSync(path.join(d, f))));
      return {
        content: [{ type: "text", text: `${saves.length} save(s) in ${d}` }],
        structuredContent: { dir: d, saves },
      };
    },
  );

  registerLive(
    "save_game",
    {
      title: "Save the game",
      description:
        appendNote("Run `save` to write a savegame (single-player / cooperative only).", notes.saveGame),
      inputSchema: {
        instance: instanceArg,
        name: z.string().min(1),
        description: z.string().optional(),
      },
    },
    async ({ instance, name, description }) => {
      const client = await ctx.clientFor(instance);
      // A run_acs module in the level makes the save unloadable (module-count I_Error), so a
      // status read that times out fails closed.
      const { status } = await client.readStatus(STATUS_READ_MS);
      if (client.supports("status") && status === undefined) {
        return fail("refused: status read timed out (engine busy, e.g. loading a map), so loaded run_acs snippets can't be ruled out; retry");
      }
      const temp = status?.acstemp;
      if (temp !== undefined && temp !== "0") {
        return fail(`refused: ${temp} run_acs snippet module(s) are loaded, and loading a save taken now fails (ACS module count mismatch). Change or reload the map (load_map) first.`);
      }
      const out = (await client.runCommand(buildSave(name, description))).join("\n");
      // `save` only queues the write (G_SaveGame sets sendsave), so "Game saved." prints a
      // tic after this reply; every rejection prints in-call.
      return {
        isError: out.trim().length > 0 && !/game saved/i.test(out),
        content: [{ type: "text", text: out.trim() || "save queued; confirm with list_saves" }],
      };
    },
  );

  registerLive(
    "load_game",
    {
      title: "Load a savegame",
      description: "Run `load` to restore a savegame by name.",
      inputSchema: { instance: instanceArg, name: z.string().min(1) },
    },
    async ({ instance, name }) => {
      const client = await ctx.clientFor(instance);
      const out = (await runLoad(client, command("load", name))).join("\n");
      return { content: [{ type: "text", text: out.trim() || "(loaded)" }] };
    },
  );

  registerLive(
    "play_demo",
    {
      title: "Play a demo",
      description:
        "Run `playdemo` to play back a recorded .lmp demo. (Recording is via the -record launch arg, not a console command.)",
      inputSchema: { instance: instanceArg, name: z.string().min(1) },
    },
    async ({ instance, name }) => {
      const client = await ctx.clientFor(instance);
      const out = (await runLoad(client, command("playdemo", name))).join("\n");
      return { content: [{ type: "text", text: out.trim() || "(playing)" }] };
    },
  );

  // --- live player / target state -------------------------------------------
  registerLive(
    "player_state",
    {
      title: "Player state",
      description:
        "Run `currentpos` and return the player's position, angle, floor height, sector, light level, and (on a status-capable bridge) health, armor, and whether the player is alive, dead, or spectating.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const state = await readPlayerState(client);
      if (!state) {
        return fail("no player (not in a level?)");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        structuredContent: { ...state },
      };
    },
  );

  registerLive(
    "actor_state",
    {
      title: "Actor state (DECORATE)",
      description:
        "Run `dumpactor` and return an actor's live state: class, health, position, angle, pitch, current DECORATE state (sprite/frame/tics, e.g. TNT1 A 0, plus id Owner.index and label e.g. See+2), inventory, and (for players) ready weapon + morph status. " +
        "For a player, `player` also holds the tic's input: `input` raw (GetPlayerInput INPUT_*) and `modInput` after mods (MODINPUT_*), buttons decoded to names; use `input.oldButtons` for press edges, since between tics `modInput.oldButtons` already equals `modInput.buttons`. Plus `weaponFlags` (weaponready, ...), `refire`, `pendingWeapon` (null: no change pending; \"none\": switching to no weapon) and every active psprite layer (weapon, flash, or its GZDoom layer number) with sprite/frame/tics/x/y and the state's id/label (e.g. Fire+1). Read right after `step` for exact per-tic values; `player` is null for a non-player. " +
        "Defaults to the player; pass a TID for any actor, plus index for the nth actor sharing it.",
      inputSchema: { instance: instanceArg, ...targetArgs },
    },
    async ({ instance, tid, index }) => {
      const refusal = targetRefusal(tid, index);
      if (refusal) return fail(refusal);
      const client = await ctx.clientFor(instance);
      // dumpactor's own tid 0 names no actor, so the body is its no-argument form.
      const cmd = !tid ? "dumpactor" : command("dumpactor", tid, ...(index !== undefined ? [index] : []));
      const state = parseActorState(await client.runCommand(cmd));
      if (state.class === null) {
        return fail("no actor (not in a level / bad TID?)");
      }
      return {
        content: [{ type: "text", text: JSON.stringify(state) }],
        structuredContent: { ...state },
      };
    },
  );

  registerLive(
    "read_hud",
    {
      title: "Read on-screen HUD",
      description:
        `Run \`dumphud\` and return what the engine painted last frame: HUD text strings (with screen x/y), images (by texture name + position), and active ${notes.hudMessages} (full composed text, layer, position, remaining tics). Captures menus too. ` +
        `Filtered server-side: pattern is a case-insensitive regex on a string's or message's text or an image's name; region keeps text and images whose x/y (the same values the results report) fall inside it, and never filters messages, which use another coordinate space; maxItems (default ${HUD_MAX_ITEMS}) caps each kind, keeping the first in draw order, and omitted counts what the cap left out.`,
      inputSchema: {
        instance: instanceArg,
        pattern: regexArg().optional(),
        region: z
          .object({ x: z.number().int(), y: z.number().int(), w: z.number().int().positive(), h: z.number().int().positive() })
          .optional(),
        maxItems: z.number().int().positive().default(HUD_MAX_ITEMS),
      },
    },
    async ({ instance, pattern, region, maxItems }) => {
      const client = await ctx.clientFor(instance);
      const hud = filterHud(parseHud(await client.runCommand("dumphud")), { pattern, region, maxItems });
      const { omitted } = hud;
      const capped =
        omitted.text + omitted.images + omitted.messages > 0
          ? ` (omitted: ${omitted.text} strings, ${omitted.images} images, ${omitted.messages} messages; narrow with pattern/region or raise maxItems)`
          : "";
      return {
        content: [
          {
            type: "text",
            text: `${hud.text.length} strings, ${hud.images.length} images, ${hud.messages.length} hud messages${capped}`,
          },
        ],
        structuredContent: { ...hud },
      };
    },
  );

  registerLive(
    "actors_near",
    {
      title: "Actors near the player",
      description:
        "Run `actorsnear` and return actors within a radius (map units, default 512) of the player: class, health, position, and current sprite.",
      inputSchema: { instance: instanceArg, radius: z.number().int().positive().optional() },
    },
    async ({ instance, radius }) => {
      const client = await ctx.clientFor(instance);
      const cmd = radius !== undefined ? command("actorsnear", radius) : "actorsnear";
      const actors = parseActorsNear(await client.runCommand(cmd));
      return {
        content: [{ type: "text", text: `${actors.length} actor(s) nearby` }],
        structuredContent: { actors },
      };
    },
  );

  registerLive(
    "inspect_target",
    {
      title: "Inspect aimed target",
      description:
        "Run `linetarget` and return the actor the player is aiming at (class, health, spawn health).",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const target = parseTarget(await client.runCommand("linetarget"));
      if (!target) {
        return { content: [{ type: "text", text: "no target in view" }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(target) }],
        structuredContent: { ...target },
      };
    },
  );

  registerLive(
    "set_view",
    {
      title: "Set the player's view",
      description:
        "Point the player's view: an absolute angle (degrees, Doom convention: 0 east, 90 north) with optional pitch (degrees, negative looks up), or face an actor by tid (first actor with it) or class (nearest map actor of that class, aiming at its mid-height). Give exactly one of angle, tid, class.",
      inputSchema: {
        instance: instanceArg,
        angle: z.number().finite().optional(),
        pitch: z.number().finite().optional(),
        tid: z.number().int().min(1).optional(),
        class: classArg.optional(),
      },
    },
    async ({ instance, angle, pitch, tid, class: cls }) => {
      const modes = [angle, tid, cls].filter((m) => m !== undefined).length;
      if (modes !== 1 || (pitch !== undefined && angle === undefined)) {
        return fail("give exactly one of angle, tid or class (pitch only with angle)");
      }
      const cmd =
        angle !== undefined
          ? command("mcp_setview", realToken(angle), ...(pitch !== undefined ? [realToken(pitch)] : []))
          : command("mcp_setview", ...kvArgs({ tid, class: cls }));
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand(cmd);
      const view = parseKvLines(output, "view")[0];
      if (!view) return failed(output);
      return {
        content: [{ type: "text", text: JSON.stringify(view) }],
        structuredContent: { ...view },
      };
    },
  );

  registerLive(
    "list_players",
    {
      title: "List players",
      description:
        `Run \`dumpplayers\` and return every in-game player: ${notes.playerFields}. Bots join at slot 1+.`,
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const output = await client.runCommand("dumpplayers");
      const players = playersReply(output);
      if (!players) return failed(output);
      return {
        content: [{ type: "text", text: `${players.length} player(s)` }],
        structuredContent: { players },
      };
    },
  );

  registerLive(
    "add_bot",
    {
      title: "Add bots",
      description:
        "Add count bots (`addbot`), step the sim until each has joined, and return each one's slot, name and TID. A join can take a tic or two; the sim runs in chunks of chunkTics, up to maxTics. A bot that joins as a spectator (a join queue) is reported as one. A bot whose TID is 0 is waited on up to tidTics more for a script to assign one (tidTics 0 skips that); it stays 0 when nothing does. Reports the map tics elapsed (across a map change mid-wait, the old map's plus the new one's). A bot that joined and then a map change removed mid-wait is listed as lost (reason level_change); the call fails when none is left. Fails fast when the map tic counter stops for " + STALL_TICS + " tics. The pause state is left as found. Fails with what addbot printed when no bot joins (an unknown name, no free slot, not in a level). For a team, use run_command `addbot <name> <team>`.",
      inputSchema: {
        instance: instanceArg,
        name: z.string().optional().describe("A bot name from the loaded bot definitions; random when omitted."),
        count: z.number().int().min(1).max(16).default(1),
        maxTics: z.number().int().positive().default(35).describe("Tics to wait for the bots to join."),
        tidTics: z.number().int().min(0).default(35).describe("Further tics to wait for a non-zero TID; 0 skips it."),
        chunkTics: z.number().int().positive().default(2),
      },
    },
    async ({ instance, name, count, maxTics, tidTics, chunkTics }, extra) => {
      const client = await ctx.clientFor(instance);
      const start = await client.runCommand("dumpplayers");
      const present = playersReply(start);
      if (!present) return failed(start);
      const before = new Set(present.map((p) => Number(p.slot)));
      // A status-less bridge never gets to step (cannotStep).
      const wasPaused = isPaused(client.lastStatus);
      const said: string[] = [];
      for (let i = 0; i < count; i++) said.push(...(await client.runCommand(buildAddBot(name))));
      // A join error can print a tic late, on a join-phase read.
      let collecting = true;
      const track = stallTracker();
      let stalled = false;
      let tics = 0;
      const capped: string[] = [];
      let levelChanges = 0;
      // Every bot seen joined, with the level-change count at its last sighting.
      const seen = new Map<string, { bot: JoinedBot; changes: number }>();
      const sighted = (joined: JoinedBot[]) => {
        for (const bot of joined) seen.set(botKey(bot), { bot, changes: levelChanges });
      };
      const read = () =>
        readingOf(client, async () => {
          const output = await client.runCommand("dumpplayers");
          if (collecting) said.push(...consoleLines(output).filter((l) => !/^(MCP_PLAYERS$|player )/.test(l.trim())));
          return joinedBots(before, parseKvLines(output, "player"));
        });
      const cannotStep = () => {
        const noTime = missingCap(client, "time");
        if (noTime) return noTime;
        const snap = statusField(client, "maptime");
        return "error" in snap ? `can't count tics: ${snap.error}` : undefined;
      };
      let last = await read();
      sighted(last.value);
      // Both phases count the map tics they measured, a new map's included, into one total.
      const stepUntil = async (phase: string, budget: number, done: (v: JoinedBot[]) => boolean) => {
        const r = await stepWithin({
          budget,
          chunkTics,
          first: last,
          step: (n) => runTics(client, n, wasPaused),
          read,
          done,
          levelChange: "count",
          track,
          onChunk: (move, joined) => {
            if (move === "level_change") levelChanges++;
            sighted(joined);
          },
        });
        tics += r.elapsed;
        capped.push(...capNote(r, budget).map((n) => `${phase}: ${n}`));
        stalled = r.end === "stalled";
        last = { value: r.value, maptime: r.maptime };
      };
      const enough = (v: JoinedBot[]) => v.length >= count;
      const why = await withProgress(extra, ((maxTics + tidTics) / TICRATE) * 1000, "waiting for bots to join", async () => {
        if (!enough(last.value)) {
          const no = cannotStep();
          if (no) return no;
          await stepUntil("joining", maxTics, enough);
        }
        collecting = false;
        if (!stalled && tidTics > 0 && !allHaveTid(last.value)) {
          const no = cannotStep();
          if (no) return no;
          await stepUntil("waiting for a TID", tidTics, allHaveTid);
        }
        return undefined;
      });
      if (why) return fail(why);
      if (stalled) return stalledResult(client, Number(client.lastStatus?.maptime));
      const bots = last.value;
      const report = addBotReport({ bots, seen: seen.values(), levelChanges, count, tidTics, tics, said: outputText(consoleLines(said)), capped });
      if ("error" in report) return fail(report.error);
      const { lines, notes, lost } = report;
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: withNotes({ bots, ...(lost.length > 0 && { lost }), tics }, notes),
      };
    },
  );

  registerLive(
    "find_actors",
    {
      title: "Find actors map-wide",
      description:
        `Run \`findactors\` and list map actors (owned inventory excluded), optionally filtered by class (includes subclasses), TID and radius around the player, sorted by distance. Each has class, tid, hp/spawnhp, x/y/z, angle, pitch, dist, sprite/frame, flags (monster, friendly, corpse, dormant, shootable, solid, invulnerable, ambush) and target. detail adds master/tracer, special + args, vel, radius/height, floorz and player index. flags keeps only actors matching every given key (true = must have, false = must not), each a flag name above or alive (derived: hp > 0 and not a corpse; decorations count, so pair it with monster); use {monster: true} for all monsters instead of guessing a base class, and with flags, limit (default ${FIND_ACTORS_LIMIT}) applies after filtering. ${notes.findActors}`,
      inputSchema: {
        instance: instanceArg,
        class: classArg.optional(),
        tid: z.number().int().min(1).optional(),
        radius: z.number().int().positive().optional(),
        limit: z.number().int().positive().optional(),
        detail: z.boolean().optional(),
        flags: actorFlags.optional(),
      },
    },
    async ({ instance, class: cls, tid, radius, limit, detail, flags }) => {
      const client = await ctx.clientFor(instance);
      const got = await findActors(client, { class: cls, tid, radius, limit, detail, flags });
      if ("output" in got) return failed(got.output);
      const { found } = got;
      const cut = found.truncated ? ` (showing ${found.truncated.shown} of ${found.truncated.total})` : "";
      return {
        content: [{ type: "text", text: `${found.actors.length} actor(s) found${cut}` }],
        structuredContent: { ...found },
      };
    },
  );

  // --- ACS scripts / functions / profiling ----------------------------------
  registerLive(
    "list_scripts",
    {
      title: "List ACS scripts",
      description:
        "Run `dumpscripts` and return every script across loaded modules (module, number, name, type, arg count).",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const scripts = parseScripts(await client.runCommand("dumpscripts"));
      return {
        content: [{ type: "text", text: `${scripts.length} script(s)` }],
        structuredContent: { scripts },
      };
    },
  );

  registerLive(
    "list_functions",
    {
      title: "List ACS functions",
      description: "Run `dumpfunctions` and return named ACS functions across loaded modules.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const functions = parseFunctions(await client.runCommand("dumpfunctions"));
      return {
        content: [{ type: "text", text: `${functions.length} function(s)` }],
        structuredContent: { functions },
      };
    },
  );

  registerLive(
    "profile_scripts",
    {
      title: "Profile ACS scripts",
      description: `Run \`acsprofile\` and return per-script/function execution stats (total instructions, runs, avg/min/max). ${profileRows(notes.profileScripts)}`,
      inputSchema: { instance: instanceArg, sort: profileSort, limit: profileLimit },
    },
    async ({ instance, sort, limit }) => profileEntries(await ctx.clientFor(instance), "", sort, limit),
  );

  registerLive(
    "profile_window",
    {
      title: "Profile a time window",
      description: `Clear ACS profiling, wait N seconds, then return what ran during that window — \`what's hot right now\` rather than cumulative since map start. ${profileRows(notes.profileScripts)}`,
      inputSchema: {
        instance: instanceArg,
        seconds: z.number().int().min(1).max(30).default(3),
        sort: profileSort,
        limit: profileLimit,
      },
    },
    async ({ instance, seconds, sort, limit }, extra) => {
      const client = await ctx.clientFor(instance);
      await client.runCommand("acsprofile clear");
      await withProgress(extra, seconds * 1000, `sampling for ${seconds}s`, () =>
        sleep(seconds * 1000),
      );
      return profileEntries(client, ` over ${seconds}s`, sort, limit);
    },
  );

  // --- map-scope ACS variables/arrays (by name, across loaded modules) ------
  registerLive(
    "list_modules",
    {
      title: "List loaded ACS modules",
      description:
        "Run `dumpmodules` and return the loaded ACS modules (id + name). Map vars live only while a map is loaded.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const client = await ctx.clientFor(instance);
      const modules = parseModules(await client.runCommand("dumpmodules"));
      return {
        content: [{ type: "text", text: `${modules.length} module(s)` }],
        structuredContent: { modules },
      };
    },
  );

  /** The engine's cwd, which relative launch files resolve against: its log sits there. */
  function launchDir(last: LastLaunch): string {
    return path.dirname(last.logFile);
  }

  /** The four map-var tools' sourceFile path (undefined without one), resolving the slot host-side for
   *  `mcp_mapslot`, which first proves the loaded module is the one resolved. */
  async function bySourceFile(args: SourceFileArgs, array: boolean) {
    const { instance, name, index, value, sourceFile, object, includeDirs } = args;
    if (sourceFile === undefined) {
      return object !== undefined || includeDirs !== undefined ? fail("object and includeDirs need sourceFile") : undefined;
    }
    const client = await ctx.clientFor(instance);
    requireCap(client, "mapslot");
    const last = ctx.launchArgsFor(instance);
    const files = object !== undefined ? [object] : last?.args.files?.map((f) => path.resolve(launchDir(last), f));
    if (!files?.length) {
      return fail(`instance ${instance} has no launch files to find the source's build in (attached, or launched without files): pass object, the deployed file`);
    }
    const deployed: AcsModule[] = [];
    for (const f of files) {
      try {
        deployed.push(...ctx.deployedModules(f));
      } catch (e) {
        return fail(`can't read ${f} to find the source's build in: ${(e as Error).message}`);
      }
    }
    const expr = array ? `${name}[${index}]` : name;
    const exe = ctx.config.bcc?.trim() || undefined;
    const res = ctx.io.resolveMapSlot({ sourceFile, expr, exe, includeDirs, deployed, engine });
    if ("refused" in res) return fail(`${expr} refused by the ${res.guard} check, nothing sent to the engine: ${res.refused}`);
    const { len, first, md5 } = res.digest;
    const sent = command("mcp_mapslot", res.slot, ...kvArgs({ v: 1, code: len, first, md5, index: res.index, set: value }));
    const output = await client.runCommand(sent);
    const reply = parseMapSlot(output);
    if (!reply) {
      const nomatch = parseMapSlotNoMatch(output);
      if (!nomatch) return failed(output);
      const marker = res.module.map ? `the BEHAVIOR of map ${res.module.map}` : "a library";
      return fail(
        `The loaded module isn't the one resolved: none of the ${nomatch.modules} loaded on map ${nomatch.map} matches ${res.module.name} (${marker}), built from ${sourceFile}. ` +
          "Another map is loaded, the map has no BEHAVIOR of its own, or the file was rebuilt after launch (relaunch to load it).",
      );
    }
    const echoed = reply.slot === res.slot && reply.index === res.index && (value === undefined || reply.value === value);
    if (!echoed) return fail(`the engine's reply doesn't echo the slot, index and value sent (${sent}): ${output.join("\n")}`);
    const at = `slot ${res.slot}${res.index !== undefined ? `[${res.index}]` : ""} of module ${reply.module} ${reply.name}, ${res.module.name}`;
    const said = value === undefined ? String(reply.value) : `${expr} = ${reply.value}`;
    return {
      content: [{ type: "text" as const, text: `${said} (${at})` }],
      structuredContent: {
        name,
        ...(array ? { index } : {}),
        value: reply.value,
        slot: res.slot,
        ...(res.index !== undefined ? { offset: res.index } : {}),
        module: { id: reply.module, name: reply.name, deployed: res.module.name },
      },
    };
  }

  registerLive(
    "get_map_var",
    {
      title: "Get map variable",
      description:
        "Read a map-scope ACS variable by name (searched across loaded modules, exported names only), or with sourceFile any map var by expression.",
      inputSchema: { instance: instanceArg, name: acsName, ...sourceFileArgs },
    },
    async (args) => {
      const viaSource = await bySourceFile(args, false);
      if (viaSource) return viaSource;
      const { instance, name } = args;
      const client = await ctx.clientFor(instance);
      const read = await readMapVar(client, name);
      if ("error" in read) return fail(read.error);
      return { content: [{ type: "text", text: String(read.value) }], structuredContent: { name, value: read.value } };
    },
  );

  registerLive(
    "set_map_var",
    {
      title: "Set map variable",
      description: "Write a map-scope ACS variable by name (exported names only), or with sourceFile any map var by expression.",
      inputSchema: { instance: instanceArg, name: acsName, value: z.number().int(), ...sourceFileArgs },
    },
    async (args) => {
      const viaSource = await bySourceFile(args, false);
      if (viaSource) return viaSource;
      const { instance, name, value } = args;
      const client = await ctx.clientFor(instance);
      const result = parseMapVar(await client.runCommand(command("setmapvar", name, value)));
      if (result === null) {
        return fail(`map var '${name}' not found`);
      }
      return {
        content: [{ type: "text", text: `${name} = ${result}` }],
        structuredContent: { name, value: result },
      };
    },
  );

  registerLive(
    "get_map_array",
    {
      title: "Get map array element",
      description:
        "Read one element of a map-scope ACS array by name (exported names only) and index, or with sourceFile of any map array (name is then an expression, read at name[index]).",
      inputSchema: { instance: instanceArg, name: acsName, index: z.number().int().min(0), ...sourceFileArgs },
    },
    async (args) => {
      const viaSource = await bySourceFile(args, true);
      if (viaSource) return viaSource;
      const { instance, name, index } = args;
      const client = await ctx.clientFor(instance);
      const read = await readMapArray(client, name, index);
      if ("error" in read) return fail(read.error);
      return {
        content: [{ type: "text", text: String(read.value) }],
        structuredContent: { name, index, value: read.value },
      };
    },
  );

  registerLive(
    "set_map_array",
    {
      title: "Set map array element",
      description:
        "Write one element of a map-scope ACS array by name (exported names only) and index, or with sourceFile of any map array (name is then an expression, written at name[index]).",
      inputSchema: {
        instance: instanceArg,
        name: acsName,
        index: z.number().int().min(0),
        value: z.number().int(),
        ...sourceFileArgs,
      },
    },
    async (args) => {
      const viaSource = await bySourceFile(args, true);
      if (viaSource) return viaSource;
      const { instance, name, index, value } = args;
      const client = await ctx.clientFor(instance);
      const result = parseMapArray(
        await client.runCommand(command("setmaparray", name, index, value)),
      );
      if (result === null) {
        return fail(`map array '${name}' not found`);
      }
      return {
        content: [{ type: "text", text: `${name}[${index}] = ${result}` }],
        structuredContent: { name, index, value: result },
      };
    },
  );

  // --- renderer / UI inspection (read-only) ---------------------------------
  async function renderInfo(instance: number) {
    const client = await ctx.clientFor(instance);
    return parseRenderInfo(await client.runCommand("dumprenderer"));
  }

  registerLive(
    "renderer_info",
    {
      title: "Renderer info",
      description:
        notes.rendererInfo,
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      // Every render key an overlay may print; pick drops the ones this engine doesn't.
      const info = pick(await renderInfo(instance), [
        "renderer",
        "gl_vendor",
        "gl_shadermodel",
        "gl_maxtexsize",
        "device",
        "screen_width",
        "screen_height",
        "client_width",
        "client_height",
        "vid_renderer",
        "vid_preferbackend",
        "fullscreen",
        "vid_fullscreen",
        "vid_vsync",
        "vid_defwidth",
        "vid_defheight",
        "fps",
      ]);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  registerLive(
    "viewport_info",
    {
      title: "Viewport info",
      description: "The 3D view window rect (x/y/width/height) and screenblocks size.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const info = pick(await renderInfo(instance), [
        "view_x",
        "view_y",
        "view_width",
        "view_height",
        "screenblocks",
      ]);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  registerLive(
    "hud_info",
    {
      title: "HUD info",
      description: "Status bar Y position, status bar / HUD scale, alt HUD, crosshair.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const info = pick(await renderInfo(instance), [
        "statusbar_y",
        "st_scale",
        "hud_scale",
        "hud_althud",
        "crosshair",
      ]);
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  // --- map geometry (read-only) ---------------------------------------------
  register(
    "map_info",
    {
      title: "Map info",
      description:
        "Read a map from a WAD and return its format (doom/hexen/udmf) and entity counts. Reads the file directly — the game need not be running.",
      inputSchema: { map: z.string().min(1), file: mapFileArg },
    },
    async ({ map, file }) => {
      const data = ctx.loadMap(file, map);
      const info = {
        format: data.format,
        sectors: data.sectors.length,
        linedefs: data.linedefs.length,
        sidedefs: data.sidedefs.length,
        vertices: data.vertices.length,
      };
      return { content: [{ type: "text", text: JSON.stringify(info) }], structuredContent: info };
    },
  );

  register(
    "get_sector",
    {
      title: "Get sector",
      description: "Return one sector's properties by index (all fields, format-native keys).",
      inputSchema: { map: z.string().min(1), index: z.number().int().min(0), file: mapFileArg },
    },
    async ({ map, index, file }) => {
      const data = ctx.loadMap(file, map);
      const sector = data.sectors[index];
      if (!sector) {
        return fail(`No sector ${index} (map has ${data.sectors.length}).`);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(sector) }],
        structuredContent: { sector },
      };
    },
  );

  register(
    "get_linedef",
    {
      title: "Get linedef",
      description:
        "Return one linedef by index, with its referenced sidedefs (textures + offsets) resolved.",
      inputSchema: { map: z.string().min(1), index: z.number().int().min(0), file: mapFileArg },
    },
    async ({ map, index, file }) => {
      const data = ctx.loadMap(file, map);
      const line = data.linedefs[index];
      if (!line) {
        return fail(`No linedef ${index} (map has ${data.linedefs.length}).`);
      }
      const sides = ["front", "back", "sidefront", "sideback"]
        .map((k) => line[k])
        .filter((v): v is number => typeof v === "number" && v >= 0)
        .map((i) => data.sidedefs[i])
        .filter(Boolean);
      const result = { line, sides };
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  register(
    "find_sectors_by_tag",
    {
      title: "Find sectors by tag",
      description: "Return all sectors whose tag/id matches (binary `tag`, or UDMF `id` and `moreids`).",
      inputSchema: { map: z.string().min(1), tag: z.number().int(), file: mapFileArg },
    },
    async ({ map, tag, file }) => {
      const data = ctx.loadMap(file, map);
      const sectors = data.sectors.filter((s) => sectorTags(s).includes(tag));
      return {
        content: [{ type: "text", text: `${sectors.length} sector(s) with tag ${tag}` }],
        structuredContent: { sectors },
      };
    },
  );

  // --- map probes (live) -----------------------------------------------------
  const probeLimits =
    "Collision runs on a throwaway probe actor shaped like the mover, which moves like a monster of its size: a player's step-up onto low actors isn't modeled. Player-only blocking lines are honored for a player mover. Probes are refused on a netgame client and during demo playback or recording.";
  /** One probe CCMD's reply: its records under `tags`, or the tool error when it failed. */
  async function runProbe(
    instance: number,
    cmd: string,
    header: string,
    tags: string[],
  ): Promise<{ output: string[]; records?: [KvRecord, ...(KvRecord | undefined)[]] }> {
    const client = await ctx.clientFor(instance);
    const output = await client.runCommand(cmd);
    const [main, ...rest] = tags.map((t) => parseKvLines(output, t)[0]);
    const bad = firstError(output) !== undefined || !hasHeader(output, header) || main === undefined;
    return { output, records: bad ? undefined : [main, ...rest] };
  }

  registerLive(
    "point_info",
    {
      title: "Point info (live map)",
      description:
        "Run `mcp_pointinfo`: the live sector at map x/y with its floor and ceiling height (the bare planes, as GetSectorFloorZ/CeilingZ; floor3d/ceiling3d when a solid 3D floor around z differs), floor and ceiling texture (the surfaces around z, as CheckActorFloorTexture sees them), light, special and tag, and inmap (0 in the void; omitted when the map has no GL nodes). " +
        `With radius and height, or a mover (whose size fills in any not given), also whether an actor that size fits there (at z, else on the floor): ok, or reason actor (blocker), line, ceiling, floor (z below it) or slope. Only the mover is set aside, so without one the player standing there blocks the fit itself (actor blocker=player0). ${probeLimits}`,
      inputSchema: {
        instance: instanceArg,
        x: mapCoord(),
        y: mapCoord(),
        z: mapCoord().optional(),
        radius: probeSize(),
        height: probeSize(),
        mover: moverRef.optional(),
      },
    },
    async ({ instance, x, y, z: zPos, radius, height, mover }) => {
      const kv = kvArgs({ z: zPos, radius, height, mover: mover && refToken(mover) });
      const cmd = command("mcp_pointinfo", realToken(x), realToken(y), ...kv);
      const { output, records } = await runProbe(instance, cmd, "MCP_POINT", ["point", "floortex", "ceiltex", "fit"]);
      if (!records) return failed(output);
      const [point, floorTex, ceilTex, fit] = records;
      const floorTexture = floorTex?.name, ceilingTexture = ceilTex?.name;
      const fits = fit && { ...fit, ok: fit.ok === 1 };
      const where = point.inmap === 0 ? " (outside the map)" : "";
      const fitText = !fits ? "" : fits.ok ? ", fits" : `, doesn't fit: ${blockText(fit)}`;
      const text = `sector ${point.sector}${where} floor ${point.floorz} ceiling ${point.ceilingz} ${floorTexture}/${ceilingTexture}${fitText}`;
      return { content: [{ type: "text", text }], structuredContent: { ...point, floorTexture, ceilingTexture, fit: fits } };
    },
  );

  registerLive(
    "check_sight",
    {
      title: "Check line of sight (live map)",
      description:
        "Run `mcp_checksight`: whether the engine sees a line of sight between two actors or map points, as ACS CheckSight does (from the eye at 3/4 of from's height to any part of to; invisibility ignored). A point ({x, y, z?}) is a 1-unit-high probe at z or the floor, so its eye is 0.75 above that: pass z (e.g. floor + 41 for a player's view) to look from eye height. " +
        "water: true ignores Boom deep-water boundaries; pastBlocking: true sees past block-everything lines. When not visible, line names the first line a straight trace from eye to target middle hits, a hint that may be missing. A point needs a probe, refused on a netgame client and during demos.",
      inputSchema: {
        instance: instanceArg,
        from: actorRef,
        to: actorRef,
        water: z.boolean().optional(),
        pastBlocking: z.boolean().optional(),
      },
    },
    async ({ instance, from, to, water, pastBlocking }) => {
      // P_CheckSight's SF_ bits, as ACS CheckSight maps its own: SF_IGNOREWATERBOUNDARY 8, and
      // SF_SEEPASTBLOCKEVERYTHING 4 with SF_SEEPASTSHOOTABLELINES 2 (else only impact-script lines are seen past).
      const flags = (water ? 8 : 0) | (pastBlocking ? 4 | 2 : 0);
      const kv = kvArgs({ from: refToken(from), to: refToken(to), flags: flags || undefined });
      const { output, records } = await runProbe(instance, command("mcp_checksight", ...kv), "MCP_SIGHT", ["sight"]);
      if (!records) return failed(output);
      const [raw] = records;
      const hint = raw.line !== undefined ? ` (line ${raw.line})` : "";
      const text = `${raw.visible === 1 ? "visible" : "not visible"}: ${raw.from} -> ${raw.to}${hint}`;
      return { content: [{ type: "text", text }], structuredContent: { ...raw, visible: raw.visible === 1 } };
    },
  );

  registerLive(
    "trace_move",
    {
      title: "Trace a straight move (live map)",
      description:
        "Run `mcp_tracemove`: whether the mover (default the player, none on a netgame server; its size and step/dropoff limits, radius/height override the size) walks straight from `from` (default its position) to `to`, stepping a probe at most radius-1 units at a time and testing each step as the engine's movement does. " +
        "Reports ok, or where it stops (x/y/z, dist of total) and why: line, actor (blocker; actors: false ignores actors), step (rise above the step height), ceiling, dropoff (drop, for a walking monster or NODROPOFF), slope or outside. " +
        `Geometry only: no momentum, line specials (teleporters, crossing triggers), moving sectors or damaging floors. ${probeLimits} Pre-check a move_to leg with it.`,
      inputSchema: {
        instance: instanceArg,
        to: z.object({ x: mapCoord(), y: mapCoord() }),
        from: z.object({ x: mapCoord(), y: mapCoord() }).optional(),
        mover: moverRef.optional(),
        radius: probeSize(),
        height: probeSize(),
        actors: z.boolean().optional(),
      },
    },
    async ({ instance, to, from, mover, radius, height, actors }) => {
      const kv = kvArgs({
        from: from && `${realToken(from.x)},${realToken(from.y)}`,
        mover: mover && refToken(mover),
        radius,
        height,
        actors: actors === false ? 0 : undefined,
      });
      const cmd = command("mcp_tracemove", realToken(to.x), realToken(to.y), ...kv);
      const { output, records } = await runProbe(instance, cmd, "MCP_TRACE", ["trace"]);
      if (!records) return failed(output);
      const [raw] = records;
      const text =
        raw.ok === 1
          ? `clear: reaches (${raw.x}, ${raw.y}) after ${raw.total}`
          : `blocked by ${blockText(raw)} after ${raw.dist} of ${raw.total} at (${raw.x}, ${raw.y})`;
      return { content: [{ type: "text", text }], structuredContent: { ...raw, ok: raw.ok === 1 } };
    },
  );

  // --- process management ----------------------------------------------------
  /** The configured engine path, or why it can't be launched. */
  function launchableExe(): { exe: string } | { error: string } {
    const exe = ctx.config.exe;
    if (!exe) {
      return {
        error: `Set ${ctx.env("EXE")} to the engine path (${engine.exeHint}) to launch instances.`,
      };
    }
    if (!ctx.io.existsSync(exe)) return { error: `${ctx.env("EXE")} not found at ${exe} — check the path.` };
    if (!ctx.io.hasBridge(exe, bridgeMarker(engine))) {
      return {
        error: `${ctx.env("EXE")} at ${exe} has no MCP bridge — that looks like a stock ${engine.displayName} (or GZDoom), which the MCP can't drive. Point it at a bridge-patched build${engine.bridgeHelp}.`,
      };
    }
    return { exe };
  }

  /** Why `args` can't be launched as given, checked before anything is stopped or spawned. */
  function launchArgsError(args: LaunchArgs): string | undefined {
    if (args.config === "isolated" && hasArg(args.extraArgs, "-config")) {
      return `config: "isolated" and a -config in extraArgs both pick the config file; drop one of them.`;
    }
  }

  function readIfExists(file: string): string | undefined {
    return ctx.io.existsSync(file) ? ctx.io.readTextSync(file) : undefined;
  }

  /** The engine's captured stderr beside a console log, or undefined when there is none. */
  function stderrFor(logFile: string | undefined): string | undefined {
    return logFile === undefined ? undefined : readIfExists(stderrLogPath(logFile));
  }

  interface Launched {
    port: number;
    logFile: string;
    isolatedConfig?: string;
    /** Spawned with wait: false, so not attached yet; `pid` is the child's. */
    pending?: { pid?: number };
    error?: string;
  }

  /** Store `args` for relaunch, pick a port, spawn and (unless `wait: false`) attach. */
  async function launchWith(instance: number, exe: string, args: LaunchArgs, extra: ToolExtra): Promise<Launched> {
    // Pick the first free port at/above the conventional one for this instance, so a
    // stale engine (or anything) squatting the default port can't cause a mis-attach.
    const port = await ctx.io.findFreePort(ctx.portFor(instance));
    const logFile = path.join(path.dirname(exe), `mcp-bridge-${port}.log`);
    ctx.rememberLaunchArgs(instance, args, port, logFile);
    ctx.rememberLaunch(instance, port, logFile);
    // LaunchOptions.config is a path, so the mode must not ride along in the spread; nor is wait an option.
    const { config, wait, ...options } = args;
    const isolateConfig = config === "isolated";
    const isolatedConfig = isolateConfig ? isolatedConfigPathFor(engine, configPathFor(engine, exe), port) : undefined;
    const launch = { id: instance, exe, cwd: path.dirname(exe), port, logFile, isolateConfig, ...options };
    try {
      const child = ctx.registry.spawn(launch, ctx.io.launchIo);
      // The child is the engine: a failed launch still matches its crash report, and an attach checks identity.
      ctx.rememberEngine(instance, child.pid);
      if (wait === false) return { port, logFile, isolatedConfig, pending: { pid: child.pid } };
      // The engine can take tens of seconds to boot a big mod and open its
      // bridge — well past a default client timeout, so report progress.
      const client = await withProgress(extra, 42000, "waiting for the engine", () =>
        ctx.registry.attachOrKill(launch, ctx.io.launchIo),
      );
      // A spawn that reported no PID skipped the handshake, so the bridge's own PID is all there is.
      if (child.pid === undefined) ctx.rememberEngine(instance, client.enginePid);
    } catch (e) {
      // Nothing was spawned, so any log on this port is an earlier run's.
      if (e instanceof LaunchSetupError) return { port, logFile, error: e.message };
      // The bridge never opened, most often a DECORATE/ACS compile error or another
      // startup fatal: surface the engine's stderr and log instead of just the timeout.
      const error = startupFailureText({
        instance,
        message: e instanceof Error ? e.message : String(e),
        exit: e instanceof EngineExitedError ? e.exit : undefined,
        logText: readIfExists(logFile),
        stderrText: stderrFor(logFile),
      });
      return { port, logFile, error };
    }
    return { port, logFile, isolatedConfig };
  }

  /** A wait: false launch whose engine may still open its bridge; a pending child that died can't, so it isn't one. */
  function waitingLaunch(instance: number): boolean {
    const pid = ctx.registry.childPid(instance);
    return ctx.registry.pending(instance) && (pid === undefined || ctx.io.alive(pid));
  }

  /** `, config <path>` for an isolated instance, so the caller can find (or pgrep) its ini. */
  const configNote = (r: { isolatedConfig?: string }) => (r.isolatedConfig ? `, config ${r.isolatedConfig}` : "");
  /** The reply line a `wait: false` launch adds, none otherwise. */
  const pendingLines = (r: Launched) =>
    r.pending
      ? [`Not attached yet${r.pending.pid !== undefined ? ` (engine PID ${r.pending.pid})` : ""}: its first tool call waits for the bridge and attaches.`]
      : [];

  registerLive(
    "launch_instance",
    {
      scenario: SCENARIO_REFUSALS.lifecycle,
      title: `Launch a ${engine.displayName} instance`,
      description:
        `Spawn a bridge-enabled ${engine.displayName} process with the given options and attach to it (with wait: false, on its first tool call instead). Requires ${ctx.env("EXE")} to be set.`,
      inputSchema: { instance: instanceArg, ...launchArgsSchema },
    },
    async ({ instance, iwad, ...rest }, extra) => {
      // Its bridge port isn't open, so a second launch would pick that port and orphan the first engine.
      if (waitingLaunch(instance)) {
        return fail(`Instance ${instance} is still waiting from a wait: false launch; kill_instance or relaunch_instance it first.`);
      }
      const checked = launchableExe();
      if ("error" in checked) return fail(checked.error);
      const args = { iwad: iwad ?? ctx.config.iwad, ...rest };
      const invalid = launchArgsError(args);
      if (invalid) return fail(invalid);
      const r = await launchWith(instance, checked.exe, args, extra);
      if (r.error) return fail(r.error);
      const verb = r.pending ? "spawned" : "launched";
      const lines = [`${verb} instance ${instance} on bridge port ${r.port}${configNote(r)}`, ...pendingLines(r)];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  registerLive(
    "relaunch_instance",
    {
      scenario: SCENARIO_REFUSALS.lifecycle,
      title: `Relaunch a ${engine.displayName} instance with its last options`,
      description:
        `Quit an instance this session launched and start it again with the same options (iwad, files, map, skill, window, extraArgs, config, wait), e.g. to pick up ${notes.reloadLumps} edits. Any option given here replaces the stored one for this and later relaunches; [] clears files/extraArgs. Refuses for an attached instance.`,
      inputSchema: {
        instance: instanceArg,
        ...launchArgsSchema,
        iwad: launchArgsSchema.iwad.describe("Path to the IWAD. Omit to keep the stored one."),
      },
    },
    async ({ instance, ...overrides }, extra) => {
      const last = ctx.launchArgsFor(instance);
      if (!last) {
        return fail(`Instance ${instance} has no launch options to reuse: it was attached with attach_instance, or not launched in this MCP session. Use launch_instance.`);
      }
      const checked = launchableExe();
      if ("error" in checked) return fail(checked.error);
      const given = Object.entries(overrides).filter(([, v]) => v !== undefined);
      const args: LaunchArgs = { ...last.args, ...Object.fromEntries(given) };
      const invalid = launchArgsError(args);
      if (invalid) return fail(invalid);

      const quit = await ctx.quit(instance);
      const stopped = { clean: "old engine stopped", forced: "force-killed", absent: "was not running", unbridged: "killed before its bridge came up" }[quit];
      ctx.forgetInstance(instance);
      // A force-killed engine can hold its port briefly; wait so the relaunch keeps it.
      await pollUntil(() => ctx.io.findFreePort(last.port), (p) => p === last.port, {
        waits: RELAUNCH_PORT_WAITS,
        wait: () => sleep(RELAUNCH_PORT_WAIT_MS),
      });

      const r = await launchWith(instance, checked.exe, args, extra);
      if (r.error) return fail(r.error);
      const lines = [
        `relaunched instance ${instance} on bridge port ${r.port}${configNote(r)} (${stopped})`,
        ...pendingLines(r),
      ];
      if (r.port !== last.port) {
        lines.push(`The bridge port changed from ${last.port}, so the engine log is now ${r.logFile}.`);
      }
      const crashFile = crashLogPath(last.logFile);
      if (
        last.enginePid !== undefined &&
        ctx.io.existsSync(crashFile) &&
        crashReportPid(ctx.io.readTextSync(crashFile)) === last.enginePid
      ) {
        lines.push(`previous engine (PID ${last.enginePid}) crashed; its backtrace is at ${crashFile}`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  registerLive(
    "attach_instance",
    {
      scenario: SCENARIO_REFUSALS.lifecycle,
      title: "Attach to an engine you started yourself",
      description:
        `Connect to a bridge-patched ${engine.displayName} that is ALREADY running — one you launched by hand, or from a terminal — and bind it to an instance number for the other tools. Only needed for engines this session didn't launch: launch_instance binds automatically. Defaults to this instance's conventional port. Refuses an instance whose launched engine is still running.`,
      inputSchema: { instance: instanceArg, port: z.number().int().positive().optional() },
    },
    async ({ instance, port }) => {
      // Rebinding would drop its port and launch options (relaunch, netgame role).
      const launched = ctx.registry.childPid(instance);
      const running = launched !== undefined && ctx.io.alive(launched);
      if (waitingLaunch(instance)) {
        return fail(`Instance ${instance} was launched with wait: false; call any tool on it to attach.`);
      }
      if (running) {
        return fail(
          `Instance ${instance} runs an engine this session launched (PID ${launched}); kill_instance it first, or attach another instance number.`,
        );
      }
      // Drop a dead child's handle and any earlier attach's client, PID and log path; kill on an exited child sends no signal.
      ctx.registry.kill(instance);
      ctx.forgetInstance(instance);
      const target = port ?? ctx.portFor(instance);
      ctx.bind(instance, target);
      try {
        const client = await ctx.clientFor(instance);
        // The instance now names an engine whose launch options are unknown.
        ctx.forgetLaunchArgs(instance);
        ctx.rememberEngine(instance, client.enginePid);
        const pid = client.enginePid !== undefined ? ` (engine PID ${client.enginePid})` : "";
        return {
          content: [{ type: "text", text: `attached instance ${instance} to port ${target}${pid}` }],
        };
      } catch (e) {
        // Don't leave a binding pointing at something we couldn't reach.
        ctx.forgetInstance(instance);
        const msg = e instanceof Error ? e.message : String(e);
        return fail(`Could not attach instance ${instance} to port ${target}: ${msg}. Is a bridge-patched engine listening there?`);
      }
    },
  );

  interface JoinResult {
    instance: number;
    joined: boolean;
    slot?: number;
    /** Why it isn't joined: the last state seen, or why it couldn't be tried. */
    reason?: string;
  }

  /** The `dumpplayers` slot of the player named `name` on this client, if it shows one. */
  async function slotOf(client: BridgeClient, name: string | undefined): Promise<number | undefined> {
    if (name === undefined) return undefined;
    const want = name.toLowerCase();
    const row = parseKvLines(await client.runCommand("dumpplayers"), "player").find(
      (p) => stripColor(String(p.name ?? "")).toLowerCase() === want,
    );
    return row ? Number(row.slot) : undefined;
  }

  /** Bring one client from spectating into the game, (re)sending the join per joinAction until it no longer spectates. */
  async function joinOne(n: number, joinCommand: string, budgetMs: number): Promise<JoinResult> {
    if (netInfo(n)?.role === "server") return { instance: n, joined: false, reason: "join can't be used on the server" };
    const client = await ctx.clientFor(n);
    if (!client.supports("status")) {
      return { instance: n, joined: false, reason: "this engine bridge has no status support (rebuild with the latest bridge)" };
    }
    let waitedMs = 0;
    let sent = 0;
    const read = async (): Promise<JoinState> => {
      const state = joinState((await client.readStatus(LOAD_READ_MS)).status);
      const next = joinAction(state, sent, waitedMs, budgetMs);
      sent = next.sent;
      if (next.send) await client.runCommand(joinCommand);
      return state;
    };
    const { value } = await pollUntil(read, (s) => s === "joined", {
      waits: Math.ceil(budgetMs / JOIN_POLL_MS),
      wait: async () => {
        await sleep(JOIN_POLL_MS);
        waitedMs += JOIN_POLL_MS;
      },
    });
    if (value !== "joined") return { instance: n, joined: false, reason: value };
    const slot = await slotOf(client, argValue(ctx.launchArgsFor(n)?.args.extraArgs, "+name"));
    return { instance: n, joined: true, ...(slot !== undefined && { slot }) };
  }

  register(
    "join_game",
    {
      title: "Join netgame clients into the game",
      description:
        "Bring netgame clients from spectating into the game: for each, wait until its own status shows it in a level, send the join command, and poll until it no longer spectates (a join lands a tic or two later). Idempotent: an already-joined client is just reported, so re-run it after a server `map`, which sends every client back to spectating. instances defaults to every bound instance launched with the client flag; a server is refused. slot is the player whose name matches the client's `+name` launch arg in its dumpplayers. Reports per client joined, or still spectating / connecting after timeoutSec.",
      inputSchema: {
        instances: z.array(z.number().int().positive()).min(1).optional(),
        timeoutSec: z.number().positive().max(WAIT_LOG_MAX_SEC).default(15),
      },
    },
    async ({ instances, timeoutSec }, extra) => {
      const joinCommand = engine.netgame?.joinCommand;
      if (!joinCommand) return fail(`${engine.displayName} clients enter the game as players when they connect; there is nothing to join.`);
      const targets = instances ?? ctx.boundInstances().filter((n) => netInfo(n)?.role === "client");
      if (targets.length === 0) {
        return fail("no client instances: launch them with the client flag in extraArgs, or pass instances");
      }
      const budgetMs = timeoutSec * 1000;
      const results = await withProgress(extra, budgetMs, "joining clients", () =>
        Promise.all(
          targets.map((n) =>
            joinOne(n, joinCommand, budgetMs).catch((e: Error): JoinResult => ({ instance: n, joined: false, reason: e.message })),
          ),
        ),
      );
      const secs = `${timeoutSec.toFixed(1)}s`;
      const describe = (r: JoinResult) => {
        if (r.joined) return r.slot === undefined ? "joined" : `joined as player ${r.slot}`;
        if (r.reason === "spectating") return `still spectating after ${secs}`;
        if (r.reason === "connecting") return `not in a level yet after ${secs}`;
        return `not joined: ${r.reason}`;
      };
      return {
        content: [{ type: "text", text: results.map((r) => `instance ${r.instance}: ${describe(r)}`).join("\n") }],
        structuredContent: { clients: results },
      };
    },
  );

  register(
    "kill_instance",
    {
      scenario: SCENARIO_REFUSALS.lifecycle,
      title: `Kill a ${engine.displayName} instance`,
      description:
        "Stop a launched instance and detach from it. Asks the engine to quit itself first (a hard kill mid-render can wedge macOS GPU teardown and leave an unkillable process), then force-kills if it doesn't exit. A wait: false instance not attached yet is attached first if its bridge is up; one whose bridge isn't up is force-killed at once.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const result = await ctx.quit(instance);
      ctx.forgetInstance(instance);
      const text = {
        clean: `instance ${instance} quit cleanly`,
        forced: `instance ${instance} did not quit on request — force-killed`,
        absent: `no instance ${instance} attached, nothing to kill`,
        unbridged: `instance ${instance} killed before its bridge came up`,
      }[result];
      return { content: [{ type: "text", text }] };
    },
  );

  register(
    "reset",
    {
      scenario: SCENARIO_REFUSALS.lifecycle,
      title: "Reset — reap this session's engine instances",
      description:
        "Kill every instance this session launched, and reap engines ORPHANED by earlier sessions (whose launcher is gone) that could otherwise squat bridge ports. Engines belonging to another running editor window are left alone. Pass all:true to also kill those — only do that if you know no other session is using this engine build.",
      inputSchema: {
        all: z
          .boolean()
          .default(false)
          .describe("Also kill engines owned by other live MCP sessions using this same build."),
      },
    },
    async ({ all }) => {
      ctx.registry.closeAll();
      ctx.forgetAll();
      if (!ctx.config.exe) {
        return {
          content: [
            { type: "text", text: `Reset tracked instances. (${ctx.env("EXE")} unset, so no orphan sweep.)` },
          ],
        };
      }
      // Orphans-only by default: a process whose parent is still alive belongs to
      // somebody else's session, and killing it would take down their game.
      const r = await ctx.io.reap(ctx.config.exe, { onlyOrphans: !all });
      const scope = all ? "engine process(es)" : "orphaned engine process(es)";
      const lines = [`Reset complete. Reaped ${r.killed.length} ${scope}.`];
      if (r.survivors.length) {
        lines.push(
          `${r.survivors.length} process(es) survived SIGKILL (PIDs ${r.survivors.join(", ")}) — ` +
            `these are wedged in the OS (macOS window-server exit-hang) and need a manual ` +
            `force-quit (Activity Monitor) or a logout to clear.`,
        );
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  register(
    "get_startup_errors",
    {
      title: "Get engine startup errors",
      description:
        "Read the engine's captured console log and stderr for an instance and surface DECORATE/ACS compile errors and fatal startup errors (the fatal text itself is on stderr). Works even when the bridge never came up (e.g. the engine aborted on a bad script) — exactly when the other tools can't connect. On a live instance the stderr part may hold harmless SDL/audio warnings.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const logFile = ctx.logPathFor(instance);
      const log = ctx.readLog(instance);
      const stderr = stderrFor(logFile);
      if (log === undefined && stderr === undefined) {
        return noLog(instance, ", then re-run this if it failed to start");
      }
      const sections = [stderrSection(stderr)];
      if (log === undefined) {
        sections.push(`No engine log at ${logFile} (the engine died before opening one, or hasn't opened it yet).`);
      } else {
        const errors = parseStartupErrors(log);
        // With stderr shown above, "no errors detected" would contradict a fatal printed there.
        const none = sections[0]
          ? "The engine log has no compile/fatal error lines. Last lines for context:"
          : "No compile/fatal errors detected. Last lines of the engine log for context:";
        sections.push(
          errors.length
            ? `Detected ${errors.length} error line(s) in the engine log:\n\n${errors.join("\n")}`
            : `${none}\n\n${tailLines(log).join("\n")}`,
        );
      }
      return { content: [{ type: "text", text: sections.filter((s) => s !== undefined).join("\n\n") }] };
    },
  );

  register(
    "read_log",
    {
      title: "Read the engine console log",
      description:
        "Read an instance's engine console log, which catches prints that never come back in a command reply (e.g. cheat ON/OFF messages, emitted a tic later). Correlation sentinel lines are dropped. `pattern` is a case-insensitive regex filter and `exclude` one that drops what it matches. Without `sinceLine` this returns the last `maxLines` matches; with it, the first `maxLines` matches after that line. Pass the returned `nextLine` as `sinceLine` to read only what was logged since. `count` returns only how many lines match (all of them, ignoring maxLines; with sinceLine, only the new ones). The reply names the log file (`log=`): it is this instance's own (one per bridge port), so Bash can grep it directly.",
      inputSchema: {
        instance: instanceArg,
        pattern: regexArg().optional(),
        exclude: regexArg().optional(),
        sinceLine: z.number().int().nonnegative().optional(),
        maxLines: z.number().int().positive().default(LOG_LINES),
        count: z.boolean().default(false),
      },
    },
    async ({ instance, pattern, exclude, sinceLine, maxLines, count }) => {
      const logFile = existingLog(instance);
      if (!logFile) return noLog(instance);
      // Uncapped for count, so a forward read's nextLine is the end of the log, not a cap's resume point.
      const cap = count ? Number.POSITIVE_INFINITY : maxLines;
      const win = readLogWindow(ctx.io.readTextSync(logFile), { pattern, exclude, sinceLine, maxLines: cap });
      if (count) {
        const n = win.lines.length;
        return {
          content: [{ type: "text", text: `${n} matching line(s), nextLine=${win.nextLine}, log=${logFile}` }],
          structuredContent: { path: logFile, count: n, nextLine: win.nextLine },
        };
      }
      const head =
        `${win.lines.length} line(s), nextLine=${win.nextLine}` +
        (win.omitted ? `, ${win.omitted} more matching line(s) not shown` : "") +
        `, log=${logFile}`;
      const text = [head, ...win.lines.map((l) => `${l.line}: ${l.text}`)].join("\n");
      return { content: [{ type: "text", text }], structuredContent: { path: logFile, ...win } };
    },
  );

  register(
    "wait_for_log",
    {
      title: "Wait for a line in the engine log",
      description:
        `Poll an instance's engine log (the file read_log reads, so a busy bridge doesn't block it) until \`count\` lines matching \`pattern\` (a case-insensitive regex) appear after \`sinceLine\`, the engine exits, or timeoutSec of wall-clock time passes. For netgames, which can't be stepped: wait on a marker a server or client prints. sinceLine 0 (the default) means since this launch, so a line printed before the call still matches; pass a previous call's nextLine to wait for a new occurrence. Never touches pause, and a paused game logs nothing new (a paused netgame client holds back what the server relays): offline, step (or run_command/run_script with stepTics) with logPattern is the tic-exact way. Reports reason matched, timeout or exited; only an invalid pattern is an error.`,
      inputSchema: {
        instance: instanceArg,
        pattern: regexArg(),
        timeoutSec: z.number().positive().max(WAIT_LOG_MAX_SEC).default(10),
        sinceLine: z.number().int().nonnegative().default(0),
        count: z.number().int().min(1).max(50).default(1),
      },
    },
    async ({ instance, pattern, timeoutSec, sinceLine, count }, extra) => {
      const opts = { pattern, sinceLine, maxLines: count };
      const first = readInstanceLog(instance, opts);
      if (!first) return noLog(instance);
      // A log that vanished mid-wait (a relaunch truncates it) reads as no match yet.
      const read = (): LogWindow => readInstanceLog(instance, opts) ?? { lines: [], nextLine: sinceLine, omitted: 0 };
      const pid = ctx.enginePidFor(instance);
      let waitedMs = 0;
      let exited = false;
      const { value } = await withProgress(extra, timeoutSec * 1000, `waiting for /${pattern}/`, () =>
        pollUntil(() => (waitedMs === 0 ? first : read()), (w) => exited || w.lines.length >= count, {
          waits: Math.ceil((timeoutSec * 1000) / WAIT_LOG_POLL_MS),
          wait: async () => {
            await sleep(WAIT_LOG_POLL_MS);
            waitedMs += WAIT_LOG_POLL_MS;
            // Checked before the next read, so a line printed just before the exit still counts.
            if (pid !== undefined && !ctx.io.alive(pid)) exited = true;
          },
        }),
      );
      const { lines, nextLine } = value;
      const reason = lines.length >= count ? "matched" : exited ? "exited" : "timeout";
      const secs = `${(waitedMs / 1000).toFixed(1)}s`;
      const head = {
        matched: `matched after ${secs}, nextLine=${nextLine}`,
        exited: `engine exited after ${secs}, ${lines.length}/${count} match(es), nextLine=${nextLine}`,
        timeout: `timeout after ${secs}, ${lines.length}/${count} match(es), nextLine=${nextLine}`,
      }[reason];
      return {
        content: [{ type: "text", text: [head, ...lines.map((l) => `${l.line}: ${l.text}`)].join("\n") }],
        structuredContent: { reason, lines, nextLine, waitedMs },
      };
    },
  );

  register(
    "read_marks",
    {
      title: "Read playtest marks",
      description:
        "List the playtest marks a human left with the `mcp_mark [note]` console command (bind it once with `bind <key> mcp_mark`), read from the instance's console log: per mark its number n, tic (gametic, runs while paused), maptime, map, player position/angle (none on a netgame server, which has no player of its own), round (from the script the `mcp_mark_round` cvar names; \"none\" when that script isn't loaded), invasion wave, screenshot name and note. " +
        "Pass `mark` (n) for that mark plus its screenshot as an image. The console log is rewritten each launch; for an earlier session's marks pass `gamelog`, an absolute path or a gamelog file name in the dir launches write gamelogs to (" + ctx.env("BRIDGE_GAMELOG") + "'s, else the engine's default).",
      inputSchema: {
        instance: instanceArg,
        gamelog: z.string().min(1).optional(),
        mark: z.number().int().positive().optional(),
      },
    },
    async ({ instance, gamelog, mark }) => {
      let file: string | undefined;
      if (gamelog !== undefined) {
        // The gamelog dir follows the BRIDGE_GAMELOG override.
        const got = resolveGamelog(gamelog, ctx.config.gamelog && path.dirname(ctx.config.gamelog), ctx.env("EXE"));
        if ("error" in got) return fail(got.error);
        file = got.file;
        if (!ctx.io.existsSync(file)) return fail(`No gamelog at ${file}.`);
      } else {
        file = existingLog(instance);
        if (!file) return noLog(instance);
      }
      const win = readLogWindow(ctx.io.readTextSync(file), { pattern: "MCP_MARK", maxLines: Number.MAX_SAFE_INTEGER });
      const marks = parseMarks(win.lines);
      if (mark === undefined) {
        const head = marks.length ? `${marks.length} mark(s) in ${file}` : `No marks in ${file}.`;
        return {
          content: [{ type: "text", text: [head, ...marks.map(formatMark)].join("\n") }],
          structuredContent: { file, marks },
        };
      }
      // An appended log can repeat an n across launches: the latest wins.
      const found = marks.filter((m) => m.n === mark).pop();
      if (!found) {
        return fail(`No mark ${mark} in ${file}; marks: ${marks.map((m) => m.n).join(", ") || "none"}.`);
      }
      const text = formatMark(found);
      const shotFile = found.shot ? path.join(ctx.config.screenshotDir, `${found.shot}.png`) : undefined;
      if (!shotFile || !ctx.io.existsSync(shotFile)) {
        const why = `(${shotFile ? `screenshot ${shotFile} not found` : "no screenshot was taken"})`;
        return { content: [{ type: "text", text: `${text}\n${why}` }], structuredContent: withNotes({ mark: found }, [why]) };
      }
      return {
        content: [
          { type: "text", text },
          { type: "image", data: ctx.io.readFileSync(shotFile).toString("base64"), mimeType: "image/png" },
        ],
        structuredContent: { mark: found, shotPath: shotFile },
      };
    },
  );

  register(
    "get_crash",
    {
      title: "Get the last engine crash backtrace",
      description:
        "Return the signal, faulting address, and symbolized backtrace the bridge's crash handler captured the last time the engine crashed (segfault/abort/bus error/etc.). Use this when an instance dies unexpectedly — e.g. run_command reports the bridge closed. Says so if the instance has not crashed, with the tail of the engine's captured stderr when there is one (an in-game fatal error exits without a signal, and its text is only there; on a live instance it may hold harmless SDL/audio warnings). A report left by another engine (different PID) is named but not returned as this instance's crash; one that can't be tied to this engine (its PID is unknown, or the report has no pid line) is returned marked `Unverified:`.",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const logFile = ctx.logPathFor(instance);
      // An in-game fatal exits without a signal, so its text is only on stderr.
      const noCrash = (text: string) => ({
        content: [{ type: "text" as const, text: [text, stderrSection(stderrFor(logFile))].filter(Boolean).join("\n\n") }],
      });
      const crash = ctx.readCrash(instance);
      if (!crash) {
        return noCrash(
          `No crash recorded for instance ${instance}. (The engine writes a backtrace here only when it dies on a fatal signal.)`,
        );
      }
      const { text, noCrash: notThisEngine } = crashReportText({
        instance,
        crashFile: crash.file,
        report: crash.report,
        enginePid: ctx.enginePidFor(instance),
        written: crash.written,
      });
      return notThisEngine ? noCrash(text) : { content: [{ type: "text", text }] };
    },
  );

  register(
    "process_stats",
    {
      title: "Engine process memory",
      description:
        "Read the instance's engine process memory from /proc/<pid>/status (Linux only): vmRssKib (resident now), vmHwmKib (peak resident since start) and vmSizeKib (virtual), all KiB, plus the pid and the kernel's process name (cut to 15 characters). Reads the file directly, never the bridge, so a busy or hung engine still answers. " +
        "Fails, never reports zeros, when this session knows no engine PID for the instance (not launched or attached here, or killed since), the process has exited, or the file is unreadable or lacks those fields (no /proc, a zombie), or the process name isn't the engine executable's (a server outside the engine's PID namespace sees another process at that PID).",
      inputSchema: { instance: instanceArg },
    },
    async ({ instance }) => {
      const pid = ctx.enginePidFor(instance);
      if (pid === undefined) {
        return fail(`No engine PID known for instance ${instance}: launch it with launch_instance or attach with attach_instance.`);
      }
      if (!ctx.io.alive(pid)) return fail(`Instance ${instance}'s engine (PID ${pid}) is not running.`);
      const file = procStatusPath(pid);
      let text: string;
      try {
        text = ctx.io.readTextSync(file);
      } catch (e) {
        return fail(`Can't read ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
      const mem = parseProcMemory(text);
      if ("missing" in mem) return fail(`${file} has no ${mem.missing.join("/")} line (a zombie or kernel thread has none).`);
      const name = procName(text);
      const mismatch = ctx.config.exe && procMismatch(pid, name, ctx.config.exe);
      if (mismatch) return fail(mismatch);
      return {
        content: [{ type: "text", text: `PID ${pid} (${name ?? "?"}): VmRSS ${mem.vmRssKib} KiB, VmHWM ${mem.vmHwmKib} KiB, VmSize ${mem.vmSizeKib} KiB` }],
        structuredContent: { pid, name, ...mem },
      };
    },
  );

  // --- scenarios ----------------------------------------------------------------
  // Image tools last, beside the screenshot_file aside.
  const refusedFor = (why: string) => tools.refused().filter((n) => tools.refusal(n) === why);
  const refused = [...refusedFor(SCENARIO_REFUSALS.lifecycle), ...refusedFor(SCENARIO_REFUSALS.image)].join(", ");
  registerLive(
    "run_scenario",
    {
      scenario: SCENARIO_REFUSALS.nested,
      title: "Run a batch of tool calls in one reply",
      description:
        `Run up to ${MAX_STEPS} steps on one instance inside the server and return every result in one reply, instead of a round trip per call: setup bursts, summon waves, map-array sweeps, step-then-check loops. ` +
        `A step is {call, args}, any instance tool by name with its own args (the scenario's instance is used, so args carry none); {expect: condition}, which fails when the condition doesn't hold; or {repeat: [call and expect steps], until?: condition, maxIterations (up to ${MAX_ITERATIONS})}, which runs its body until the condition holds after a pass and fails if it never does (without until, exactly maxIterations passes). Conditions are step_until's; a log condition counts lines printed since the scenario began. E.g. {repeat: [{call: "step", args: {tics: 5}}], until: {kind: "actors", class: "DoomImp", flags: {alive: true}, op: "==", value: 0}, maxIterations: 40} runs until every imp is dead (without the alive flag a corpse still counts). ` +
        `Every call step's tool and args are checked against that tool's own schema (an unknown arg too) before anything runs, so a typo in a late step drives nothing; ${refused} (screenshot_file stands in for a frame) and tools without an instance are refused. Without sinceLine, a read_log step reads on from the last read_log (the first from where the scenario began), and a wait_for_log step waits for a line printed since the scenario began, not since launch. A wait_for_log that times out is not a failed step (its reply is no error); follow it with {expect: {kind: "log", ...}} when the run should stop there. ` +
        `onFail stop (default) ends the run at the first failed step (an error reply, an unmet expect or until); continue runs the rest. A thrown error, a client cancel, ${MAX_CALLS} calls in all, or maxSeconds of wall clock end it either way, and a run that ended at a failure is an error reply. These are checked between calls, so one long call (wait_for_log, step_until, watch_actors, input_timeline) can run past maxSeconds by its own timeout. ` +
        `The reply is structured: ok, failedAt (the first failure), calls, maptimeStart and maptimeEnd (the map tic counter around the run: count elapsed tics by these, since a step's tics are asked for, not measured, and an engine's step can run short; a map loaded mid-run restarts the counter, and a note says so when it ends below where it began), and per step its index, ok, text (cut at ${STEP_TEXT_CHARS} chars) and structured result (arrays cut to ${STEP_ROWS} rows, fewer until it fits ${STEP_JSON_CHARS} chars, with omitted counts and a hint to call that tool on its own); a repeat keeps its last pass's results and its iteration count. Past ${REPLY_CHARS} chars of step results, later steps keep only their kind and ok, and a failed one its text's first line, cut at ${SUMMARY_CHARS} chars.`,
      inputSchema: { instance: instanceArg, ...scenarioShape(conditionArg) },
    },
    async ({ instance, steps, onFail, maxSeconds }, extra) => {
      const shape = (call: string) => tools.shape(call);
      const refusalOf = (call: string) => tools.refusal(call);
      // Before the attach, so a refused scenario leaves a pending instance alone.
      const refusal = scenarioRefusal({ shape, refusal: refusalOf }, { instance, steps, onFail, maxSeconds });
      if (refusal) return fail(refusal);
      const client = await ctx.clientFor(instance);
      const start = logMark(instance);
      const log = logSince(instance, start);
      // One heartbeat for the whole run: inner tools reporting on the same token would send it backwards.
      const inner = { ...extra, _meta: { ...extra._meta, progressToken: undefined } };
      const port: ScenarioPort<Condition> = {
        shape,
        refusal: refusalOf,
        invoke: (call, args) => tools.invoke(call, args, inner),
        evalCondition: (c) => checkCondition(client, c, log),
        maptime: async () => {
          await client.refreshStatus();
          const t = Number(client.lastStatus?.maptime);
          return Number.isNaN(t) ? undefined : t;
        },
        logStart: start,
        signal: extra.signal,
        now: () => Date.now(),
      };
      const out = await withProgress(extra, maxSeconds * 1000, "running scenario", () =>
        runScenario(port, { instance, steps, onFail, maxSeconds }),
      );
      return {
        ...(out.halted && { isError: true }),
        content: [{ type: "text", text: describeScenario(out.result) }],
        structuredContent: { ...out.result },
      };
    },
  );
}
