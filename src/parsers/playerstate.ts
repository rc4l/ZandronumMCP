import type { EngineStatus } from "./status.js";

export interface PlayerState {
  x: number;
  y: number;
  z: number;
  angle: number;
  floorHeight: number;
  sector: number;
  light: number;
  /** From the engine-state snapshot riding `currentpos`'s own sentinel.
   *  Absent on a bridge without the `status` cap. */
  health?: number;
  armor?: number;
  player?: "alive" | "dead" | "none";
  spectating?: boolean;
}

export interface TargetInfo {
  target: string;
  health: number;
  spawnHealth: number;
}

/**
 * Merge the health/armor/liveness fields from an `mcp_status` snapshot into a
 * parsed `currentpos` result. A no-op (returns `state` unchanged) when
 * `status` is `undefined` — a bridge with no `status` cap never populates
 * `lastStatus`, so this is exactly how a legacy bridge stays fieldless here.
 */
export function withLiveStatus(state: PlayerState, status: EngineStatus | undefined): PlayerState {
  if (!status) return state;
  const merged: PlayerState = { ...state };
  if (status.health !== undefined) merged.health = Number(status.health);
  if (status.armor !== undefined) merged.armor = Number(status.armor);
  if (status.player === "alive" || status.player === "dead" || status.player === "none") {
    merged.player = status.player;
  }
  if (status.spectating !== undefined) merged.spectating = status.spectating === "1";
  return merged;
}

// Zandronum prints one "lightlevel"; UZDoom prints "sector lightlevel" then "actor lightlevel".
// `light` is the sector value in both; the actor value isn't surfaced.
const POS_RE =
  /Current player position: \((-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\), angle: (-?[\d.]+), floorheight: (-?[\d.]+), sector:(\d+), (?:sector )?lightlevel: (-?\d+)/;

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

// Zandronum prints "Target=<class>"; UZDoom's C_PrintInfo prints "Class=<class>" (after
// "Player=<name>, " for a player target).
const TARGET_RE = /(?:Target|Class)=([^,]+), Health=(-?\d+), Spawnhealth=(-?\d+)/;

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
