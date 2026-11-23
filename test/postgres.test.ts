import { describe, expect, it } from "vitest";
import { createPostgresTools } from "../src/tools/postgres.js";
import type { AnyGatewayTool } from "../src/tools/types.js";
import { FakePool, isControl } from "./helpers.js";

function tools(pool: FakePool, extra: { maxAffectedRows?: number; writePool?: FakePool } = {}) {
  const list = createPostgresTools({
    readPool: pool,
    statementTimeoutMs: 1500,
    maxRows: 2,
    ...extra,
  });
  const byName = (name: string) => list.find((t) => t.name === name) as AnyGatewayTool;
  return {
    list,
    query: byName("db_query"),
    execute: byName("db_execute"),
    listTables: byName("db_list_tables"),
  };
}

describe("db_query (read-only enforcement)", () => {
  it("is declared as a read tool and db_execute as a write tool", () => {
    const { query, execute } = tools(new FakePool());
    expect(query.kind).toBe("read");
    expect(execute.kind).toBe("write");
  });

  it("wraps the statement in a READ ONLY transaction with a timeout and always rolls back", async () => {
    const pool = new FakePool((q) =>
      isControl(q)
        ? { rows: [], rowCount: null }
        : { rows: [{ id: 1 }], rowCount: 1, fields: [{ name: "id" }] },
    );
    const res = await tools(pool).query.run({
      sql: "SELECT id FROM orders WHERE id = $1",
      params: [1],
    });

    expect(pool.texts).toEqual([
      "BEGIN TRANSACTION READ ONLY",
      "SET LOCAL statement_timeout = 1500",
      "SELECT id FROM orders WHERE id = $1",
      "ROLLBACK",
    ]);
    expect(pool.texts).not.toContain("COMMIT");
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.text)).toMatchObject({ columns: ["id"], rowCount: 1, rows: [{ id: 1 }] });
  });

  it("forces the extended protocol so stacked statements (e.g. '; COMMIT; DELETE') are rejected by Postgres", async () => {
    const pool = new FakePool();
    await tools(pool).query.run({ sql: "SELECT 1; COMMIT; DELETE FROM orders" });
    const userQuery = pool.queries[2];
    expect(userQuery?.queryMode).toBe("extended");
    expect(userQuery?.values).toEqual([]);
  });

  it("surfaces read-only violations as tool errors and still rolls back", async () => {
    const pool = new FakePool((q) => {
      if (q.text.startsWith("DELETE"))
        throw new Error("cannot execute DELETE in a read-only transaction");
      return { rows: [], rowCount: null };
    });
    const res = await tools(pool).query.run({ sql: "DELETE FROM orders" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("read-only transaction");
    expect(pool.texts.at(-1)).toBe("ROLLBACK");
    expect(pool.released).toEqual([false]);
  });

  it("destroys the connection if rollback itself fails", async () => {
    const pool = new FakePool((q) => {
      if (q.text === "ROLLBACK") throw new Error("connection lost");
      if (!isControl(q)) throw new Error("boom");
      return { rows: [], rowCount: null };
    });
    await tools(pool).query.run({ sql: "SELECT 1" });
    expect(pool.released[0]).toBeInstanceOf(Error);
  });

  it("truncates results to maxRows", async () => {
    const pool = new FakePool((q) =>
      isControl(q)
        ? { rows: [], rowCount: null }
        : { rows: [{ n: 1 }, { n: 2 }, { n: 3 }], rowCount: 3 },
    );
    const body = JSON.parse((await tools(pool).query.run({ sql: "SELECT n FROM t" })).text);
    expect(body.rows).toHaveLength(2);
    expect(body).toMatchObject({ rowCount: 3, truncated: true });
  });
});

describe("db_execute", () => {
  it("commits a successful write and reports the row count", async () => {
    const pool = new FakePool((q) =>
      isControl(q) ? { rows: [], rowCount: null } : { rows: [], rowCount: 1, command: "UPDATE" },
    );
    const res = await tools(pool).execute.run({
      sql: "UPDATE orders SET status = $1 WHERE id = $2",
      params: ["shipped", 7],
    });
    expect(pool.texts).toEqual([
      "BEGIN",
      "SET LOCAL statement_timeout = 1500",
      "UPDATE orders SET status = $1 WHERE id = $2",
      "COMMIT",
    ]);
    expect(JSON.parse(res.text)).toEqual({ command: "UPDATE", rowCount: 1 });
  });

  it("rolls back when more rows than maxAffectedRows would change", async () => {
    const pool = new FakePool((q) =>
      isControl(q) ? { rows: [], rowCount: null } : { rows: [], rowCount: 500, command: "DELETE" },
    );
    const res = await tools(pool, { maxAffectedRows: 10 }).execute.run({
      sql: "DELETE FROM orders",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/affected 500 rows/);
    expect(pool.texts.at(-1)).toBe("ROLLBACK");
    expect(pool.texts).not.toContain("COMMIT");
  });

  it("uses the write pool when one is configured", async () => {
    const readPool = new FakePool();
    const writePool = new FakePool();
    await tools(readPool, { writePool }).execute.run({ sql: "DELETE FROM t WHERE id = 1" });
    expect(readPool.queries).toHaveLength(0);
    expect(writePool.texts).toContain("DELETE FROM t WHERE id = 1");
  });

  it("renders the exact SQL and params for the approver", () => {
    const preview = tools(new FakePool()).execute.preview?.({
      sql: "  UPDATE orders SET status = $1 WHERE id = $2 ",
      params: ["shipped", 7],
    });
    expect(preview).toBe(
      'SQL:\nUPDATE orders SET status = $1 WHERE id = $2\n\nParams:\n  $1 = "shipped"\n  $2 = 7',
    );
  });
});

describe("db_list_tables", () => {
  it("groups columns by table, read-only", async () => {
    const pool = new FakePool((q) =>
      isControl(q)
        ? { rows: [], rowCount: null }
        : {
            rows: [
              { table_name: "orders", column_name: "id", data_type: "integer", is_nullable: "NO" },
              { table_name: "orders", column_name: "note", data_type: "text", is_nullable: "YES" },
            ],
            rowCount: 2,
          },
    );
    const res = await tools(pool).listTables.run({ schema: "public" });
    expect(pool.texts[0]).toBe("BEGIN TRANSACTION READ ONLY");
    expect(JSON.parse(res.text)).toEqual({
      schema: "public",
      tables: { orders: ["id integer not null", "note text"] },
    });
  });
});
