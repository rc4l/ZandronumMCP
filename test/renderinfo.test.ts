import { describe, it, expect } from "vitest";
import { parseRenderInfo, pick } from "../src/parsers/renderinfo.js";

const sample = [
  "MCP_RENDERER",
  "renderer=opengl",
  "screen_width=1920",
  "screen_height=1080",
  "view_x=0",
  "view_y=0",
  "view_width=1920",
  "view_height=1080",
  "statusbar_y=1048",
  "gl_vendor=Intel Inc.",
  "gl_shadermodel=4",
  "vid_fullscreen=0",
];

describe("parseRenderInfo", () => {
  it("parses key=value lines, numbers as numbers, header skipped", () => {
    const info = parseRenderInfo(sample);
    expect(info.renderer).toBe("opengl");
    expect(info.screen_width).toBe(1920);
    expect(info.view_height).toBe(1080);
    expect(info.statusbar_y).toBe(1048);
    expect("MCP_RENDERER" in info).toBe(false);
  });

  it("keeps values that contain spaces as strings", () => {
    expect(parseRenderInfo(sample).gl_vendor).toBe("Intel Inc.");
  });

  it("handles multiple lines arriving in one chunk and an empty value", () => {
    const info = parseRenderInfo(["renderer=software\nview_x=0", "label="]);
    expect(info.renderer).toBe("software");
    expect(info.label).toBe(""); // empty value stays a string, not 0
  });
});

describe("pick", () => {
  it("returns only the present requested keys", () => {
    const info = parseRenderInfo(sample);
    expect(pick(info, ["renderer", "vid_fullscreen", "missing"])).toEqual({
      renderer: "opengl",
      vid_fullscreen: 0,
    });
  });
});
