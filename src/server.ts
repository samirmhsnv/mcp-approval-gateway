import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Gateway } from "./gateway.js";

export const SERVER_NAME = "mcp-approval-gateway";
export const SERVER_VERSION = "0.1.0";

/** Build an MCP server that exposes every non-disabled gateway tool. */
export function createMcpServer(gateway: Gateway): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read tools run immediately. Write tools wait for a human to approve on another channel " +
        "and may take minutes to return. A result starting with 'rejected by human:' means the " +
        "change was not made.",
    },
  );

  for (const tool of gateway.listTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: tool.mode === "read",
          destructiveHint: tool.mode === "write",
          openWorldHint: false,
        },
      },
      async (args: Record<string, unknown>) => {
        const result = await gateway.call(tool.name, args);
        return {
          content: [{ type: "text" as const, text: result.text }],
          ...(result.isError ? { isError: true } : {}),
        };
      },
    );
  }

  return server;
}
