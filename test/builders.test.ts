import { describe, it, expect } from "vitest";
import {
  command,
  kvArgs,
  realToken,
  buildPuke,
  buildPukeName,
  buildRunScript,
  buildAddBot,
  buildRunAcs,
  buildSave,
  refToken,
  isPlainToken,
  UnsafeArgumentError,
} from "../src/commands/builders.js";

describe("refToken", () => {
  it("encodes each reference form", () => {
    expect(refToken({ tid: 7 })).toBe("tid:7");
    expect(refToken({ tid: 7, index: 2 })).toBe("tid:7:2");
    expect(refToken({ player: 0 })).toBe("player:0");
    expect(refToken({ class: "DoomImp" })).toBe("class:DoomImp");
    expect(refToken({ x: -800.5, y: 700 })).toBe("pt:-800.5,700");
    expect(refToken({ x: 1, y: 2, z: 48 })).toBe("pt:1,2,48");
  });

  it("rejects a class or number that could smuggle a command", () => {
    expect(() => refToken({ class: "Imp;quit" })).toThrow(UnsafeArgumentError);
    expect(() => refToken({ tid: 1.5 })).toThrow(UnsafeArgumentError);
  });
});

describe("kvArgs", () => {
  it("emits key=value tokens in order and skips undefined ones", () => {
    expect(kvArgs({ class: "DoomImp", tid: undefined, radius: 0, limit: 5 })).toEqual([
      "class=DoomImp",
      "radius=0",
      "limit=5",
    ]);
    expect(kvArgs({})).toEqual([]);
  });
});

describe("command", () => {
  it("joins a verb with string and number tokens", () => {
    expect(command("summon", "DoomImp")).toBe("summon DoomImp");
    expect(command("give", "Clip", 50)).toBe("give Clip 50");
  });

  it("rejects string tokens that could smuggle extra commands", () => {
    expect(() => command("summon", "Imp; quit")).toThrow(UnsafeArgumentError);
    expect(() => command("say", "a\nquit")).toThrow(UnsafeArgumentError);
    expect(() => command("map", 'a"b')).toThrow(UnsafeArgumentError);
    expect(() => command("summon", "")).toThrow(UnsafeArgumentError);
  });

  it("rejects non-integer number tokens", () => {
    expect(() => command("give", "Clip", 1.5)).toThrow(UnsafeArgumentError);
  });
});

describe("isPlainToken", () => {
  it("accepts printable ASCII, including a $ past the start", () => {
    expect(isPlainToken("DoomImp")).toBe(true);
    expect(isPlainToken("a$b")).toBe(true);
    expect(isPlainToken("~")).toBe(true);
  });

  it.each(["$sv_cheats", "Café", "two words", "", "\x7f"])("rejects %j", (t) => {
    expect(isPlainToken(t)).toBe(false);
  });
});

describe("buildPuke", () => {
  it("builds puke with args", () => {
    expect(buildPuke(5)).toBe("puke 5");
    expect(buildPuke(5, [1, 2])).toBe("puke 5 1 2");
  });

  it("negates the script number for always, puke's own way of saying it", () => {
    expect(buildPuke(5, [1, 2], true)).toBe("puke -5 1 2");
    expect(buildPuke(5, [], false)).toBe("puke 5");
    expect(buildPuke(0, [], true)).toBe("puke 0");
  });

  it("rejects negative or non-integer script numbers", () => {
    expect(() => buildPuke(-1)).toThrow(UnsafeArgumentError);
    expect(() => buildPuke(1.5)).toThrow(UnsafeArgumentError);
  });

  it("rejects non-integer args", () => {
    expect(() => buildPuke(5, [1.5])).toThrow(UnsafeArgumentError);
  });
});

describe("buildSave", () => {
  it("builds save with and without a quoted description", () => {
    expect(buildSave("slot1")).toBe("save slot1");
    expect(buildSave("slot1", "before boss")).toBe('save slot1 "before boss"');
  });

  it("rejects unsafe names or descriptions", () => {
    expect(() => buildSave('a"b')).toThrow(UnsafeArgumentError);
    expect(() => buildSave("ok", "a;quit")).toThrow(UnsafeArgumentError);
  });
});

