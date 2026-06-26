import { describe, it, expect } from "vitest";
import { menuKeyEvent, charEvent, EV_GUI_EVENT, EV_GUI_KEYDOWN, EV_GUI_CHAR } from "../src/input/keys.js";

describe("menuKeyEvent", () => {
  it("maps named keys to GUI key-down events", () => {
    expect(menuKeyEvent("down")).toEqual({
      evtype: EV_GUI_EVENT,
      subtype: EV_GUI_KEYDOWN,
      data1: 10,
      data2: 0,
    });
    expect(menuKeyEvent("up").data1).toBe(11);
    expect(menuKeyEvent("enter").data1).toBe(13);
    expect(menuKeyEvent("back").data1).toBe(27);
    expect(menuKeyEvent("left").data1).toBe(5);
    expect(menuKeyEvent("right").data1).toBe(6);
    expect(menuKeyEvent("backspace").data1).toBe(8);
  });
});

describe("charEvent", () => {
  it("maps a character to a GUI char event with its ASCII code", () => {
    expect(charEvent("a")).toEqual({
      evtype: EV_GUI_EVENT,
      subtype: EV_GUI_CHAR,
      data1: 97,
      data2: 0,
    });
    expect(charEvent("Z").data1).toBe(90);
  });
});
