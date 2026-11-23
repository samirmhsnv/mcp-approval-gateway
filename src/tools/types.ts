import type { z } from "zod";

export interface ToolResult {
  /** Text returned to the agent (usually JSON). */
  text: string;
  isError?: boolean;
}

/**
 * A tool the gateway can expose. `kind` describes what the tool inherently does; the policy
 * file decides how it is exposed, but can never downgrade a "write" tool to "read".
 */
export interface GatewayTool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  kind: "read" | "write";
  inputSchema: Shape;
  /**
   * Human-oriented rendering of exactly what will run, shown to the approver.
   * Receives already-redacted arguments.
   */
  preview?: (args: z.infer<z.ZodObject<Shape>>) => string;
  run: (args: z.infer<z.ZodObject<Shape>>) => Promise<ToolResult>;
}

/** Identity helper that gives full type inference when defining a tool. */
export function defineTool<Shape extends z.ZodRawShape>(
  tool: GatewayTool<Shape>,
): GatewayTool<Shape> {
  return tool;
}

/** Type-erased tool, for collections of tools with different shapes. */
// biome-ignore lint/suspicious/noExplicitAny: erasing the generic is intentional here
export type AnyGatewayTool = GatewayTool<any>;
