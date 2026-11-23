// Public API for embedding the gateway in your own MCP server or agent process.
export { ConsoleApprover, type ConsoleApproverOptions } from "./approvers/console.js";
export {
  BotApiClient,
  type TelegramApi,
  TelegramApprover,
  type TelegramApproverOptions,
} from "./approvers/telegram.js";
export type {
  ApprovalDecision,
  ApprovalRequest,
  Approver,
  UnauthorizedAttempt,
} from "./approvers/types.js";
export {
  type AuditEntry,
  type AuditSink,
  JsonlAuditLog,
  MemoryAuditLog,
  type ToolCallEntry,
} from "./audit.js";
export {
  ConfigError,
  type GatewayConfig,
  GatewayConfigSchema,
  loadConfig,
  parseConfig,
} from "./config.js";
export { Gateway, type GatewayOptions } from "./gateway.js";
export { REDACTED, redact, redactText } from "./redact.js";
export { createMcpServer } from "./server.js";
export { createPostgresTools, type PostgresToolsOptions, type SqlPool } from "./tools/postgres.js";
export {
  type AnyGatewayTool,
  defineTool,
  type GatewayTool,
  type ToolResult,
} from "./tools/types.js";
