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

/** Parse `dumphud` output into on-screen strings, images, and ACS HUD messages. */
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
