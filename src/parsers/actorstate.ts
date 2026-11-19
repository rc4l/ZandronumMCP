import { firstError, hasHeader, markerText, matchLines, parseKv, parseKvLines, type KvRecord } from "./lines.js";

export interface DecorateState {
  sprite: string;
  frame: string;
  tics: number;
  /** `<OwnerClass>.<index>`, the state's owner and its offset in that class's states. */
  id?: string;
  /** Nearest own label at or before the state: `Fire` at the label, `Fire+3` past it. */
  label?: string;
}

/** Bit names in bit order; an unnamed set bit reads `bit<N>`. */
export function bitNames(value: number, names: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < 32; i++) {
    if ((value >>> i) & 1) out.push(names[i] ?? `bit${i}`);
  }
  return out;
}

/** BT_* in d_event.h, identical in both engines up to BT_USER4; BT_RUN is UZDoom's. */
export const BUTTON_NAMES = [
  "attack", "use", "jump", "crouch", "turn180", "altattack", "reload", "zoom",
  "speed", "strafe", "moveright", "moveleft", "back", "forward", "right", "left",
  "lookup", "lookdown", "moveup", "movedown", "showscores", "user1", "user2", "user3",
  "user4", "run",
] as const;

/** WF_* in d_player.h; WF_USER1OK..WF_USER4OK are UZDoom's. */
export const WEAPON_FLAG_NAMES = [
  "weaponready", "weaponbobbing", "weaponreadyalt", "weaponswitchok", "disableswitch",
  "weaponreloadok", "weaponzoomok", "refireswitchok", "user1ok", "user2ok", "user3ok", "user4ok",
] as const;

/** One tic's usercmd: raw (`GetPlayerInput` INPUT_*) or after mods (MODINPUT_*). */
export interface InputCmd {
  buttons: string[];
  oldButtons: string[];
  forward: number;
  side: number;
  up: number;
  yaw: number;
  pitch: number;
  roll: number;
}

/** One active psprite layer; known GZDoom layer numbers are named. */
export interface Psprite {
  layer: "weapon" | "flash" | "strifehands" | number;
  sprite: string;
  frame: string;
  tics: number;
  x: number;
  y: number;
  id?: string;
  label?: string;
}

export interface PlayerWeaponState {
  input: InputCmd | null;
  modInput: InputCmd | null;
  refire: number | null;
  weaponFlags: string[];
  /** null: no change pending; "none": switching to no weapon; else the class. */
  pendingWeapon: string | null;
  psprites: Psprite[];
}

const LAYER_NAMES: Record<number, Psprite["layer"]> = { 1: "weapon", 1000: "flash", [-1]: "strifehands" };

/** Player-line keys holding names, kept strings even when numeric-looking. */
const NAME_KEYS = ["sprite", "frame", "id", "label", "pending"];

function parseInput(kv: KvRecord): InputCmd {
  return {
    buttons: bitNames(Number(kv.buttons), BUTTON_NAMES),
    oldButtons: bitNames(Number(kv.oldbuttons), BUTTON_NAMES),
    forward: Number(kv.forward),
    side: Number(kv.side),
    up: Number(kv.up),
    yaw: Number(kv.yaw),
    pitch: Number(kv.pitch),
    roll: Number(kv.roll),
  };
}

function parsePsprite(kv: KvRecord): Psprite {
  const layer = Number(kv.layer);
  const out: Psprite = {
    layer: LAYER_NAMES[layer] ?? layer,
    sprite: String(kv.sprite),
    frame: String(kv.frame),
    tics: Number(kv.tics),
    x: Number(kv.x),
    y: Number(kv.y),
  };
  if (kv.id !== undefined) out.id = String(kv.id);
  if (kv.label !== undefined) out.label = String(kv.label);
  return out;
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
  pitch: number | null;
  state: DecorateState | null;
  weapon: string | null;
  morphTics: number | null;
  inventory: InventoryItem[];
  /** Input, weapon and psprite state; null for a non-player. */
  player: PlayerWeaponState | null;
}

