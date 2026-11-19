import { stripColor, type KvRecord } from "./lines.js";

/** A bot `add_bot` added; TID 0 when none is assigned (yet). */
export interface JoinedBot {
  slot: number;
  name: string;
  tid: number;
  spectator: boolean;
}

/** The new bots (slot not in `before`) that have joined, with a body (`tid=` is printed only then) or as a spectator (`spec=1`). */
export function joinedBots(before: ReadonlySet<number>, players: KvRecord[]): JoinedBot[] {
  return players
    .filter((p) => p.bot === 1 && !before.has(Number(p.slot)) && (p.tid !== undefined || p.spec === 1))
    .map((p) => ({
      slot: Number(p.slot),
      name: stripColor(String(p.name ?? "")),
      tid: Number(p.tid ?? 0),
      spectator: p.spec === 1,
    }));
}

/** Whether every joined bot that plays (not a spectator) has a TID. */
export function allHaveTid(bots: JoinedBot[]): boolean {
  return bots.every((b) => b.spectator || b.tid !== 0);
}

/** A joined bot's identity across reads. */
export function botKey(b: Pick<JoinedBot, "slot" | "name">): string {
  return `${b.slot} ${b.name}`;
}

/** A bot seen joined that a level change then removed. */
export interface LostBot {
  slot: number;
  name: string;
  reason: "level_change";
}

/** What add_bot saw, for its reply. */
export interface AddBotRun {
  /** The last read's joined bots. */
  bots: JoinedBot[];
  /** Every bot seen joined, with the level-change count at its last sighting. */
  seen: Iterable<{ bot: JoinedBot; changes: number }>;
  levelChanges: number;
  count: number;
  tidTics: number;
  tics: number;
  /** What addbot printed. */
  said: string;
  /** Iteration-cap notes. */
  capped: string[];
}

/** add_bot's reply: its error when no bot is left, else its lines, notes and the bots lost to a level change. */
export function addBotReport(r: AddBotRun): { error: string } | { lines: string[]; notes: string[]; lost: LostBot[] } {
  const left = new Set(r.bots.map(botKey));
  const lost = [...r.seen]
    .filter((s) => !left.has(botKey(s.bot)) && s.changes < r.levelChanges)
    .map(({ bot: { slot, name } }): LostBot => ({ slot, name, reason: "level_change" }));
  const lostLines = lost.map((l) => `${l.name} joined at slot ${l.slot}, then a level change removed it (${l.reason})`);
  if (r.bots.length === 0) {
    const none = lost.length === 0 ? `no bot joined within ${r.tics} tic(s)` : `none left in the game after ${r.tics} tic(s)`;
    return { error: [...lostLines, `${none}; addbot said: ${r.said}`, ...r.capped].join("\n") };
  }
  const noTid = `: none assigned within ${r.tidTics} tic(s)`;
  const lines = r.bots.map((b) => {
    const at = `${b.name} joined at slot ${b.slot}`;
    if (b.spectator) return `${at} as a spectator (join queue)`;
    return `${at}, tid ${b.tid}${b.tid === 0 && r.tidTics > 0 ? noTid : ""}`;
  });
  const joined = r.bots.length + lost.length;
  const partial = joined < r.count ? [`only ${joined} of ${r.count} joined; addbot said: ${r.said}`] : [];
  const notes = [...lines.filter((l) => l.endsWith(noTid)), ...partial, ...r.capped];
  return { lines: [...lines, ...lostLines, ...partial, ...r.capped], notes, lost };
}
