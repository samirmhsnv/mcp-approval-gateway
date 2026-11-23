import { z } from "zod";
import { type AnyGatewayTool, defineTool, type ToolResult } from "./types.js";

// A deliberately small view of node-postgres, so the tools can be unit-tested with a fake.

export interface SqlQuery {
  text: string;
  values?: unknown[];
  /**
   * "extended" forces the extended query protocol even without parameters. Postgres rejects
   * multiple statements in one extended-protocol query, which closes the
   * `SELECT 1; COMMIT; DELETE ...` escape from the read-only transaction.
   */
  queryMode?: "extended";
}

export interface SqlResult {
  rows: Record<string, unknown>[];
  rowCount: number | null;
  command?: string;
  fields?: { name: string }[];
}

export interface SqlClient {
  query(query: SqlQuery): Promise<SqlResult>;
  release(destroy?: boolean | Error): void;
}

export interface SqlPool {
  connect(): Promise<SqlClient>;
}

export interface PostgresToolsOptions {
  /** Pool used for db_query / db_list_tables. Ideally connects as a read-only role. */
  readPool: SqlPool;
  /** Pool used for approved db_execute calls. Defaults to readPool. */
  writePool?: SqlPool;
  statementTimeoutMs: number;
  maxRows: number;
  maxAffectedRows?: number;
}

const sqlParam = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const queryShape = {
  sql: z
    .string()
    .min(1)
    .describe("A single SQL statement. Use $1, $2, ... placeholders for values."),
  params: z.array(sqlParam).optional().describe("Values for $1, $2, ... placeholders."),
};

export function createPostgresTools(options: PostgresToolsOptions): AnyGatewayTool[] {
  const { readPool, statementTimeoutMs, maxRows, maxAffectedRows } = options;
  const writePool = options.writePool ?? readPool;
  if (!Number.isInteger(statementTimeoutMs) || statementTimeoutMs <= 0) {
    throw new Error("statementTimeoutMs must be a positive integer");
  }

  const dbQuery = defineTool({
    name: "db_query",
    kind: "read",
    description:
      "Run a read-only SQL query against Postgres. Executes inside a READ ONLY transaction with a " +
      `statement timeout of ${statementTimeoutMs} ms and returns at most ${maxRows} rows. ` +
      "Only one statement per call. Any attempt to modify data fails.",
    inputSchema: queryShape,
    run: async ({ sql, params }) =>
      inTransaction(readPool, "BEGIN TRANSACTION READ ONLY", statementTimeoutMs, async (client) => {
        const result = await client.query({
          text: sql,
          values: params ?? [],
          queryMode: "extended",
        });
        return { commit: false, result: ok(formatRows(result, maxRows)) };
      }),
  });

  const dbListTables = defineTool({
    name: "db_list_tables",
    kind: "read",
    description:
      "List tables and their columns (name and type) visible to the gateway's database role. " +
      "Use this before writing queries.",
    inputSchema: {
      schema: z.string().min(1).default("public").describe("Schema to inspect."),
    },
    run: async ({ schema }) =>
      inTransaction(readPool, "BEGIN TRANSACTION READ ONLY", statementTimeoutMs, async (client) => {
        const result = await client.query({
          text: `SELECT table_name, column_name, data_type, is_nullable
                   FROM information_schema.columns
                  WHERE table_schema = $1
                  ORDER BY table_name, ordinal_position`,
          values: [schema],
          queryMode: "extended",
        });
        const tables: Record<string, string[]> = {};
        for (const row of result.rows) {
          const table = String(row.table_name);
          const nullable = row.is_nullable === "YES" ? "" : " not null";
          const columns = tables[table] ?? [];
          columns.push(`${row.column_name} ${row.data_type}${nullable}`);
          tables[table] = columns;
        }
        return { commit: false, result: ok(JSON.stringify({ schema, tables }, null, 2)) };
      }),
  });

  const dbExecute = defineTool({
    name: "db_execute",
    kind: "write",
    description:
      "Run a single data-modifying SQL statement (INSERT, UPDATE, DELETE, DDL) against Postgres. " +
      "The exact statement and parameters are shown to a human, who approves or rejects it. " +
      "Runs in its own transaction" +
      (maxAffectedRows
        ? `, and is rolled back if it affects more than ${maxAffectedRows} rows.`
        : "."),
    inputSchema: queryShape,
    preview: ({ sql, params }) => {
      const lines = ["SQL:", sql.trim()];
      if (params && params.length > 0) {
        lines.push("", "Params:", ...params.map((p, i) => `  $${i + 1} = ${JSON.stringify(p)}`));
      }
      return lines.join("\n");
    },
    run: async ({ sql, params }) =>
      inTransaction(writePool, "BEGIN", statementTimeoutMs, async (client) => {
        const result = await client.query({
          text: sql,
          values: params ?? [],
          queryMode: "extended",
        });
        const affected = result.rowCount ?? 0;
        if (maxAffectedRows !== undefined && affected > maxAffectedRows) {
          return {
            commit: false,
            result: {
              isError: true,
              text: `Rolled back: statement affected ${affected} rows, above the configured limit of ${maxAffectedRows}.`,
            },
          };
        }
        const body: Record<string, unknown> = { command: result.command, rowCount: affected };
        if (result.rows.length > 0) body.returning = JSON.parse(formatRows(result, maxRows));
        return { commit: true, result: ok(JSON.stringify(body, null, 2)) };
      }),
  });

  return [dbQuery, dbListTables, dbExecute];
}

/**
 * Check out a client, open a transaction, apply a statement timeout, run `fn`, then COMMIT or
 * ROLLBACK. Always rolls back on error. A client whose rollback fails is destroyed, not reused.
 */
async function inTransaction(
  pool: SqlPool,
  begin: string,
  statementTimeoutMs: number,
  fn: (client: SqlClient) => Promise<{ commit: boolean; result: ToolResult }>,
): Promise<ToolResult> {
  const client = await pool.connect();
  let broken: Error | undefined;
  let open = false;
  try {
    await client.query({ text: begin });
    open = true;
    // statementTimeoutMs is validated as a positive integer, so interpolation is safe here.
    await client.query({ text: `SET LOCAL statement_timeout = ${statementTimeoutMs}` });
    const { commit, result } = await fn(client);
    await client.query({ text: commit ? "COMMIT" : "ROLLBACK" });
    open = false;
    return result;
  } catch (err) {
    return { isError: true, text: `Database error: ${(err as Error).message}` };
  } finally {
    if (open) {
      await client.query({ text: "ROLLBACK" }).catch((err: Error) => {
        broken = err;
      });
    }
    client.release(broken ?? false);
  }
}

function ok(text: string): ToolResult {
  return { text };
}

function formatRows(result: SqlResult, maxRows: number): string {
  const total = result.rows.length;
  const rows = result.rows.slice(0, maxRows);
  return JSON.stringify(
    {
      columns: result.fields?.map((f) => f.name),
      rowCount: total,
      rows,
      ...(total > maxRows
        ? { truncated: true, note: `showing first ${maxRows} of ${total} rows` }
        : {}),
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}
