import { describe, it, expect } from "vitest";
import { collectUntilSentinel } from "../src/correlation/collector.js";

describe("collectUntilSentinel", () => {
  it("returns lines before the sentinel and marks complete", () => {
    expect(collectUntilSentinel(["a", "b", "__MCPDONE_x__"], "__MCPDONE_x__")).toEqual({
      output: ["a", "b"],
      complete: true,
    });
  });

  it("marks incomplete when the sentinel has not arrived", () => {
    expect(collectUntilSentinel(["a", "b"], "__MCPDONE_x__")).toEqual({
      output: ["a", "b"],
      complete: false,
    });
  });

  it("handles an empty batch", () => {
    expect(collectUntilSentinel([], "__MCPDONE_x__")).toEqual({ output: [], complete: false });
  });

  it("excludes anything at or after the sentinel", () => {
    const res = collectUntilSentinel(["a", "__MCPDONE_x__", "late"], "__MCPDONE_x__");
    expect(res.output).toEqual(["a"]);
    expect(res.complete).toBe(true);
  });
});
