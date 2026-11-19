// `set_actor_prop`'s property table, mirroring `MCP_PROPS` in engine-bridge/overlay/mcp_actorstate.cpp;
// the engine stays the authority, so this only rejects what can't be sent as console tokens.

import { isPlainToken } from "./commands/builders.js";

/** n = number, i = integer, b = boolean, s = one-token string, t = free text. */
export type PropType = "n" | "i" | "b" | "s" | "t";

export const PROPS: Record<string, PropType> = {
  speed: "n",
  gravity: "n",
  friction: "n",
  meleerange: "n",
  maxstepheight: "n",
  maxdropoffheight: "n",
  damagefactor: "n",
  damagemultiply: "n",
  alpha: "n",
  scalex: "n",
  scaley: "n",
  scale: "n",
  mass: "i",
  score: "i",
  accuracy: "i",
  stamina: "i",
  reactiontime: "i",
  friendlyseeblocks: "i",
  damage: "i",
  health: "i",
  height: "n",
  radius: "n",
  renderstyle: "s",
  friendly: "b",
  dormant: "b",
  nametag: "t",
  species: "s",
  damagetype: "s",
};

export const PROP_NAMES = Object.keys(PROPS) as [string, ...string[]];

/** Props whose write may skip the position test with `force`. */
export const FORCEABLE_PROPS = new Set(["height", "radius"]);

export const FLAG_PROP = /^flag:[A-Za-z0-9_.]+$/;

export function isFlagProp(prop: string): boolean {
  return FLAG_PROP.test(prop);
}

export class PropValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PropValueError";
  }
}

/** A prop value's console tokens, with numbers as strings since `command()` sends a number as an integer token and throws on 0.5. */
export function encodePropValue(prop: string, value: string | number | boolean | undefined): string[] {
  if (value === undefined) return [];
  const type: PropType = isFlagProp(prop) ? "b" : PROPS[prop];
  const bad = () => new PropValueError(`bad value ${JSON.stringify(value)} for ${prop}`);
  let tokens: string[];
  switch (type) {
    case "n":
      if (typeof value !== "number" || !Number.isFinite(value)) throw bad();
      tokens = [String(value)];
      break;
    case "i":
      if (typeof value !== "number" || !Number.isInteger(value)) throw bad();
      tokens = [String(value)];
      break;
    case "b":
      if (typeof value === "boolean") tokens = [value ? "1" : "0"];
      else if (value === 0 || value === 1) tokens = [String(value)];
      else throw bad();
      break;
    default:
      if (typeof value !== "string" || value.trim() === "") throw bad();
      tokens = value.trim().split(/\s+/);
      if (type === "s" && tokens.length > 1) throw bad();
  }
  if (!tokens.every(isPlainToken)) throw bad();
  return tokens;
}
