import { describe, it, expect } from "vitest";
import {
  groupVarsBySource,
  recordProblem,
  recordSchedule,
  actorSummaries,
  scriptSummaries,
  varSummaries,
  capRows,
  recordResult,
  recordNotes,
  describeRecord,
  REC_FIELDS,
  PLAYER_REC_FIELDS,
  expandFields,
  needsPlayerCap,
  DEFAULT_REC_FIELDS,
  DEFAULT_REC_EVENTS,
  SUMMARY_CAP,
  EVENT_LINES,
  type RecordOptions,
} from "../src/recorder/record.js";
import { recDumpFiles, REC_KEEP } from "../src/recorder/files.js";
import { parseRecFile, type RecFile } from "../src/parsers/rec.js";
import type { KvRecord } from "../src/parsers/lines.js";
import { norm } from "./fakes/paths.js";

const opts = (o: Partial<RecordOptions> = {}): RecordOptions => ({
  watch: [{ player: 0 }],
  fields: DEFAULT_REC_FIELDS,
  events: DEFAULT_REC_EVENTS,
  tics: 35,
  run: true,
  everyTics: 1,
  onChange: true,
  ...o,
});

/** A recording file as the engine dumps it. */
function file(rows: string[], head: Partial<Record<string, string | number>> = {}): RecFile {
  const h = { map: "MAP01", start: 412, ran: 35, rows: rows.length, dropped: 0, fields: "tid,hp,x", reason: "done", ...head };
  const header = `MCP_RECFILE v=1 engine=zandronum ${Object.entries(h).map(([k, v]) => `${k}=${v}`).join(" ")}`;
  return parseRecFile([header, ...rows].join("\n"))!;
}

// The plan's example recording: an imp shot by a rocket, and two scripts.
const FIGHT = [
  "rec t=412 k=seen id=1 class=DoomImp tid=7 x=-800.0 y=700.0 z=0.0",
  "rec t=412 k=sample id=1 tid=7 hp=60 x=-800.0",
  "rec t=412 k=spawn id=2 class=Rocket tid=0 x=-790.0 y=640.0 z=32.0",
  "rec t=413 k=sample id=2 tid=0 hp=1000 x=-795.0",
  "rec t=414 k=damage id=1 amount=92 type=None src=player0 inf=Rocket#0 infid=2 hp=-32",
  "rec t=414 k=death id=1 src=player0 inf=Rocket#0 hp=-32",
  "rec t=414 k=state id=1 state=DoomImp.20 label=Death sprite=TROO frame=I tics=8",
  "rec t=414 k=destroy id=2 x=-800.0 y=690.0 z=30.0",
  "rec t=414 k=script_start serial=1 script=12 module=MAP01 act=player0",
  "rec t=415 k=sample id=1 tid=7 hp=-32 x=-800.0",
  "rec t=424 k=script_end serial=1 script=12",
  "rec t=414 k=script_start serial=2 script=-1 module=OSACS act=none name=Round Start",
];

describe("groupVarsBySource", () => {
  it("groups sourceFile vars by file, object and include dirs, skipping the rest", () => {
    const vars = [
      { map: "a", sourceFile: "/s.bcs" },
      { world: 1 },
      { map: "b", sourceFile: "/s.bcs", object: "/o.o" },
      { map: "c", sourceFile: "/s.bcs" },
      { map: "d", sourceFile: "/s.bcs", includeDirs: ["/i"] },
    ];
    expect(groupVarsBySource(vars)).toEqual([[0, 3], [2], [4]]);
    expect(groupVarsBySource([{ world: 1 }])).toEqual([]);
  });
});

