import { describe, it, expect } from "vitest";
import { parseHud, filterHud } from "../src/parsers/hud.js";

describe("parseHud", () => {
  it("parses text, images, and ACS hud messages", () => {
    const out = [
      "MCP_HUD",
      "text 100 50 Press space to join",
      "text 8 184 ",
      "image 10 20 MEDIA0",
      "msg 0 0.500 0.900 70 Credits: 2008",
    ];
    const hud = parseHud(out);
    expect(hud.text).toEqual([
      { x: 100, y: 50, text: "Press space to join" },
      { x: 8, y: 184, text: "" },
    ]);
    expect(hud.images).toEqual([{ x: 10, y: 20, name: "MEDIA0" }]);
    expect(hud.messages).toEqual([{ layer: 0, left: 0.5, top: 0.9, tics: 70, text: "Credits: 2008" }]);
  });

  it("ignores the header and unrelated lines", () => {
    expect(parseHud(["MCP_HUD", "garbage line"])).toEqual({ text: [], images: [], messages: [] });
  });

  it("handles negative coords and splits embedded newlines", () => {
    const hud = parseHud(["text -4 -4 hi\nimage -1 -1 STFB1"]);
    expect(hud.text).toEqual([{ x: -4, y: -4, text: "hi" }]);
    expect(hud.images).toEqual([{ x: -1, y: -1, name: "STFB1" }]);
  });
});

describe("filterHud", () => {
  const HUD = parseHud([
    "text 0 0 New Game",
    "text 10 20 Options",
    "text 100 50 Quit Game",
    "image 0 168 STBAR",
    "image 10 170 STFB1",
    "image 300 10 M_DOOM",
    "msg 0 0.500 0.100 70 Game saved",
    "msg 1 10.000 20.000 35 Options changed",
  ]);
  const none = { text: 0, images: 0, messages: 0 };

  it("keeps everything under the cap, with nothing omitted", () => {
    expect(filterHud(HUD, { maxItems: 100 })).toEqual({ ...HUD, omitted: none });
  });

  it("matches pattern case-insensitively against text, image names and message text", () => {
    const got = filterHud(HUD, { pattern: "GAME|stbar", maxItems: 100 });
    expect(got.text.map((t) => t.text)).toEqual(["New Game", "Quit Game"]);
    expect(got.images.map((i) => i.name)).toEqual(["STBAR"]);
    expect(got.messages.map((m) => m.text)).toEqual(["Game saved"]);
    expect(got.omitted).toEqual(none);
  });

  it("filters text and images by a half-open region, never messages", () => {
    const got = filterHud(HUD, { region: { x: 0, y: 0, w: 10, h: 170 }, maxItems: 100 });
    expect(got.text.map((t) => t.text)).toEqual(["New Game"]);
    expect(got.images.map((i) => i.name)).toEqual(["STBAR"]);
    expect(got.messages).toHaveLength(2);
    const edges = filterHud(HUD, { region: { x: 10, y: 20, w: 1, h: 1 }, maxItems: 100 });
    expect(edges.text.map((t) => t.text)).toEqual(["Options"]);
    expect(edges.images).toEqual([]);
  });

  it("combines pattern and region", () => {
    const got = filterHud(HUD, { pattern: "o", region: { x: 0, y: 0, w: 50, h: 200 }, maxItems: 100 });
    expect(got.text.map((t) => t.text)).toEqual(["Options"]);
    expect(got.images).toEqual([]);
    expect(got.messages.map((m) => m.text)).toEqual(["Options changed"]);
  });

  it("caps each kind at maxItems in draw order and counts the rest", () => {
    const got = filterHud(HUD, { maxItems: 1 });
    expect(got.text.map((t) => t.text)).toEqual(["New Game"]);
    expect(got.images.map((i) => i.name)).toEqual(["STBAR"]);
    expect(got.messages.map((m) => m.text)).toEqual(["Game saved"]);
    expect(got.omitted).toEqual({ text: 2, images: 2, messages: 1 });
    expect(filterHud(HUD, { pattern: "game", maxItems: 1 }).omitted).toEqual({ text: 1, images: 0, messages: 0 });
  });

  it("throws on an invalid pattern", () => {
    expect(() => filterHud(HUD, { pattern: "(", maxItems: 1 })).toThrow();
  });
});
