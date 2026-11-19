// Console command builders. The game console takes a single string and splits
// on ';', with no arg-array API, so we sanitize here: string tokens that could
// smuggle extra commands (containing ';', quotes, or newlines) are rejected.
//
// `command()` is the shared builder — add new commands as one-liners over it.
// `safeToken` / `intToken` / `realToken` / `nonNegative` are the single source of validation;
// don't reimplement them per command. (Domain rules like "amount >= 0" are also
// enforced at the tool schema layer in server.ts.)

const UNSAFE = /[;\r\n"]/;

export class UnsafeArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArgumentError";
  }
}

function safeToken(token: string): string {
  if (token.length === 0 || UNSAFE.test(token)) {
    throw new UnsafeArgumentError(`Unsafe console token: ${JSON.stringify(token)}`);
  }
  return token;
}

function intToken(n: number): string {
  if (!Number.isInteger(n)) {
    throw new UnsafeArgumentError(`Expected an integer, got ${n}`);
  }
  return String(n);
}

/** A fractional number as a token, for the CCMDs that take one. */
export function realToken(n: number): string {
  if (!Number.isFinite(n)) {
    throw new UnsafeArgumentError(`Expected a finite number, got ${n}`);
  }
  return String(n);
}

function nonNegative(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new UnsafeArgumentError(`Expected a non-negative integer, got ${n}`);
  }
  return n;
}

function token(t: string | number): string {
  return typeof t === "number" ? intToken(t) : safeToken(t);
}

/** Whether a token reaches a CCMD as typed, free of `$cvar` substitution and the split on bytes >= 0x80,
 *  which `command()` leaves unchecked since stock commands may want both. */
export function isPlainToken(t: string): boolean {
  return !t.startsWith("$") && /^[\x21-\x7e]+$/.test(t);
}

/** Join a verb and tokens into one validated console command string. */
export function command(verb: string, ...tokens: (string | number)[]): string {
  return [verb, ...tokens.map(token)].join(" ");
}

/** `key=value` tokens for a CCMD's optional named args, in order; undefined skips one. */
export function kvArgs(pairs: Record<string, string | number | undefined>): string[] {
  return Object.entries(pairs).flatMap(([k, v]) =>
    v === undefined ? [] : [`${k}=${typeof v === "number" ? realToken(v) : v}`],
  );
}

export function buildSave(name: string, description?: string): string {
  // The description may contain spaces, so it is quoted; safeToken still rejects
  // an embedded quote/semicolon/newline so it can't smuggle a second command.
  const parts = ["save", safeToken(name)];
  if (description !== undefined) parts.push(`"${safeToken(description)}"`);
  return parts.join(" ");
}

/** `mcp_runacs <object> [script] [args...] [name=1] [open=1]`; with `markName`, `name=1` keeps a digit-only script name from reading as a number. */
export function buildRunAcs(object: string, script?: number | string, args: number[] = [], open = false, markName = false): string {
  const named = markName && typeof script === "string" ? ["name=1"] : [];
  const run = script === undefined ? [] : [script, ...args, ...named];
  return ["mcp_runacs", pathToken(object), ...[...run, ...(open ? ["open=1"] : [])].map(token)].join(" ");
}

/** `mcp_rec dump <path>`, the path a consolePath token. */
export function buildRecDump(path: string): string {
  return `mcp_rec dump ${pathToken(path)}`;
}

/** A consolePath token, which may be quoted; its inside still gets the shared check. */
function pathToken(t: string): string {
  safeToken(t.replace(/^"(.*)"$/, "$1"));
  return t;
}

/** `puke <script> [args...]`; puke's own form of "always" is the negated script number. */
export function buildPuke(script: number, args: number[] = [], always = false): string {
  const n = nonNegative(script);
  return command("puke", always ? -n : n, ...args);
}

/** A verb, a quoted script name (the console hands the CCMD one unquoted argv), flags, int args. */
function namedScript(verb: string, name: string, flags: string[], args: number[]): string {
  // The name is quoted, so it can't go through command()'s token check — we
  // validate it directly with the same shared helpers instead.
  return [verb, `"${safeToken(name)}"`, ...flags, ...args.map(intToken)].join(" ");
}

export function buildPukeName(name: string, args: number[] = [], always = false): string {
  return namedScript("pukename", name, always ? ["always"] : [], args);
}

/** `mcp_runscript <script> [name=1] [always=1] [args...]`; `name=1` keeps a digit-only script name from reading as a number. */
export function buildRunScript(script: number | string, args: number[] = [], always = false): string {
  const flags = always ? ["always=1"] : [];
  return typeof script === "number"
    ? command("mcp_runscript", script, ...flags, ...args)
    : namedScript("mcp_runscript", script, ["name=1", ...flags], args);
}

/** `addbot ["<name>"]`; quoted, since a bot name can hold spaces. */
export function buildAddBot(name?: string): string {
  return name === undefined ? "addbot" : namedScript("addbot", name, [], []);
}

/** An actor or point reference as a tool passes it: exactly one form is set (the schema checks). */
export interface RefArg {
  tid?: number;
  index?: number;
  player?: number;
  class?: string;
  x?: number;
  y?: number;
  z?: number;
}

/** The map-probe CCMDs' reference token: `tid:N[:index]`, `player:N`, `class:Name` or `pt:x,y[,z]`. */
export function refToken(ref: RefArg): string {
  if (ref.tid !== undefined) {
    const index = ref.index !== undefined ? `:${intToken(ref.index)}` : "";
    return `tid:${intToken(ref.tid)}${index}`;
  }
  if (ref.player !== undefined) return `player:${intToken(ref.player)}`;
  if (ref.class !== undefined) return `class:${safeToken(ref.class)}`;
  return `pt:${[ref.x, ref.y, ref.z].filter((v) => v !== undefined).map(realToken).join(",")}`;
}
