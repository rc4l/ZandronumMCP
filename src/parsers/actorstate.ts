export interface DecorateState {
  sprite: string;
  frame: string;
  tics: number;
}

export interface InventoryItem {
  class: string;
  amount: number;
  maxAmount: number;
}

export interface ActorState {
  class: string | null;
  health: number | null;
  pos: { x: number; y: number; z: number } | null;
  angle: number | null;
  state: DecorateState | null;
  weapon: string | null;
  morphTics: number | null;
  inventory: InventoryItem[];
}

/** Parse `dumpactor` output into a structured actor snapshot. */
export function parseActorState(lines: string[]): ActorState {
  const out: ActorState = {
    class: null,
    health: null,
    pos: null,
    angle: null,
    state: null,
    weapon: null,
    morphTics: null,
    inventory: [],
  };
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      switch (f[0]) {
        case "class":
          out.class = f[1] ?? null;
          break;
        case "health":
          out.health = Number(f[1]);
          break;
        case "pos":
          out.pos = { x: Number(f[1]), y: Number(f[2]), z: Number(f[3]) };
          break;
        case "angle":
          out.angle = Number(f[1]);
          break;
        case "state":
          out.state = { sprite: f[1], frame: f[2], tics: Number(f[3]) };
          break;
        case "weapon":
          out.weapon = f[1] ?? null;
          break;
        case "morphtics":
          out.morphTics = Number(f[1]);
          break;
        case "item":
          out.inventory.push({ class: f[1], amount: Number(f[2]), maxAmount: Number(f[3]) });
          break;
      }
    }
  }
  return out;
}

export interface NearbyActor {
  class: string;
  health: number;
  x: number;
  y: number;
  sprite: string;
}

const NEAR_RE = /^near (\S+) (-?\d+) (-?[\d.]+) (-?[\d.]+) (\S+)$/;

/** Parse `actorsnear` output. */
export function parseActorsNear(lines: string[]): NearbyActor[] {
  const out: NearbyActor[] = [];
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(NEAR_RE);
      if (m) {
        out.push({
          class: m[1],
          health: Number(m[2]),
          x: Number(m[3]),
          y: Number(m[4]),
          sprite: m[5],
        });
      }
    }
  }
  return out;
}
