import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/**
 * How the gateway treats a tool:
 *  - "read":     runs immediately, no human involved
 *  - "write":    blocks until an allowlisted human approves (or the request times out)
 *  - "disabled": not exposed to the agent at all
 */
export const ToolMode = z.enum(["read", "write", "disabled"]);
export type ToolMode = z.infer<typeof ToolMode>;

const TelegramConfig = z
  .object({
    /** Name of the env var holding the bot token. The token itself never lives in the config file. */
    botTokenEnv: z.string().min(1).default("TELEGRAM_BOT_TOKEN"),
    /** Telegram numeric user IDs allowed to press Approve / Reject. */
    approverIds: z
      .array(z.number().int().positive())
      .min(1, "at least one approver id is required"),
    /** Chats that receive approval requests. Defaults to a direct message to every approver. */
    chatIds: z.array(z.number().int()).min(1).optional(),
    /** Base URL of the Bot API (override for tests or a self-hosted Bot API server). */
    apiBaseUrl: z.url().default("https://api.telegram.org"),
  })
  .strict();

const PostgresConfig = z
  .object({
    /** Env var with the connection string for read-only queries (db_query). */
    readUrlEnv: z.string().min(1).default("DATABASE_URL"),
    /** Env var with the connection string for approved writes (db_execute). Defaults to readUrlEnv. */
    writeUrlEnv: z.string().min(1).optional(),
    /** Per-statement timeout applied with SET LOCAL statement_timeout. */
    statementTimeoutMs: z.number().int().positive().default(5_000),
    /** db_query returns at most this many rows; the rest is reported as truncated. */
    maxRows: z.number().int().positive().default(200),
    /** db_execute rolls back if it would affect more rows than this. Unset = no limit. */
    maxAffectedRows: z.number().int().positive().optional(),
  })
  .strict();

export const GatewayConfigSchema = z
  .object({
    $schema: z.string().optional(),
    /** Per-tool policy. Tools not listed here fall back to their built-in default mode. */
    tools: z.record(z.string(), ToolMode).default({}),
    approval: z
      .object({
        approver: z.enum(["telegram", "console"]).default("telegram"),
        /** Pending approvals auto-reject after this long. */
        timeoutSeconds: z.number().int().positive().max(86_400).default(300),
      })
      .strict()
      .prefault({}),
    telegram: TelegramConfig.optional(),
    postgres: PostgresConfig.optional(),
    audit: z
      .object({
        /** Append-only JSONL file. Relative paths resolve against the config file's directory. */
        path: z.string().min(1).default("./audit.jsonl"),
      })
      .strict()
      .prefault({}),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (cfg.approval.approver === "telegram" && !cfg.telegram) {
      ctx.addIssue({
        code: "custom",
        path: ["telegram"],
        message: 'approval.approver is "telegram" but no "telegram" section was provided',
      });
    }
  });

export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Validate an already-parsed config object. Throws ConfigError with readable messages. */
export function parseConfig(raw: unknown): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${path}: ${issue.message}`;
    });
    throw new ConfigError(`Invalid gateway config:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** Read, parse and validate a JSON config file. Resolves relative paths against its directory. */
export async function loadConfig(path: string): Promise<GatewayConfig> {
  const absolute = resolve(path);
  let text: string;
  try {
    text = await readFile(absolute, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read config file ${absolute}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Config file ${absolute} is not valid JSON: ${(err as Error).message}`);
  }
  const config = parseConfig(raw);
  config.audit.path = resolve(dirname(absolute), config.audit.path);
  return config;
}
