import { describe, it, expect } from "vitest";
import { netRole, joinAction, joinState } from "../src/netgame.js";
import type { NetgameCaps } from "../src/adapter.js";

const CAPS: NetgameCaps = {
  hostFlag: "-host",
  clientFlag: "-connect",
  joinCommand: "join",
  stepLeavesClientRunning: true,
  pauseNotes: { server: "server note", client: "client note" },
};

describe("netRole", () => {
  it("reads a server from the host flag and a client from the client flag, case-insensitively", () => {
    expect(netRole(["+sv_cheats", "1", "-HOST"], CAPS)).toEqual({ role: "server", note: "server note", leftRunning: false });
    expect(netRole(["-connect", "127.0.0.1", "+name", "a"], CAPS)).toEqual({
      role: "client",
      note: "client note",
      leftRunning: true,
    });
  });

  it("leaves a client paused after a step unless the caps say step leaves it running", () => {
    expect(netRole(["-connect", "127.0.0.1"], { ...CAPS, stepLeavesClientRunning: undefined })?.leftRunning).toBe(false);
  });

  it("is undefined offline, for an attached instance (no args) and without netgame caps", () => {
    expect(netRole(["+map", "MAP01"], CAPS)).toBeUndefined();
    expect(netRole([], CAPS)).toBeUndefined();
    expect(netRole(undefined, CAPS)).toBeUndefined();
    expect(netRole(["-host"], undefined)).toBeUndefined();
  });

  it("matches whole args only, so a value that contains a flag isn't a role", () => {
    expect(netRole(["+name", "-hostile"], CAPS)).toBeUndefined();
  });
});

describe("joinState", () => {
  const level = { gamestate: "level", player: "alive" };

  it("is connecting until the client is in a level with a player", () => {
    expect(joinState(undefined)).toBe("connecting");
    expect(joinState({ gamestate: "fullconsole", player: "alive", spectating: "1" })).toBe("connecting");
    expect(joinState({ gamestate: "level", player: "none", spectating: "0" })).toBe("connecting");
    expect(joinState({ gamestate: "level", spectating: "0" })).toBe("connecting");
  });

  it("is spectating until spectating=0, then joined", () => {
    expect(joinState({ ...level, spectating: "1" })).toBe("spectating");
    expect(joinState({ ...level, spectating: "0" })).toBe("joined");
    expect(joinState({ gamestate: "level", player: "dead", spectating: "0" })).toBe("joined");
  });
});

describe("joinAction", () => {
  it("sends once on spectating, resends once after half the budget, and starts over on connecting", () => {
    const rows: Array<[Parameters<typeof joinAction>, ReturnType<typeof joinAction>]> = [
      [["spectating", 0, 0, 1000], { send: true, sent: 1 }],
      [["spectating", 1, 400, 1000], { send: false, sent: 1 }],
      [["spectating", 1, 500, 1000], { send: true, sent: 2 }],
      [["spectating", 2, 900, 1000], { send: false, sent: 2 }],
      [["connecting", 2, 900, 1000], { send: false, sent: 0 }],
      [["joined", 1, 0, 1000], { send: false, sent: 1 }],
    ];
    for (const [args, want] of rows) expect(joinAction(...args), args.join(" ")).toEqual(want);
  });
});