describe("buildRunAcs", () => {
  it("passes a pre-quoted object token through and checks the rest", () => {
    expect(buildRunAcs('"/tmp/a b/x.o"', 1, [-2], true)).toBe('mcp_runacs "/tmp/a b/x.o" 1 -2 open=1');
    expect(buildRunAcs("/tmp/x.o")).toBe("mcp_runacs /tmp/x.o");
    expect(buildRunAcs("/tmp/x.o", undefined, [], true)).toBe("mcp_runacs /tmp/x.o open=1");
  });

  it("with markName, marks every string script name=1 after its args, so a name made of digits stays a name", () => {
    expect(buildRunAcs("/tmp/x.o", "5", [7], false, true)).toBe("mcp_runacs /tmp/x.o 5 7 name=1");
    expect(buildRunAcs("/tmp/x.o", "Probe", [], true, true)).toBe("mcp_runacs /tmp/x.o Probe name=1 open=1");
    expect(buildRunAcs("/tmp/x.o", 5, [7], false, true)).toBe("mcp_runacs /tmp/x.o 5 7");
    expect(buildRunAcs("/tmp/x.o", "Probe")).toBe("mcp_runacs /tmp/x.o Probe");
  });

  it("still rejects a semicolon, quote or newline inside the object or the rest", () => {
    expect(() => buildRunAcs('"/tmp/a;quit/x.o"')).toThrow(UnsafeArgumentError);
    expect(() => buildRunAcs('"/tmp/a" ; quit "x.o"')).toThrow(UnsafeArgumentError);
    expect(() => buildRunAcs("/tmp/x.o", "a;quit")).toThrow(UnsafeArgumentError);
    expect(() => buildRunAcs("/tmp/x.o", 1, [1.5])).toThrow(UnsafeArgumentError);
  });
});

describe("buildPukeName", () => {
  it("quotes the name and appends optional always + args", () => {
    expect(buildPukeName("OpenDoor")).toBe('pukename "OpenDoor"');
    expect(buildPukeName("OpenDoor", [1, 2])).toBe('pukename "OpenDoor" 1 2');
    expect(buildPukeName("OpenDoor", [1], true)).toBe('pukename "OpenDoor" always 1');
  });

  it("rejects unsafe names and non-integer args", () => {
    expect(() => buildPukeName('a"b')).toThrow(UnsafeArgumentError);
    expect(() => buildPukeName("Foo", [1.5])).toThrow(UnsafeArgumentError);
  });
});

describe("buildRunScript", () => {
  it("sends a numbered script bare, with always=1 before the args", () => {
    expect(buildRunScript(12)).toBe("mcp_runscript 12");
    expect(buildRunScript(12, [1, -2])).toBe("mcp_runscript 12 1 -2");
    expect(buildRunScript(12, [1], true)).toBe("mcp_runscript 12 always=1 1");
  });

  it("quotes a name, so one with spaces stays a single argument, and marks it name=1", () => {
    expect(buildRunScript("Open Door")).toBe('mcp_runscript "Open Door" name=1');
    expect(buildRunScript("OpenDoor", [1, 2], true)).toBe('mcp_runscript "OpenDoor" name=1 always=1 1 2');
  });

  it("keeps a name made of digits a name, and a number a number", () => {
    expect(buildRunScript("5", [7])).toBe('mcp_runscript "5" name=1 7');
    expect(buildRunScript(5, [7])).toBe("mcp_runscript 5 7");
  });

  it("rejects unsafe names and non-integer numbers or args", () => {
    expect(() => buildRunScript('a"b')).toThrow(UnsafeArgumentError);
    expect(() => buildRunScript("a;quit")).toThrow(UnsafeArgumentError);
    expect(() => buildRunScript(1.5)).toThrow(UnsafeArgumentError);
    expect(() => buildRunScript("Foo", [1.5])).toThrow(UnsafeArgumentError);
    expect(() => buildRunScript(5, [1.5])).toThrow(UnsafeArgumentError);
  });
});

describe("buildAddBot", () => {
  it("sends a bare addbot without a name and quotes one, so spaces stay one argument", () => {
    expect(buildAddBot()).toBe("addbot");
    expect(buildAddBot("Doom Guy")).toBe('addbot "Doom Guy"');
    expect(() => buildAddBot('a";kill')).toThrow(UnsafeArgumentError);
  });
});

describe("realToken", () => {
  it("passes a fractional number and rejects a non-finite one, in kvArgs too", () => {
    expect(command("mcp_setview", realToken(-12.5))).toBe("mcp_setview -12.5");
    expect(() => realToken(NaN)).toThrow(UnsafeArgumentError);
    expect(() => realToken(Infinity)).toThrow(UnsafeArgumentError);
    expect(() => kvArgs({ angle: NaN })).toThrow(UnsafeArgumentError);
  });
});
