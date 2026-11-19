import { z } from "zod";
import type { Waypoint } from "./moveto.js";

// No `\S`: Ollama rejects regex shorthands in a pattern under an array.
export const classArg = z.string().regex(/^[^ \t\n\r]+$/, "a class name has no spaces");

// A map coordinate a fixed_t holds (past it the conversion wraps and a trace can run for minutes),
// built fresh per field so the listing inlines it instead of $ref-ing a sibling.
export const mapCoord = () => z.number().finite().min(-32767).max(32767);

/** Whether exactly one of a reference's forms is set. */
export function exactlyOneForm(forms: boolean[]): boolean {
  return forms.filter(Boolean).length === 1;
}

export const waypointFields = {
  x: mapCoord().optional(),
  y: mapCoord().optional(),
  tid: z.number().int().min(1).optional(),
  class: classArg.optional(),
};

/** Exactly one complete point, tid or class, with tool-local fields left out. */
export function toWaypoint(w: z.infer<z.ZodObject<typeof waypointFields>>): Waypoint | undefined {
  const forms = [w.x !== undefined || w.y !== undefined, w.tid !== undefined, w.class !== undefined];
  if (!exactlyOneForm(forms)) return undefined;
  if (w.x !== undefined && w.y !== undefined) return { x: w.x, y: w.y };
  if (w.tid !== undefined) return { tid: w.tid };
  return w.class === undefined ? undefined : { class: w.class };
}
