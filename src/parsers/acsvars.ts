export interface AcsVar {
  scope: "world" | "global";
  index: number;
  value: number;
}

const RE = /^acsvar (world|global) (\d+) = (-?\d+)$/;

/** Parse `getacsvar` / `dumpacsvars` output lines: `acsvar <scope> <index> = <value>`. */
export function parseAcsVars(lines: string[]): AcsVar[] {
  const out: AcsVar[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(RE);
      if (m) {
        out.push({ scope: m[1] as "world" | "global", index: Number(m[2]), value: Number(m[3]) });
      }
    }
  }
  return out;
}
