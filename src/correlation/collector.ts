export interface CollectResult {
  output: string[];
  complete: boolean;
}

/**
 * Pure correlation: given the console lines seen so far and the sentinel that
 * marks end-of-command, return everything before the sentinel and whether the
 * command has completed. Anything at/after the sentinel is excluded.
 */
export function collectUntilSentinel(lines: string[], sentinel: string): CollectResult {
  const output: string[] = [];
  for (const line of lines) {
    if (line.includes(sentinel)) {
      return { output, complete: true };
    }
    output.push(line);
  }
  return { output, complete: false };
}
