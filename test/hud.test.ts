import { describe, it, expect } from "vitest";
import { parseHud } from "../src/parsers/hud.js";

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
