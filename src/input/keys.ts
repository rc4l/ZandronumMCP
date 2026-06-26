// Input-event constants mirrored from the engine headers, plus the mapping from
// friendly menu-key names to the GUI key event the menu system responds to.
//
//   d_event.h  EGenericEvent: EV_GUI_Event = 4
//   d_gui.h    EGUIEvent:     EV_GUI_KeyDown = 1
//   d_gui.h    GK_* codes:    LEFT=5 RIGHT=6 BACKSPACE=8 DOWN=10 UP=11 RETURN=13 ESCAPE=27
//
// Menus read EV_GUI_Event/EV_GUI_KeyDown (not raw EV_KeyDown), so these are the
// events that actually move a menu cursor.

export const EV_GUI_EVENT = 4;
export const EV_GUI_KEYDOWN = 1;
export const EV_GUI_CHAR = 4;

const GK = {
  left: 5,
  right: 6,
  backspace: 8,
  down: 10,
  up: 11,
  enter: 13,
  escape: 27,
} as const;

export type MenuKey = "up" | "down" | "left" | "right" | "enter" | "back" | "backspace";

const MENU_KEY_CODE: Record<MenuKey, number> = {
  up: GK.up,
  down: GK.down,
  left: GK.left,
  right: GK.right,
  enter: GK.enter,
  back: GK.escape,
  backspace: GK.backspace,
};

export interface InputEvent {
  evtype: number;
  subtype: number;
  data1: number;
  data2: number;
}

/** Build the GUI key-down event the menu system responds to for a named key. */
export function menuKeyEvent(key: MenuKey): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: EV_GUI_KEYDOWN, data1: MENU_KEY_CODE[key], data2: 0 };
}

/** Build the GUI character event a menu text field appends (one character). */
export function charEvent(ch: string): InputEvent {
  return { evtype: EV_GUI_EVENT, subtype: EV_GUI_CHAR, data1: ch.charCodeAt(0), data2: 0 };
}
