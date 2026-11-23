#!/usr/bin/env node
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pg from "pg";
import { ConsoleApprover } from "./approvers/console.js";
import { BotApiClient, TelegramApprover } from "./approvers/telegram.js";
import type { Approver } from "./approvers/types.js";
import { JsonlAuditLog } from "./audit.js";
import { ConfigError, type GatewayConfig, loadConfig } from "./config.js";
import { Gateway } from "./gateway.js";
import { createStderrLogger, type Logger } from "./log.js";
import { createMcpServer, SERVER_VERSION } from "./server.js";
import { createPostgresTools, type SqlPool } from "./tools/postgres.js";
import type { AnyGatewayTool } from "./tools/types.js";

const HELP = `mcp-approval-gateway ${SERVER_VERSION}

MCP server (stdio) that runs read tools directly and holds every write for human approval.

Usage:
  mcp-approval-gateway [--config <path>]

Options:
  -c, --config <path>  Policy file (default: $GATEWAY_CONFIG or ./gateway.config.json)
  -v, --verbose        Debug logging (stderr)
  -h, --help           Show this help

Environment:
  DATABASE_URL          Postgres connection string (name configurable via postgres.readUrlEnv)
  TELEGRAM_BOT_TOKEN    Bot token (name configurable via telegram.botTokenEnv)
`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      config: { type: "string", short: "c" },
      verbose: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    process.stderr.write(HELP);
    return;
  }

  const log = createStderrLogger(values.verbose ? "debug" : "info");
  const configPath = values.config ?? process.env.GATEWAY_CONFIG ?? "gateway.config.json";
  const config = await loadConfig(configPath);

  const pools: pg.Pool[] = [];
  const tools = buildTools(config, pools, log);
  const approver = buildApprover(config, log);
  const audit = new JsonlAuditLog(config.audit.path);

  const gateway = new Gateway({
    tools,
    policy: config.tools,
    approver,
    audit,
    approvalTimeoutMs: config.approval.timeoutSeconds * 1000,
    logger: log,
  });

  await approver.start?.();
  const server = createMcpServer(gateway);
  await server.connect(new StdioServerTransport());

  const exposed = gateway.listTools().map((t) => `${t.name}(${t.mode})`);
  log(
    "info",
    `ready: approver=${approver.name}, audit=${config.audit.path}, tools=${exposed.join(", ")}`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await approver.stop?.().catch(() => undefined);
    await Promise.allSettled(pools.map((p) => p.end()));
    await server.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
}

function buildTools(config: GatewayConfig, pools: pg.Pool[], log: Logger): AnyGatewayTool[] {
  const pgConfig = config.postgres;
  if (!pgConfig) {
    log("warn", 'no "postgres" section in config; no database tools will be exposed');
    return [];
  }
  const readUrl = requireEnv(pgConfig.readUrlEnv);
  const writeUrl = pgConfig.writeUrlEnv ? requireEnv(pgConfig.writeUrlEnv) : readUrl;

  const makePool = (connectionString: string, label: string) => {
    const pool = new pg.Pool({
      connectionString,
      max: 4,
      application_name: `mcp-approval-gateway:${label}`,
    });
    pool.on("error", (err) =>
      log("error", `postgres pool (${label}) error`, { error: err.message }),
    );
    pools.push(pool);
    return pool;
  };
  const readPool = makePool(readUrl, "read");
  const writePool = writeUrl === readUrl ? readPool : makePool(writeUrl, "write");

  return createPostgresTools({
    // pg.Pool's client accepts `queryMode`, which @types/pg does not declare yet.
    readPool: readPool as unknown as SqlPool,
    writePool: writePool as unknown as SqlPool,
    statementTimeoutMs: pgConfig.statementTimeoutMs,
    maxRows: pgConfig.maxRows,
    ...(pgConfig.maxAffectedRows !== undefined
      ? { maxAffectedRows: pgConfig.maxAffectedRows }
      : {}),
  });
}

function buildApprover(config: GatewayConfig, log: Logger): Approver {
  if (config.approval.approver === "console") {
    log(
      "warn",
      "using the console approver: approvals are asked on this machine's terminal (/dev/tty)",
    );
    return new ConsoleApprover();
  }
  const tg = config.telegram;
  if (!tg)
    throw new ConfigError('telegram section is required when approval.approver is "telegram"');
  return new TelegramApprover({
    api: new BotApiClient(requireEnv(tg.botTokenEnv), tg.apiBaseUrl),
    approverIds: tg.approverIds,
    ...(tg.chatIds ? { chatIds: tg.chatIds } : {}),
    logger: log,
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`environment variable ${name} is not set`);
  return value;
}

main().catch((err: unknown) => {
  const message = err instanceof ConfigError ? err.message : ((err as Error).stack ?? String(err));
  process.stderr.write(`[mcp-approval-gateway] fatal: ${message}\n`);
  process.exit(1);
});
