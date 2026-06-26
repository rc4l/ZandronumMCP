import { describe, it, expect } from "vitest";
import { NdjsonDecoder, encodeMessage } from "../src/bridge/framing.js";

describe("NdjsonDecoder", () => {
  it("decodes a single complete message", () => {
    const d = new NdjsonDecoder();
    expect(d.push(`{"v":1,"t":"out","text":"hi"}\n`)).toEqual([{ v: 1, t: "out", text: "hi" }]);
  });

  it("reassembles a message split across chunks", () => {
    const d = new NdjsonDecoder();
    expect(d.push(`{"v":1,"t":"out",`)).toEqual([]);
    expect(d.pending).toBeGreaterThan(0);
    expect(d.push(`"text":"hi"}\n`)).toEqual([{ v: 1, t: "out", text: "hi" }]);
  });

  it("decodes multiple messages in one chunk", () => {
    const d = new NdjsonDecoder();
    const msgs = d.push(`{"v":1,"t":"a"}\n{"v":1,"t":"b"}\n`);
    expect(msgs.map((m) => m.t)).toEqual(["a", "b"]);
  });

  it("skips malformed lines without throwing", () => {
    const d = new NdjsonDecoder();
    expect(d.push(`not json\n{"v":1,"t":"ok"}\n`)).toEqual([{ v: 1, t: "ok" }]);
  });

  it("ignores blank lines", () => {
    const d = new NdjsonDecoder();
    expect(d.push(`\n\n`)).toEqual([]);
  });

  it("drops objects without a string type tag", () => {
    const d = new NdjsonDecoder();
    expect(d.push(`{"v":1}\n`)).toEqual([]);
  });

  it("round-trips through encodeMessage", () => {
    const d = new NdjsonDecoder();
    const wire = encodeMessage({ v: 1, t: "cmd", text: "summon X" });
    expect(d.push(wire)).toEqual([{ v: 1, t: "cmd", text: "summon X" }]);
  });
});
