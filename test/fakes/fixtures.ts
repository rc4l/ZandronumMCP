import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The engines whose real captures live under `test/fixtures/<engine>/`. */
export const ENGINES = ["zandronum"] as const;
export type Engine = (typeof ENGINES)[number];

/** A captured console reply `test/fixtures/<engine>/<file>` as lines, final newline dropped. */
export function engineFixture(engine: string, file: string): string[] {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${engine}/${file}`, import.meta.url)), "utf8")
    .replace(/\r?\n$/, "")
    .split(/\r?\n/);
}
