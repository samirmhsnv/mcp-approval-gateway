// A scripted "agent" that talks to the gateway over stdio, the same way Claude Code does.
// It reads freely, then asks for one write. With the console config, the approval prompt
// appears in this terminal (on /dev/tty, not on the MCP pipe).
//
//   docker compose up -d
//   npm run build
//   node examples/demo-client.mjs                       # console approver
//   node examples/demo-client.mjs examples/gateway.config.json   # Telegram approver
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = process.argv[2] ?? "examples/gateway.console.json";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--config", config],
  env: {
    ...process.env,
    DATABASE_URL:
      process.env.DATABASE_URL ?? "postgres://gateway_reader:reader@localhost:54329/demo",
    DATABASE_WRITE_URL:
      process.env.DATABASE_WRITE_URL ?? "postgres://gateway_writer:writer@localhost:54329/demo",
  },
  stderr: "inherit",
});

const client = new Client({ name: "demo-agent", version: "0.0.0" });
await client.connect(transport);

const show = (label, result) => {
  const text = result.content.map((c) => c.text).join("\n");
  console.log(`\n=== ${label}${result.isError ? " (error)" : ""} ===\n${text}`);
};

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

show(
  "agent reads pending orders",
  await client.callTool({
    name: "db_query",
    arguments: {
      sql: `SELECT o.id, c.name, b.title, o.status
              FROM orders o JOIN customers c ON c.id = o.customer_id JOIN books b ON b.id = o.book_id
             WHERE o.status = $1 ORDER BY o.id`,
      params: ["pending"],
    },
  }),
);

show(
  "agent tries to sneak a write through db_query",
  await client.callTool({
    name: "db_query",
    arguments: { sql: "UPDATE books SET price = 0" },
  }),
);

show(
  "agent asks to mark order 4 as paid (needs approval)",
  await client.callTool(
    {
      name: "db_execute",
      arguments: {
        sql: "UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'",
        params: [4],
        reason: "Customer Edsger Dijkstra sent the bank transfer receipt for order 4.",
      },
    },
    undefined,
    // Approval can take minutes; don't let the client-side request timeout fire first.
    { timeout: 10 * 60 * 1000 },
  ),
);

await client.close();
