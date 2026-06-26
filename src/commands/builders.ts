// Console command builders. The game console takes a single string and splits
// on ';', with no arg-array API, so we sanitize here: string tokens that could
// smuggle extra commands (containing ';', quotes, or newlines) are rejected.
//
// `command()` is the shared builder — add new commands as one-liners over it.
// `safeToken` / `intToken` / `nonNegative` are the single source of validation;
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

function nonNegative(n: number): number {
  if (!Number.isInteger(n) || n < 0) {
    throw new UnsafeArgumentError(`Expected a non-negative integer, got ${n}`);
  }
  return n;
}

/** Join a verb and tokens into one validated console command string. */
export function command(verb: string, ...tokens: (string | number)[]): string {
  const parts = tokens.map((t) => (typeof t === "number" ? intToken(t) : safeToken(t)));
  return [verb, ...parts].join(" ");
}

export function buildSave(name: string, description?: string): string {
  // The description may contain spaces, so it is quoted; safeToken still rejects
  // an embedded quote/semicolon/newline so it can't smuggle a second command.
  const parts = ["save", safeToken(name)];
  if (description !== undefined) parts.push(`"${safeToken(description)}"`);
  return parts.join(" ");
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