describe("recordProblem", () => {
  it("passes a watch, or scripts alone", () => {
    expect(recordProblem(opts())).toBeUndefined();
    expect(recordProblem(opts({ watch: [], scripts: "all" }))).toBeUndefined();
    expect(recordProblem(opts({ scripts: [12, "Round_Start"] }))).toBeUndefined();
    expect(recordProblem(opts({ run: false, tics: 10500 }))).toBeUndefined();
  });

  it("names what can't be recorded or sent", () => {
    expect(recordProblem(opts({ watch: [] }))).toBe("give watch, scripts or vars: nothing to record");
    expect(recordProblem(opts({ watch: [{ tid: 3 }, {}] }))).toBe("watch 2: give class, tid or player");
    expect(recordProblem(opts({ tics: 2101 }))).toBe("run mode records at most 2100 tics (60 s); run: false arms up to 10500");
    for (const name of ["123", "-5", "+5"]) {
      expect(recordProblem(opts({ scripts: [name] }))).toBe(`script name "${name}" reads as a number in mcp_rec`);
    }
    for (const name of ["a,b", "Café", 'a"b', "a\\b", "a;b", " lead", "trail ", "tab\tbed"]) {
      expect(recordProblem(opts({ scripts: [name] })), name).toMatch(/can't be sent .*use scripts: "all"$/);
    }
  });

  it("passes names the quoted list carries: inner spaces, a leading $ or sign", () => {
    expect(recordProblem(opts({ scripts: ["Round Start", "$x", "-foo", "a"] }))).toBeUndefined();
  });

  it("accepts vars alone and enforces selectors and source pairing", () => {
    expect(recordProblem(opts({ watch: [], vars: [{ world: 0 }, { global: 2, index: 0 }, { map: "flag" }] }))).toBeUndefined();
    expect(recordProblem(opts({ vars: Array.from({ length: 33 }, () => ({ world: 1 })) }))).toContain("at most 32");
    for (const v of [{}, { world: 1, map: "flag" }]) expect(recordProblem(opts({ vars: [v] }))).toContain("exactly one");
    expect(recordProblem(opts({ vars: [{ world: 1, sourceFile: "a.bcs" }] }))).toContain("sourceFile requires map");
    for (const v of [{ map: "flag", object: "a.o" }, { map: "flag", includeDirs: [] }]) {
      expect(recordProblem(opts({ vars: [v] }))).toContain("object and includeDirs require sourceFile");
    }
    expect(recordProblem(opts({ vars: [{ map: "a", sourceFile: "a.bcs", index: 1 }] }))).toContain("put the index");
    expect(recordProblem(opts({ vars: [{ map: "a+1", sourceFile: "a.bcs" }] }))).toContain("constant [index]");
    expect(recordProblem(opts({ vars: [{ map: "a[1].b", sourceFile: "a.bcs" }] }))).toBeUndefined();
  });
});

describe("recordSchedule", () => {
  it("stops, clears, sets up and arms in one line, the command last", () => {
    expect(recordSchedule(opts({ watch: [{ class: "DoomImp", tid: 7 }, { player: 1 }] }), "+attack")).toBe(
      "mcp_rec stop; mcp_rec clear; mcp_rec watch class=DoomImp tid=7; mcp_rec watch player=1; " +
        "mcp_rec fields tid,hp,x,y,z,sprite,frame; mcp_rec events spawn,destroy,damage,death; mcp_rec go tics=35 run=1 every=1 changes=1; +attack",
    );
  });

  it("sends no events as none, the script filter, and a passive go", () => {
    const line = recordSchedule(opts({ watch: [], events: [], fields: ["state"], scripts: [12, "Foo"], run: false, everyTics: 2, onChange: false, tics: 500 }));
    expect(line).toBe("mcp_rec stop; mcp_rec clear; mcp_rec fields state; mcp_rec events none; mcp_rec scripts 12,Foo; mcp_rec go tics=500 every=2 changes=0");
    expect(recordSchedule(opts({ scripts: "all" }))).toContain("; mcp_rec scripts all; mcp_rec go ");
  });

  it("quotes a script list holding a spaced name or a leading $, as one argument", () => {
    expect(recordSchedule(opts({ scripts: [3, "Round Start"] }))).toContain('; mcp_rec scripts "3,Round Start"; mcp_rec go ');
    expect(recordSchedule(opts({ scripts: ["$x"] }))).toContain('; mcp_rec scripts "$x"; mcp_rec go ');
  });

  it("schedules every var form after scripts, and labels only probe-resolved slots", () => {
    const resolved = { slot: 6, index: 5, digest: { len: 44, first: "SPTR", md5: "abcd" }, module: { name: "acs/a.o", data: Buffer.alloc(0) } };
    expect(recordSchedule(opts({ scripts: "all", vars: [
      { map: "flag" }, { map: "arr", index: 3 }, { world: 0 }, { global: 1, index: 2 },
      { map: "points[1].y", sourceFile: "a.bcs", resolved },
    ] }))).toContain("mcp_rec scripts all; mcp_rec var map=flag; mcp_rec var map=arr index=3; mcp_rec var world=0; " +
      "mcp_rec var global=1 index=2; mcp_rec var slot=6 v=1 code=44 first=SPTR md5=abcd index=5 label=points[1].y; mcp_rec go");
  });
});

describe("REC_FIELDS", () => {
  it("is findactors' keys but class, then the state's", () => {
    expect(REC_FIELDS).not.toContain("class");
    expect(REC_FIELDS.slice(0, 3)).toEqual(["tid", "hp", "spawnhp"]);
    expect(REC_FIELDS.slice(-14, -11)).toEqual(["state", "label", "tics"]);
    expect(REC_FIELDS.slice(-11)).toEqual(PLAYER_REC_FIELDS);
  });
});

describe("player recording fields", () => {
  it("expands groups in place, dedupes, and requires the player cap only for new features", () => {
    expect(expandFields(["x", "input", "buttons", "weaponstate", "wtics", "x"])).toEqual(["x", ...PLAYER_REC_FIELDS]);
    expect(expandFields([])).toEqual([]);
    expect(needsPlayerCap({ fields: DEFAULT_REC_FIELDS, events: DEFAULT_REC_EVENTS })).toBe(false);
    for (const f of [...PLAYER_REC_FIELDS, "input", "weaponstate"] as const) {
      expect(needsPlayerCap({ fields: [f], events: [] })).toBe(true);
    }
    expect(needsPlayerCap({ fields: [], events: ["psprite"] })).toBe(true);
    expect(recordSchedule(opts({ fields: expandFields(["input", "weaponstate"]), events: ["psprite"] }))).toContain(
      `mcp_rec fields ${PLAYER_REC_FIELDS.join(",")}; mcp_rec events psprite;`,
    );
  });

  it("decodes bit cells without changing file values and puts a psprite row's layer in info", () => {
    const rec = file([
      "rec t=1 k=sample id=1 buttons=3 modbuttons=2147483648 wflags=0",
      "rec t=2 k=psprite id=1 layer=1000 wstate=Pistol.9 wlabel=Flash wsprite=PISF wframe=A wtics=7",
      "rec t=3 k=psprite id=1 layer=1000 wstate=none",
      "rec t=4 k=sample id=1 buttons=0 modbuttons=0 wflags=4097",
    ], { fields: "buttons,modbuttons,wflags,wstate,wlabel,wsprite,wframe,wtics" });
    const r = recordResult(rec, "f", 20);
    expect(r.table.rows[0]).toEqual([1, "sample", 1, null, "attack+use", "bit31", "-", null, null, null, null, null, null]);
    expect(r.table.rows[1]).toEqual([2, "psprite", 1, null, null, null, null, "Pistol.9", "Flash", "PISF", "A", 7, "layer=1000"]);
    expect(r.table.rows[2][7]).toBe("none");
    expect(r.table.rows[3].slice(4, 7)).toEqual(["-", "-", "weaponready+bit12"]);
    expect(rec.rows[0].buttons).toBe(3);
  });
});

describe("actorSummaries", () => {
  it("follows each id from its first row, keeping the first death", () => {
    const rows = file([...FIGHT, "rec t=420 k=death id=1 hp=-50"]).rows;
    expect(actorSummaries(rows)).toEqual([
      { id: 1, class: "DoomImp", tid: 7, first: 412, last: 420, died: 414 },
      { id: 2, class: "Rocket", tid: 0, first: 412, last: 414, spawned: 412, destroyed: 414 },
    ]);
  });

  it("takes the latest tid, since a spawn row's is set only after it", () => {
    const rows = file(["rec t=1 k=spawn id=3 class=DoomImp tid=0 x=0.0 y=0.0 z=0.0", "rec t=2 k=sample id=3 tid=9 hp=60", "rec t=3 k=death id=3 hp=0"]).rows;
    expect(actorSummaries(rows)[0]).toMatchObject({ id: 3, tid: 9, spawned: 1, died: 3 });
  });

  it("keeps an id with no spawn or seen row, classless; untracked targets make none", () => {
    const rows = file(["rec t=5 k=sample id=4 hp=10", "rec t=6 k=damage id=0 tgt=DoomImp#0 amount=3 type=None hp=7"]).rows;
    expect(actorSummaries(rows)).toEqual([{ id: 4, class: null, first: 5, last: 5 }]);
  });
});

describe("scriptSummaries", () => {
  it("pairs starts and ends by serial, a named script by its name", () => {
    expect(scriptSummaries(file(FIGHT).rows)).toEqual([
      { serial: 1, script: 12, module: "MAP01", start: 414, end: 424, activator: "player0" },
      { serial: 2, script: "Round Start", module: "OSACS", start: 414, activator: "none" },
    ]);
  });

  it("keeps each end with no recorded start apart", () => {
    const rows = file(["rec t=3 k=script_end serial=0 script=5", "rec t=4 k=script_end serial=0 script=6"]).rows;
    expect(scriptSummaries(rows)).toEqual([{ serial: 0, script: 5, end: 3 }, { serial: 0, script: 6, end: 4 }]);
  });
});

describe("capRows", () => {
  const rows: KvRecord[] = [
    { t: 1, k: "sample", id: 1 },
    { t: 1, k: "sample", id: 2 },
    { t: 2, k: "spawn", id: 3 },
    { t: 2, k: "sample", id: 1 },
    { t: 3, k: "death", id: 1 },
  ];

  it("keeps events first, then samples in order, the file's order kept", () => {
    expect(capRows(rows, 3)).toEqual([rows[0], rows[2], rows[4]]);
    expect(capRows(rows, 4)).toEqual([rows[0], rows[1], rows[2], rows[4]]);
  });

  it("keeps only the first events when they alone overflow, and everything that fits", () => {
    expect(capRows(rows, 1)).toEqual([rows[2]]);
    expect(capRows(rows, 5)).toBe(rows);
  });
});

describe("varSummaries", () => {
  it("keeps baseline and changes in file order, caps values and keeps var rows before samples", () => {
    const rec = file([
      "rec t=0 k=sample id=1 hp=5",
      ...Array.from({ length: 53 }, (_, i) => `rec t=${i} k=var var=1 value=${i}${i ? ` prev=${i - 1}` : ""} name=flag`),
      "rec t=4 k=var var=2 value=0 name=world[0]",
    ]);
    const summaries = varSummaries(rec.rows);
    expect(summaries[0]).toMatchObject({ var: 1, name: "flag", changes: 52, valuesOmitted: 3 });
    expect(summaries[0].values).toHaveLength(50);
    expect(summaries[1]).toEqual({ var: 2, name: "world[0]", values: [[4, 0]], changes: 0 });
    const r = recordResult(rec, "f", 1);
    expect(r.vars).toEqual(summaries);
    expect(r.counts.var).toBe(54);
    expect(r.table.rows[0]).toEqual([0, "var", null, null, null, null, null, "var=1 value=0 name=flag"]);
    const text = describeRecord(r, rec, []);
    expect(text).toContain("0 event, 54 var");
    expect(text).toContain("flag: 0 @0, 1 @1, 2 @2");
    expect(text).toContain("11 @11 (+41 more)");
    expect(text).toContain("world[0]: 0 @4");
    expect(text).not.toContain("events:");
  });
});

describe("recordResult", () => {
  it("builds the table with the class joined and the other keys in info", () => {
    const r = recordResult(file(FIGHT), "/tmp/r/mcp-rec-1-1.txt", 200);
    expect(r).toMatchObject({ reason: "done", tics: 35, start: 412, end: 447, file: "/tmp/r/mcp-rec-1-1.txt" });
    expect(r.table.columns).toEqual(["t", "kind", "id", "class", "tid", "hp", "x", "info"]);
    expect(r.table.rows[0]).toEqual([412, "seen", 1, "DoomImp", 7, null, -800, "y=700 z=0"]);
    expect(r.table.rows[1]).toEqual([412, "sample", 1, "DoomImp", 7, 60, -800, null]);
    expect(r.table.rows[4]).toEqual([414, "damage", 1, "DoomImp", null, -32, null, "amount=92 type=None src=player0 inf=Rocket#0 infid=2"]);
    expect(r.table.rows[8]).toEqual([414, "script_start", null, null, null, null, null, "serial=1 script=12 module=MAP01 act=player0"]);
    expect(r.counts).toEqual({ seen: 1, sample: 3, spawn: 1, damage: 1, death: 1, state: 1, destroy: 1, script_start: 2, script_end: 1 });
    expect(r.rowsDropped).toBeUndefined();
    expect(r.engineDropped).toBeUndefined();
    expect(r.untracked).toBeUndefined();
  });

  it("counts what the cap, the engine and the tracked cap left out, and reads an armed one as recording", () => {
    const r = recordResult(file(FIGHT, { dropped: 7, reason: "-" }), "f", 4, 2);
    expect(r).toMatchObject({ reason: "recording", rowsDropped: 8, engineDropped: 7, untracked: 2 });
    expect(r.table.rows.map((row) => row[1])).toEqual(["seen", "spawn", "damage", "death"]);
    expect(recordResult(file([], { reason: "map_reset" }), "f", 10).reason).toBe("map_reset");
  });

  it("caps the actor and script summaries", () => {
    const many = Array.from({ length: SUMMARY_CAP + 2 }, (_, i) => [
      `rec t=1 k=spawn id=${i + 1} class=DoomImp tid=0 x=0.0 y=0.0 z=0.0`,
      `rec t=1 k=script_start serial=${i + 1} script=1 module=MAP01 act=none`,
    ]).flat();
    const r = recordResult(file(many), "f", 10);
    expect(r.actors).toHaveLength(SUMMARY_CAP);
    expect(r.scripts).toHaveLength(SUMMARY_CAP);
    expect(r).toMatchObject({ actorsOmitted: 2, scriptsOmitted: 2 });
  });
});

describe("recordNotes", () => {
  it("is empty for a whole recording, and names each loss and a header mismatch", () => {
    const whole = file(FIGHT);
    expect(recordNotes(recordResult(whole, "f", 200), whole)).toEqual([]);
    const lossy = file(FIGHT, { dropped: 3, rows: 99 });
    expect(recordNotes(recordResult(lossy, "f", 2, 1), lossy)).toEqual([
      "10 row(s) past maxRows left out of the table (events kept first); the file has them all",
      "3 row(s) past the engine's 20000-row buffer were never recorded",
      "1 matching actor(s) past the 512-actor cap were not tracked",
      "the file has 12 row(s), its header says 99",
    ]);
  });
});

describe("describeRecord", () => {
  it("prints the header, actors, scripts, events and the file", () => {
    const rec = file(FIGHT);
    const r = recordResult(rec, "/tmp/r/mcp-rec-1-1.txt", 200);
    expect(describeRecord(r, rec, ["a note"])).toBe(
      [
        "recorded 35 tic(s), maptime 412..447: 2 actor(s), 12 row(s) (3 sample, 1 seen, 8 event, 0 var), done",
        "#1 DoomImp tid 7: seen 412..415, died 414",
        "#2 Rocket: spawned 412, destroyed 414",
        "script 12 serial 1: started 414 in MAP01 by player0, ended 424",
        "script Round Start serial 2: started 414 in OSACS by none, still running",
        "events:",
        "  412 spawn #2 Rocket: tid=0 x=-790 y=640 z=32",
        "  414 damage #1 DoomImp: amount=92 type=None src=player0 inf=Rocket#0 infid=2 hp=-32",
        "  414 death #1 DoomImp: src=player0 inf=Rocket#0 hp=-32",
        "  414 state #1 DoomImp: state=DoomImp.20 label=Death sprite=TROO frame=I tics=8",
        "  414 destroy #2 Rocket: x=-800 y=690 z=30",
        "  414 script_start serial 1: script=12 module=MAP01 act=player0",
        "  424 script_end serial 1: script=12",
        "  414 script_start serial 2: script=-1 module=OSACS act=none name=Round Start",
        "a note",
        "file: /tmp/r/mcp-rec-1-1.txt",
      ].join("\n"),
    );
  });

  it("caps the event lines, notes omitted summaries, and copes with a missing spawn and an untracked target", () => {
    const rows = [
      "rec t=1 k=sample id=4 hp=10",
      "rec t=1 k=state id=4 state=X.1 tics=2",
      "rec t=1 k=script_end serial=0 script=5",
      ...Array.from({ length: EVENT_LINES + 1 }, () => "rec t=2 k=damage id=0 tgt=DoomImp#0 amount=3 type=None src=player0 srcid=4 hp=7"),
      "rec t=3 k=sample id=4 hp=9",
    ];
    const rec = file(rows, { fields: "-" });
    const r = { ...recordResult(rec, "f", 10), actorsOmitted: 1, scriptsOmitted: 3 };
    const text = describeRecord(r, rec, []);
    expect(text).toContain("maptime 412..447: 2 actor(s), 45 row(s) (2 sample, 0 seen, 43 event, 0 var), done\n#4 ?: seen 1..3\n(1 more actor(s) in the file)");
    expect(text).toContain(
      "script 5 serial 0: no recorded start, ended 1\n(3 more script(s) in the file)\nevents:\n  1 state #4 ?: state=X.1 tics=2\n  1 script_end serial 0: script=5\n",
    );
    expect(text).toContain("  2 damage untracked: tgt=DoomImp#0 amount=3 type=None src=player0 srcid=4 hp=7\n");
    expect(text).toMatch(/\n\(3 more event\(s\) in the file\)\nfile: f$/);
  });

  it("leaves out the events block when there are none (seen rows are no event lines)", () => {
    const one = (row: string) => {
      const rec = file([row]);
      return describeRecord(recordResult(rec, "f", 10), rec, []);
    };
    expect(one("rec t=412 k=sample id=1 hp=5")).toBe(
      "recorded 35 tic(s), maptime 412..447: 1 actor(s), 1 row(s) (1 sample, 0 seen, 0 event, 0 var), done\n#1 ?: seen 412\nfile: f",
    );
    expect(one("rec t=412 k=seen id=1 class=A tid=0 x=0.0 y=0.0 z=0.0")).toBe(
      "recorded 35 tic(s), maptime 412..447: 1 actor(s), 1 row(s) (0 sample, 1 seen, 0 event, 0 var), done\n#1 A: seen 412\nfile: f",
    );
  });
});

describe("recDumpFiles", () => {
  it("makes one dir on first use and keeps only the newest files", () => {
    const made: string[] = [];
    const removed: string[] = [];
    const io = { mkdtemp: (p: string) => (made.push(p), "/t/mcp-rec-AB"), removeFile: (p: string) => void removed.push(p) };
    const files = recDumpFiles(() => io, () => "/t");
    // The dir alone names no file, so it uses up none of the kept ones.
    expect(files.dir()).toBe("/t/mcp-rec-AB");
    expect(files.next(1)).toBe(norm("/t/mcp-rec-AB/mcp-rec-1-1.txt"));
    expect(files.next(2)).toBe(norm("/t/mcp-rec-AB/mcp-rec-2-2.txt"));
    for (let i = 3; i <= REC_KEEP + 1; i++) files.next(1);
    expect(made).toEqual([norm("/t/mcp-rec-")]);
    expect(removed).toEqual([norm("/t/mcp-rec-AB/mcp-rec-1-1.txt")]);
    files.next(1);
    expect(removed).toEqual([norm("/t/mcp-rec-AB/mcp-rec-1-1.txt"), norm("/t/mcp-rec-AB/mcp-rec-2-2.txt")]);
  });

  it("defaults to the system temp dir", () => {
    const files = recDumpFiles(() => ({ mkdtemp: (p: string) => p + "X", removeFile: () => {} }));
    expect(files.dir()).toMatch(/mcp-rec-X$/);
  });
});
