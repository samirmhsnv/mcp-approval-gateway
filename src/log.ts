/**
 * Minimal logger. Always writes to stderr: in a stdio MCP server, stdout belongs to the
 * protocol and any stray byte there corrupts the session.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = (level: LogLevel, message: string, extra?: Record<string, unknown>) => void;

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createStderrLogger(minLevel: LogLevel = "info"): Logger {
  return (level, message, extra) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    process.stderr.write(`[mcp-approval-gateway] ${level}: ${message}${suffix}\n`);
  };
}

export const silentLogger: Logger = () => {};
