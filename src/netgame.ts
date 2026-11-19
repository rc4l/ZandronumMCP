import type { NetgameCaps } from "./adapter.js";
import type { EngineStatus } from "./parsers/status.js";
import { hasArg } from "./process/launch.js";

export type NetRole = "server" | "client";

/** An instance's netgame role from its stored launch args, with that role's pause caveat. */
export interface NetInfo {
  role: NetRole;
  note: string;
  /** A step leaves this instance running instead of pausing it again (a client, on an engine whose caps say so). */
  leftRunning: boolean;
}

/** The role an instance was launched in, from its extraArgs; undefined offline, when attached or without netgame caps. */
export function netRole(extraArgs: readonly string[] | undefined, caps: NetgameCaps | undefined): NetInfo | undefined {
  if (!caps || !extraArgs) return undefined;
  if (hasArg(extraArgs, caps.hostFlag)) return { role: "server", note: caps.pauseNotes.server, leftRunning: false };
  if (hasArg(extraArgs, caps.clientFlag)) {
    return { role: "client", note: caps.pauseNotes.client, leftRunning: caps.stepLeavesClientRunning === true };
  }
  return undefined;
}

export type JoinState = "connecting" | "spectating" | "joined";

/** Where a client is on its way into the game, where fullconsole or `player=none` (after a disconnect) still counts as connecting. */
export function joinState(status: EngineStatus | undefined): JoinState {
  if (status?.gamestate !== "level" || status.player === undefined || status.player === "none") return "connecting";
  return status.spectating === "0" ? "joined" : "spectating";
}

/** Whether join_game sends `join` on this read, resetting the count on a reconnect (a server `map` drops any join sent). */
export function joinAction(state: JoinState, sent: number, waitedMs: number, budgetMs: number): { send: boolean; sent: number } {
  const before = state === "connecting" ? 0 : sent;
  const send = state === "spectating" && (before === 0 || (before === 1 && waitedMs >= budgetMs / 2));
  return { send, sent: send ? before + 1 : before };
}
