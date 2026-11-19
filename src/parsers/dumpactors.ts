import type { ActorClassInfo } from "../types.js";

/**
 * Parse the output of the `dumpactors` console command into structured records.
 *
 * Real format (captured, see test/fixtures/zandronum/dumpactors.golden.txt):
 *   - a leading count line: "1772 object class types total"
 *   - a tab-separated header: "Actor\tEd Num\tSpawnID\tFilter\tSource"
 *   - a blank line between every entry
 *   - data rows, tab-separated:
 *       "ArtiBoostArmor\t8041\t22\t4:Hexen\tzandronum.pk3:actors/hexen/boostarmor.txt"
 *   - UZDoom only: non-actor classes with "n/a" in every numeric column
 *
 * We keep only rows whose second column is an integer ed-num, which naturally
 * drops the count line (one column), the header ("Ed Num" isn't numeric) and "n/a" rows.
 */
export function parseDumpActors(lines: string[]): ActorClassInfo[] {
  const actors: ActorClassInfo[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      if (line.length === 0) continue;
      const cols = line.split("\t");
      if (cols.length < 5) continue; // count line / malformed
      if (!/^-?\d+$/.test(cols[1])) continue; // header row ("Ed Num") / "n/a"
      actors.push({
        name: cols[0],
        edNum: Number.parseInt(cols[1], 10),
        spawnId: Number.parseInt(cols[2], 10),
        filter: cols[3],
        source: cols.slice(4).join("\t"),
      });
    }
  }
  return actors;
}
