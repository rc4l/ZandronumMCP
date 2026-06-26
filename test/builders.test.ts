import { describe, it, expect } from "vitest";
import { command, buildPuke, buildPukeName, buildSave, UnsafeArgumentError } from "../src/commands/builders.js";

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

describe("buildPuke", () => {
  it("builds puke with args", () => {
    expect(buildPuke(5)).toBe("puke 5");
    expect(buildPuke(5, [1, 2])).toBe("puke 5 1 2");
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
