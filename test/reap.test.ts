import { describe, it, expect } from "vitest";
import {
  parsePsPids,
  reapOrphanEngines,
  psCommand,
  listEnginePids,
  defaultIo,
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
});

describe("reapOrphanEngines", () => {
  const makeIo = (found: number[], stubborn: number[] = []): { io: ReapIo; killed: number[] } => {
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
});
