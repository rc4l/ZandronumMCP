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

export function buildRunAcs(object: string, ...tokens: (string | number)[]): string {
  // `object` comes from consolePath and may be quoted; its inside still gets the shared check.
  safeToken(object.replace(/^"(.*)"$/, "$1"));
  return ["mcp_runacs", object, ...tokens.map(token)].join(" ");
}

export function buildPuke(script: number, args: number[] = []): string {
  return command("puke", nonNegative(script), ...args);
}

export function buildPukeName(name: string, args: number[] = [], always = false): string {
  // The name is quoted, so it can't go through command()'s token check — we
  // validate it directly with the same shared helpers instead.
  const parts = ["pukename", `"${safeToken(name)}"`];
  if (always) parts.push("always");
  for (const a of args) parts.push(intToken(a));
  return parts.join(" ");
}
