import { describe, it, expect } from "vitest";
import { z } from "zod";
import { ToolRefusal, ToolRegistry, parseArgs, type ToolArgs } from "../src/scenario/dispatch.js";

const shape = {
  instance: z.number().int().positive().default(1),
  tics: z.number().int().positive(),
  chunkTics: z.number().int().positive().default(5),
};

describe("parseArgs", () => {
  it("applies the schema's defaults, as the SDK does", () => {
    expect(parseArgs(shape, { tics: 3 })).toEqual({ args: { instance: 1, tics: 3, chunkTics: 5 } });
  });

  it("names each bad arg by its zod path", () => {
    const got = parseArgs({ to: z.object({ x: z.number() }), tics: z.number() }, { to: { x: "a" }, tics: "b" });
    expect(got).toEqual({ error: "to.x: Expected number, received string; tics: Expected number, received string" });
  });

  it("refuses an unknown key instead of dropping it", () => {
    expect(parseArgs(shape, { tics: 3, tic: 5 })).toEqual({ error: "args: Unrecognized key(s) in object: 'tic'" });
  });
});

describe("ToolRegistry", () => {
  function registry() {
    const tools = new ToolRegistry<string>();
    const seen: Array<{ args: ToolArgs; extra: string }> = [];
    tools.add("step", shape, async (args, extra) => {
      seen.push({ args, extra });
      return { content: [{ type: "text", text: "stepped" }] };
    });
    return { tools, seen };
  }

  it("knows each tool's shape by name", () => {
    const { tools } = registry();
    expect(tools.shape("step")).toBe(shape);
    expect(tools.shape("nope")).toBeUndefined();
  });

  it("parses args with the tool's own schema and passes the caller's extra", async () => {
    const { tools, seen } = registry();
    expect(await tools.invoke("step", { tics: 2 }, "progress")).toEqual({ content: [{ type: "text", text: "stepped" }] });
    expect(seen).toEqual([{ args: { instance: 1, tics: 2, chunkTics: 5 }, extra: "progress" }]);
  });

  it("returns a handler's ToolRefusal as an error reply and rethrows anything else", async () => {
    const tools = new ToolRegistry<string>();
    tools.add("refuses", {}, async () => {
      throw new ToolRefusal("time is frozen");
    });
    tools.add("breaks", {}, async () => {
      throw new Error("socket closed");
    });
    expect(await tools.invoke("refuses", {}, "")).toEqual({ isError: true, content: [{ type: "text", text: "time is frozen" }] });
    await expect(tools.invoke("breaks", {}, "")).rejects.toThrow("socket closed");
  });

  it("throws for an unknown tool or bad args, calling nothing", async () => {
    const { tools, seen } = registry();
    await expect(tools.invoke("nope", {}, "")).rejects.toThrow("no tool named nope");
    await expect(tools.invoke("step", { tics: 0 }, "")).rejects.toThrow("step: tics: Number must be greater than 0");
    expect(seen).toEqual([]);
  });
});
