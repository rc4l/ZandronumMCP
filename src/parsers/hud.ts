export interface HudText {
  x: number;
  y: number;
  text: string;
}

export interface HudImage {
  x: number;
  y: number;
  name: string;
}

export interface HudMessage {
  layer: number;
  left: number;
  top: number;
  tics: number;
  text: string;
}

export interface HudCapture {
  text: HudText[];
  images: HudImage[];
  messages: HudMessage[];
}

const TEXT_RE = /^text (-?\d+) (-?\d+) (.*)$/;
const IMAGE_RE = /^image (-?\d+) (-?\d+) (\S+)$/;
const MSG_RE = /^msg (\d+) (-?[\d.]+) (-?[\d.]+) (-?\d+) (.*)$/;

/** Parse `dumphud` output into on-screen strings, images, and HUD messages (ACS on Zandronum, ACS/native on UZDoom). */
export function parseHud(lines: string[]): HudCapture {
  const out: HudCapture = { text: [], images: [], messages: [] };
  for (const raw of lines) {
    for (const line of raw.split(/\r?\n/)) {
      let m: RegExpMatchArray | null;
      if ((m = line.match(TEXT_RE))) {
        out.text.push({ x: Number(m[1]), y: Number(m[2]), text: m[3] });
      } else if ((m = line.match(IMAGE_RE))) {
        out.images.push({ x: Number(m[1]), y: Number(m[2]), name: m[3] });
      } else if ((m = line.match(MSG_RE))) {
        out.messages.push({
          layer: Number(m[1]),
          left: Number(m[2]),
          top: Number(m[3]),
          tics: Number(m[4]),
          text: m[5],
        });
      }
    }
  }
  return out;
}

export interface HudFilter {
  /** Case-insensitive regex against a string's or message's text, or an image's name. */
  pattern?: string;
  /** Half-open rect on text and image x/y; messages use another coordinate space and are never region-filtered. */
  region?: { x: number; y: number; w: number; h: number };
  /** Per kind, the first N matches in draw order are kept. */
  maxItems: number;
}

export type FilteredHud = HudCapture & { omitted: { text: number; images: number; messages: number } };

/** The items of a HUD capture that pass a filter, capped per kind, with how many the cap left out. */
export function filterHud(hud: HudCapture, f: HudFilter): FilteredHud {
  const rx = f.pattern === undefined ? undefined : new RegExp(f.pattern, "i");
  const r = f.region;
  const inRegion = (p: { x: number; y: number }) => !r || (p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h);
  const take = <T>(items: T[], match: (t: T) => boolean) => {
    const all = items.filter(match);
    return { kept: all.slice(0, f.maxItems), omitted: Math.max(0, all.length - f.maxItems) };
  };
  const text = take(hud.text, (t) => inRegion(t) && (!rx || rx.test(t.text)));
  const images = take(hud.images, (i) => inRegion(i) && (!rx || rx.test(i.name)));
  const messages = take(hud.messages, (m) => !rx || rx.test(m.text));
  return {
    text: text.kept,
    images: images.kept,
    messages: messages.kept,
    omitted: { text: text.omitted, images: images.omitted, messages: messages.omitted },
  };
}
