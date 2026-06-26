import { describe, it, expect } from "vitest";
import { makeSentinel, withSentinel, lineContainsSentinel } from "../src/correlation/sentinel.js";

describe("sentinel", () => {
  it("creates a unique-looking marker from an id", () => {
    expect(makeSentinel("a1")).toBe("__MCPDONE_a1__");
  });

  it("appends an echo of the sentinel to a command", () => {
    expect(withSentinel("summon Imp", "__MCPDONE_a1__")).toBe("summon Imp ; echo __MCPDONE_a1__");
  });

  it("detects the sentinel within a console line", () => {
    expect(lineContainsSentinel("__MCPDONE_a1__", "__MCPDONE_a1__")).toBe(true);
    expect(lineContainsSentinel("some other text", "__MCPDONE_a1__")).toBe(false);
  });
});