/** Parse `dumpactor` output into a structured actor snapshot. */
export function parseActorState(lines: string[]): ActorState {
  const out: ActorState = {
    class: null,
    health: null,
    pos: null,
    angle: null,
    pitch: null,
    state: null,
    weapon: null,
    morphTics: null,
    inventory: [],
    player: null,
  };
  const player = (): PlayerWeaponState =>
    (out.player ??= {
      input: null,
      modInput: null,
      refire: null,
      weaponFlags: [],
      pendingWeapon: null,
      psprites: [],
    });
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      const f = line.trim().split(/\s+/);
      const kv = () => parseKv(f.slice(1).join(" "), NAME_KEYS);
      switch (f[0]) {
        case "stateid":
          if (out.state && f[1]) {
            out.state.id = f[1];
            if (f[2]) out.state.label = f[2];
          }
          break;
        case "input":
          player().input = parseInput(kv());
          break;
        case "modinput":
          player().modInput = parseInput(kv());
          break;
        case "weaponinfo": {
          const w = kv();
          const p = player();
          p.refire = Number(w.refire);
          p.weaponFlags = bitNames(Number(w.flags), WEAPON_FLAG_NAMES);
          if (w.pending !== undefined) p.pendingWeapon = String(w.pending);
          break;
        }
        case "psprite":
          player().psprites.push(parsePsprite(kv()));
          break;
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
        case "pitch":
          out.pitch = Number(f[1]);
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

/** `findactors`' `flags=` letters; mirrors `MCP_FlagLetters` in mcp_actorstate.cpp. */
const FLAG_LETTERS: Record<string, string> = {
  m: "monster",
  f: "friendly",
  c: "corpse",
  d: "dormant",
  s: "shootable",
  o: "solid",
  i: "invulnerable",
  a: "ambush",
};

/** Every flag name a `findactors` row can carry. */
export const FLAG_NAMES = Object.values(FLAG_LETTERS);

/** `findactors`' default `limit`; mirrors the CCMD's in mcp_actorstate.cpp. */
export const FIND_ACTORS_LIMIT = 200;

export interface FoundActors {
  actors: KvRecord[];
  /** Set when `limit` cut the list short. */
  truncated?: { shown: number; total: number };
}

/** Expand a record's `flags=` letters into comma-joined names ("-" becomes ""). */
export function expandFlags(a: KvRecord): KvRecord {
  if (typeof a.flags !== "string") return a;
  const flags = [...a.flags].flatMap((c) => (FLAG_LETTERS[c] ? [FLAG_LETTERS[c]] : []));
  return { ...a, flags: flags.join(",") };
}

/** Parse `findactors` output, expanding `flags=` letters into names. */
export function parseFindActors(lines: string[]): FoundActors {
  const actors = parseKvLines(lines, "found").map(expandFlags);
  const truncated = matchLines(lines, /^truncated shown=(\d+) total=(\d+)$/, (m) => ({
    shown: Number(m[1]),
    total: Number(m[2]),
  }))[0];
  return truncated ? { actors, truncated } : { actors };
}

/** A `findactors` reply parsed, or undefined when it failed (an error line, or no `MCP_FOUND` header). */
export function parseFoundReply(lines: string[]): FoundActors | undefined {
  return firstError(lines) === undefined && hasHeader(lines, "MCP_FOUND") ? parseFindActors(lines) : undefined;
}

/** Whether an expanded row has a flag name, or the derived `alive` (hp > 0 and not a corpse). */
function hasFlag(a: KvRecord, name: string): boolean {
  const flags = String(a.flags ?? "").split(",");
  return name === "alive" ? Number(a.hp) > 0 && !flags.includes("corpse") : flags.includes(name);
}

/** The rows having (true) or lacking (false) every key in `want`, in distance order, cut to `limit`. */
export function filterFound(
  found: FoundActors,
  want: Record<string, boolean | undefined>,
  limit: number,
): FoundActors {
  const keys = Object.entries(want).filter(([, on]) => on !== undefined);
  const kept = found.actors.filter((a) => keys.every(([name, on]) => hasFlag(a, name) === on));
  if (kept.length <= limit) return { actors: kept };
  return { actors: kept.slice(0, limit), truncated: { shown: limit, total: kept.length } };
}

/** remove_actor's reply text from its `removed_total` and `removed` rows, and the refs it skipped. */
export function describeRemoved(total: KvRecord, removed: KvRecord[]): { text: string; skipped?: string[] } {
  const names = removed.map((r) => `${r.class}#${r.tid}${markerText(r, ["hidden"])}`);
  const text = `removed ${total.count}${names.length > 0 ? `: ${names.join(", ")}` : ""}`;
  if (total.skipped === undefined) return { text };
  const skipped = String(total.skipped).split(",");
  const bodies = skipped.filter((s) => /^player\d+$/.test(s));
  const items = skipped.filter((s) => !bodies.includes(s));
  const groups = [[bodies, "a live player's body"], [items, "owned inventory, which the engine keeps"]] as const;
  const why = groups.filter(([refs]) => refs.length > 0).map(([refs, reason]) => `${refs.join(", ")} (${reason})`).join("; ");
  return { text: `${text}; skipped ${why}`, skipped };
}
