const SENTINEL_PREFIX = "__MCPDONE_";
const SENTINEL_SUFFIX = "__";

/** Build a unique end-of-command marker for the given request id. */
export function makeSentinel(id: string): string {
  return `${SENTINEL_PREFIX}${id}${SENTINEL_SUFFIX}`;
}

/**
 * Wrap a console command so the engine echoes a unique marker when it finishes.
 * The bridge stays dumb: it just runs the string; correlation is entirely here.
 */
export function withSentinel(command: string, sentinel: string): string {
  return `${command} ; echo ${sentinel}`;
}

export function lineContainsSentinel(line: string, sentinel: string): boolean {
  return line.includes(sentinel);
}
