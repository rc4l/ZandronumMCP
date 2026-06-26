export interface PlayerState {
  x: number;
  y: number;
  z: number;
  angle: number;
  floorHeight: number;
  sector: number;
  light: number;
}

export interface TargetInfo {
  target: string;
  health: number;
  spawnHealth: number;
}

const POS_RE =
  /Current player position: \((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\), angle: (-?[\d.]+), floorheight: (-?[\d.]+), sector:(\d+), lightlevel: (-?\d+)/;

/** Parse `currentpos` output. */
export function parsePlayerState(lines: string[]): PlayerState | null {
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(POS_RE);
      if (m) {
        return {
          x: Number(m[1]),
          y: Number(m[2]),
          z: Number(m[3]),
          angle: Number(m[4]),
          floorHeight: Number(m[5]),
          sector: Number(m[6]),
          light: Number(m[7]),
        };
      }
    }
  }
  return null;
}

const TARGET_RE = /Target=([^,]+), Health=(-?\d+), Spawnhealth=(-?\d+)/;

/** Parse `linetarget` output (the actor the player is aiming at). */
export function parseTarget(lines: string[]): TargetInfo | null {
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(TARGET_RE);
      if (m) {
        return { target: m[1], health: Number(m[2]), spawnHealth: Number(m[3]) };
      }
    }
  }
  return null;
}
