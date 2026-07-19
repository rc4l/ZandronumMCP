import { describe, it, expect } from "vitest";
import {
  parsePsPids,
  reapOrphanEngines,
  psCommand,
  listEnginePids,
  defaultIo,
  parsePpid,
  readPpid,
  type ReapIo,
} from "../src/process/reap.js";

describe("parsePsPids", () => {
  const ps = [
    "  501 /Apps/zandronum-mcp-hooks -iwad freedoom2.wad",
    "  502 /usr/bin/node /some/mcp/server.js",
    "  503 /Apps/zandronum-mcp-hooks -iwad doom2.wad -file x.pk3",
    "",
  ].join("\n");

  it("returns pids whose command line contains the needle", () => {
    expect(parsePsPids(ps, "zandronum-mcp-hooks")).toEqual([501, 503]);
  });

  it("returns nothing when the needle is absent", () => {
    expect(parsePsPids(ps, "gzdoom")).toEqual([]);
  });

  it("never returns the MCP server's own pid", () => {
    const line = `${process.pid} /Apps/zandronum-mcp-hooks -iwad x`;
    expect(parsePsPids(line, "zandronum-mcp-hooks")).toEqual([]);
  });
});

describe("psCommand", () => {
  it("uses wmic on Windows and ps elsewhere", () => {
    expect(psCommand("win32").cmd).toBe("wmic");
    expect(psCommand("linux").cmd).toBe("ps");
    expect(psCommand("darwin").cmd).toBe("ps");
  });
});

describe("listEnginePids", () => {
  const psOut = "  501 /Apps/zandronum-mcp-hooks -iwad x\n  502 /usr/bin/node\n";

  it("parses pids from the process listing", () => {
    const pids = listEnginePids("zandronum-mcp-hooks", "darwin", () => psOut);
    expect(pids).toEqual([501]);
  });

  it("returns [] when the listing command throws", () => {
    const pids = listEnginePids("zandronum-mcp-hooks", "linux", () => {
      throw new Error("ps not found");
    });
    expect(pids).toEqual([]);
  });
});

describe("defaultIo (real process glue)", () => {
  it("list returns an array against the real process table", () => {
    expect(Array.isArray(defaultIo.list("this-needle-matches-nothing-xyz"))).toBe(true);
  });

  it("alive is true for this process and false for a bogus pid", () => {
    expect(defaultIo.alive(process.pid)).toBe(true);
    expect(defaultIo.alive(2 ** 30)).toBe(false);
  });

  it("kill never throws for a pid that isn't there", () => {
    expect(() => defaultIo.kill(2 ** 30)).not.toThrow();
  });

  it("sleep resolves", async () => {
    await expect(defaultIo.sleep(1)).resolves.toBeUndefined();
  });

  it("ppidOf reads a real parent pid (or undefined) without throwing", () => {
    expect(() => defaultIo.ppidOf(process.pid)).not.toThrow();
    const ppid = defaultIo.ppidOf(process.pid);
    expect(ppid === undefined || Number.isInteger(ppid)).toBe(true);
  });
});

describe("reapOrphanEngines", () => {
  const makeIo = (
    found: number[],
    stubborn: number[] = [],
    // pid -> parent pid. 1 = orphan (launcher gone); anything else = owned by a
    // live session; undefined = unreadable.
    ppids: Record<number, number | undefined> = {},
  ): { io: ReapIo; killed: number[] } => {
    const alive = new Set(found);
    const killed: number[] = [];
    const io: ReapIo = {
      list: () => found,
      kill: (pid) => {
        killed.push(pid);
        if (!stubborn.includes(pid)) alive.delete(pid); // stubborn = wedged, survives
      },
      alive: (pid) => alive.has(pid),
      sleep: async () => {},
      ppidOf: (pid) => (pid in ppids ? ppids[pid] : 1),
    };
    return { io, killed };
  };

  it("kills every engine it finds and reports them reaped", async () => {
    const { io, killed } = makeIo([11, 22, 33]);
    const r = await reapOrphanEngines("/Apps/zandronum-mcp-hooks", io);
    expect(killed).toEqual([11, 22, 33]);
    expect(r.killed).toEqual([11, 22, 33]);
    expect(r.survivors).toEqual([]);
  });

  it("reports processes that survive SIGKILL as wedged survivors", async () => {
    const { io } = makeIo([11, 22], [22]); // 22 is wedged
    const r = await reapOrphanEngines("/Apps/zandronum-mcp-hooks", io);
    expect(r.killed).toEqual([11]);
    expect(r.survivors).toEqual([22]);
  });

  it("is a clean no-op when there are no engines", async () => {
    const { io, killed } = makeIo([]);
    const r = await reapOrphanEngines("/Apps/zandronum-mcp-hooks", io);
    expect(killed).toEqual([]);
    expect(r).toEqual({ found: [], killed: [], survivors: [] });
  });

  it("onlyOrphans reaps just the orphans and spares another session's engines", async () => {
    // 11 orphaned (PPID 1), 22 owned by a live MCP server (PPID 4242).
    const { io, killed } = makeIo([11, 22], [], { 11: 1, 22: 4242 });
    const r = await reapOrphanEngines("/Apps/zandronum-mcp-hooks", io, { onlyOrphans: true });
    expect(killed).toEqual([11]);
    expect(r.found).toEqual([11]);
    expect(r.killed).toEqual([11]);
  });

  it("onlyOrphans never kills an engine whose PPID can't be read", async () => {
    const { io, killed } = makeIo([11], [], { 11: undefined });
    const r = await reapOrphanEngines("/Apps/zandronum-mcp-hooks", io, { onlyOrphans: true });
    expect(killed).toEqual([]);
    expect(r).toEqual({ found: [], killed: [], survivors: [] });
  });

  it("onlyOrphans still reports a wedged orphan as a survivor", async () => {
    const { io } = makeIo([11], [11], { 11: 1 }); // orphan, but unkillable
    const r = await reapOrphanEngines("/Apps/zandronum-mcp-hooks", io, { onlyOrphans: true });
    expect(r.killed).toEqual([]);
    expect(r.survivors).toEqual([11]);
  });
});

describe("parsePpid", () => {
  it("parses ps output", () => {
    expect(parsePpid("    1\n")).toBe(1);
    expect(parsePpid(" 4242 ")).toBe(4242);
  });
  it("returns undefined for junk or empty output", () => {
    expect(parsePpid("")).toBeUndefined();
    expect(parsePpid("nope")).toBeUndefined();
  });
});

describe("readPpid", () => {
  it("returns undefined on Windows (no reparent-to-1 signal)", () => {
    expect(readPpid(123, "win32", () => "1")).toBeUndefined();
  });
  it("reads the parent pid via ps on POSIX", () => {
    expect(readPpid(123, "darwin", () => "  1\n")).toBe(1);
  });
  it("returns undefined when ps fails", () => {
    expect(
      readPpid(123, "darwin", () => {
        throw new Error("no such process");
      }),
    ).toBeUndefined();
  });
  it("exercises the real default runner without throwing", () => {
    expect(() => readPpid(process.pid)).not.toThrow();
  });
});
