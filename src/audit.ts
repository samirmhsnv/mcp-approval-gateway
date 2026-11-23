import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.js";

export type Decision = "auto" | "approved" | "rejected" | "timeout";

/** One line in the audit log for every tool call the agent makes. */
export interface ToolCallEntry {
  event: "tool_call";
  ts: string;
  callId: string;
  tool: string;
  mode: "read" | "write" | "disabled";
  args: unknown;
  /** Agent's stated reason (write tools only). */
  reason?: string;
  decision: Decision;
  /** Who decided: "policy" for reads, otherwise the approver identity (e.g. "telegram:123456"). */
  decidedBy: string;
  /** Rejection reason given by the human, or "timeout". */
  rejectReason?: string;
  /** Time spent waiting for a human, in ms. 0 for reads. */
  approvalLatencyMs: number;
  /** Time spent executing the tool itself, in ms. Absent if it never ran. */
  executionMs?: number;
  outcome: "ok" | "error" | "rejected";
  error?: string;
}

/** Someone outside the allowlist tried to decide on a request. */
export interface UnauthorizedAttemptEntry {
  event: "unauthorized_attempt";
  ts: string;
  callId: string;
  actor: string;
}

export type AuditEntry = ToolCallEntry | UnauthorizedAttemptEntry;

/** Anything that can record audit entries. */
export interface AuditSink {
  write(entry: AuditEntry): Promise<void>;
}

/**
 * Append-only JSON Lines audit log.
 *
 * Writes are serialized so concurrent tool calls never interleave partial lines, and every
 * entry passes through redaction before it touches disk.
 */
export class JsonlAuditLog implements AuditSink {
  private queue: Promise<void> = Promise.resolve();
  private dirReady: Promise<unknown> | undefined;

  constructor(private readonly path: string) {}

  write(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify(redact(entry))}\n`;
    this.dirReady ??= mkdir(dirname(this.path), { recursive: true });
    const next = this.queue.then(async () => {
      await this.dirReady;
      await appendFile(this.path, line, { encoding: "utf8", flag: "a" });
    });
    // Keep the chain alive even if one write fails; the caller still sees the error.
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** In-memory sink, handy for tests and embedding. */
export class MemoryAuditLog implements AuditSink {
  readonly entries: AuditEntry[] = [];

  async write(entry: AuditEntry): Promise<void> {
    this.entries.push(redact(entry));
  }
}
