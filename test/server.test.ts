import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { MemoryAuditLog } from "../src/audit.js";
import { Gateway } from "../src/gateway.js";
import { createMcpServer } from "../src/server.js";
import { createPostgresTools } from "../src/tools/postgres.js";
import { FakePool, isControl, ScriptedApprover } from "./helpers.js";

async function connect(decision: { approved: boolean; reason?: string }) {
  const pool = new FakePool((q) =>
    isControl(q)
      ? { rows: [], rowCount: null }
      : { rows: [{ ok: true }], rowCount: 1, command: "UPDATE" },
  );
  const approver = new ScriptedApprover(() =>
    decision.approved
      ? { approved: true, approver: "telegram:111" }
      : { approved: false, approver: "telegram:111", reason: decision.reason ?? "no" },
  );
  const gateway = new Gateway({
    tools: createPostgresTools({ readPool: pool, statementTimeoutMs: 1000, maxRows: 10 }),
    policy: { db_list_tables: "disabled" },
    approver,
    audit: new MemoryAuditLog(),
    approvalTimeoutMs: 5_000,
  });
  const server = createMcpServer(gateway);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, pool, approver };
}

describe("MCP server", () => {
  it("lists tools with annotations and the extra reason field on writes", async () => {
    const { client } = await connect({ approved: true });
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    expect(Object.keys(byName).sort()).toEqual(["db_execute", "db_query"]);
    expect(byName.db_query?.annotations?.readOnlyHint).toBe(true);
    expect(byName.db_execute?.annotations?.destructiveHint).toBe(true);
    expect(byName.db_execute?.inputSchema.required).toEqual(
      expect.arrayContaining(["sql", "reason"]),
    );
  });

  it("returns the rejection to the agent as an error tool result", async () => {
    const { client, pool, approver } = await connect({
      approved: false,
      reason: "not during business hours",
    });
    const result = await client.callTool({
      name: "db_execute",
      arguments: { sql: "DELETE FROM sessions", reason: "cleanup" },
    });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "rejected by human: not during business hours" },
    ]);
    expect(approver.requests[0]?.preview).toContain("DELETE FROM sessions");
    expect(pool.queries).toHaveLength(0);
  });

  it("runs approved writes and reads end to end", async () => {
    const { client, pool } = await connect({ approved: true });
    const write = await client.callTool({
      name: "db_execute",
      arguments: { sql: "UPDATE t SET a = 1", reason: "fix" },
    });
    expect(write.isError).toBeFalsy();
    const read = await client.callTool({ name: "db_query", arguments: { sql: "SELECT 1" } });
    expect(read.isError).toBeFalsy();
    expect(pool.texts).toContain("BEGIN TRANSACTION READ ONLY");
  });
});
