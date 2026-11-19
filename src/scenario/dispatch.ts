/** The registered tools by name, so run_scenario can call one server-side (a live tool without its engine-state note). */
import { z, type ZodRawShape } from "zod";
import { ToolRefusal } from "../types.js";

export { ToolRefusal };

export type ToolArgs = Record<string, unknown>;

/** A tool's reply, the slice of the SDK's CallToolResult a caller reads. */
export interface ToolReply {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

export type ToolHandler<Extra> = (args: ToolArgs, extra: Extra) => Promise<ToolReply>;

/** `args` parsed as the SDK parses a call, defaults applied, except that an unknown key is an error instead of being dropped. */
export function parseArgs(shape: ZodRawShape, args: ToolArgs): { args: ToolArgs } | { error: string } {
  const parsed = z.object(shape).strict().safeParse(args);
  if (parsed.success) return { args: parsed.data };
  return { error: parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ") };
}

export class ToolRegistry<Extra> {
  private readonly tools = new Map<string, { shape: ZodRawShape; handler: ToolHandler<Extra>; refusal?: string }>();

  /** `refusal` says why run_scenario refuses the tool; without one it is callable there. */
  add(name: string, shape: ZodRawShape, handler: ToolHandler<Extra>, refusal?: string): void {
    this.tools.set(name, { shape, handler, refusal });
  }

  /** A tool's input shape; undefined when no tool has that name. */
  shape(name: string): ZodRawShape | undefined {
    return this.tools.get(name)?.shape;
  }

  /** Why run_scenario refuses a tool, if it does. */
  refusal(name: string): string | undefined {
    return this.tools.get(name)?.refusal;
  }

  /** The tools run_scenario refuses, in registration order. */
  refused(): string[] {
    return [...this.tools].filter(([, t]) => t.refusal !== undefined).map(([name]) => name);
  }

  /** Parse `args` and call the tool, throwing for an unknown tool or bad args but returning a ToolRefusal as an error reply. */
  async invoke(name: string, args: ToolArgs, extra: Extra): Promise<ToolReply> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no tool named ${name}`);
    const parsed = parseArgs(tool.shape, args);
    if ("error" in parsed) throw new Error(`${name}: ${parsed.error}`);
    try {
      return await tool.handler(parsed.args, extra);
    } catch (e) {
      if (e instanceof ToolRefusal) return { isError: true, content: [{ type: "text", text: e.message }] };
      throw e;
    }
  }
}
