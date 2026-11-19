import { describe, it, expect } from "vitest";
import { parseRecStatus, parseRecArmed, parseRecWrote, parseRecFile, failedRecVar } from "../src/parsers/rec.js";

describe("parseRecStatus", () => {
  it("reads the status line among the other MCP_REC replies", () => {
    const lines = [
      "MCP_REC idle",
      "MCP_REC active=1 ran=12 tics=35 rows=40 dropped=0 tracked=3 untracked=1 maptime=424 reason=-",
    ];
    expect(parseRecStatus(lines)).toEqual({
      active: true, ran: 12, tics: 35, rows: 40, dropped: 0, tracked: 3, untracked: 1, maptime: 424, reason: "-",
    });
    expect(parseRecStatus(["MCP_REC active=0 ran=35 tics=35 rows=0 dropped=0 tracked=0 untracked=0 maptime=1 reason=done"]))
      .toMatchObject({ active: false, reason: "done" });
  });

  it("is undefined without one", () => {
    expect(parseRecStatus(["MCP_REC stopped ran=3", "Unknown command \"mcp_rec\""])).toBeUndefined();
  });
});

describe("failedRecVar", () => {
  it("counts the var lines before the first error, none without one", () => {
    expect(failedRecVar(["MCP_REC cleared", "MCP_REC var n=1", "MCP_REC var n=2", "error mapslot no match", "MCP_REC var n=3"])).toBe(2);
    expect(failedRecVar(["MCP_REC cleared", "error bad setup"])).toBe(0);
    expect(failedRecVar(["MCP_REC var n=1"])).toBeUndefined();
  });
});

describe("parseRecArmed and parseRecWrote", () => {
  it("read go's and dump's lines", () => {
    expect(parseRecArmed(["MCP_REC cleared", "MCP_REC watch n=1", "MCP_REC armed watches=1 tracked=2 tics=35 maptime=412"])).toEqual({
      watches: 1, tracked: 2, vars: 0, tics: 35, maptime: 412,
    });
    expect(parseRecWrote(["MCP_REC wrote rows=96 dropped=4"])).toEqual({ rows: 96, dropped: 4 });
    expect(parseRecArmed(["MCP_REC armed watches=0 tracked=0 vars=2 tics=35 maptime=412"])).toMatchObject({ vars: 2 });
  });

  it("are undefined on a refusal", () => {
    expect(parseRecArmed(["MCP_REC cleared", "error unknown class NoSuchClass", "error bad setup: a line failed, mcp_rec clear first"])).toBeUndefined();
    expect(parseRecWrote(["error cannot write /tmp/x/mcp-rec-1-1.txt"])).toBeUndefined();
  });
});

describe("parseRecFile", () => {
  it("reads the header and every row, CRLF too, a name with spaces kept whole", () => {
    const text = [
      "MCP_RECFILE v=1 engine=zandronum map=MAP01 start=412 ran=35 rows=3 dropped=0 fields=tid,hp,x reason=done",
      "rec t=412 k=seen id=1 class=DoomImp tid=7 x=-800.0 y=700.0 z=0.0",
      "rec t=412 k=sample id=1 tid=7 hp=60 x=-800.0",
      "rec t=414 k=script_start serial=2 script=-1 module=OSACS act=player0 name=Round Start",
      "",
    ].join("\r\n");
    const rec = parseRecFile(text)!;
    expect(rec.header).toEqual({ map: "MAP01", start: 412, ran: 35, rows: 3, dropped: 0, fields: ["tid", "hp", "x"], reason: "done" });
    expect(rec.rows).toHaveLength(3);
    expect(rec.rows[1]).toEqual({ t: 412, k: "sample", id: 1, tid: 7, hp: 60, x: -800 });
    expect(rec.rows[2].name).toBe("Round Start");
  });

  it("expands a flags sample into names, as find_actors does", () => {
    const rows = parseRecFile(
      ["MCP_RECFILE v=1 map=MAP01 start=1 ran=1 rows=2 dropped=0 fields=flags reason=done", "rec t=1 k=sample id=1 flags=mso", "rec t=2 k=sample id=1 flags=-"].join("\n"),
    )!.rows;
    expect(rows.map((r) => r.flags)).toEqual(["monster,shootable,solid", ""]);
  });

  it("keeps player and var rows as kv, with cleared weapon state a string", () => {
    const rec = parseRecFile("MCP_RECFILE map=MAP01 start=1 ran=1 rows=2 dropped=0 reason=done\n" +
      "rec t=1 k=psprite id=1 layer=1000 wstate=none\nrec t=2 k=var var=1 value=2 prev=0 name=points[1].y")!;
    expect(rec.rows[0]).toEqual({ t: 1, k: "psprite", id: 1, layer: 1000, wstate: "none" });
    expect(rec.rows[1]).toEqual({ t: 2, k: "var", var: 1, value: 2, prev: 0, name: "points[1].y" });
  });

  it("reads no fields from fields=- or a header without the key", () => {
    expect(parseRecFile("MCP_RECFILE v=1 map=- start=0 ran=0 rows=0 dropped=0 fields=- reason=-\n")!.header.fields).toEqual([]);
    expect(parseRecFile("MCP_RECFILE v=1 map=- start=0 ran=0 rows=0 dropped=0 reason=-\n")!.header.fields).toEqual([]);
  });

  it("is undefined without the header", () => {
    expect(parseRecFile("rec t=1 k=sample id=1\n")).toBeUndefined();
  });
});
