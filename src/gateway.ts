import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ApprovalDecision, Approver } from "./approvers/types.js";
import type { AuditSink, ToolCallEntry } from "./audit.js";
import { ConfigError, type ToolMode } from "./config.js";
import { type Logger, silentLogger } from "./log.js";
import { redact } from "./redact.js";
import type { AnyGatewayTool, ToolResult } from "./tools/types.js";

export interface GatewayOptions {
  tools: AnyGatewayTool[];
  /** Per-tool modes from the policy file. Missing tools use their built-in `kind`. */
  policy?: Record<string, ToolMode>;
  approver: Approver;
  audit: AuditSink;
  approvalTimeoutMs: number;
  logger?: Logger;
  /** Injectable for tests. */
  now?: () => number;
  newId?: () => string;
}

export interface ExposedTool {
  name: string;
  mode: "read" | "write";
  description: string;
  inputSchema: z.ZodRawShape;
}

const reasonSchema = z
  .string()
  .min(1)
  .max(1_000)
  .describe("Why this change is needed, in one or two sentences. Shown to the human approver.");

/**
 * The policy engine. Decides per call whether a tool runs directly or waits for a human,
 * enforces the approval timeout, and records every call in the audit log.
 *
 * It is transport-agnostic: `server.ts` wires it to MCP, tests call it directly.
 */
export class Gateway {
  private readonly tools = new Map<string, { tool: AnyGatewayTool; mode: ToolMode }>();
  private readonly approver: Approver;
  private readonly audit: AuditSink;
  private readonly approvalTimeoutMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(options: GatewayOptions) {
    this.approver = options.approver;
    this.audit = options.audit;
    this.approvalTimeoutMs = options.approvalTimeoutMs;
    this.log = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? randomUUID;

    const policy = options.policy ?? {};
    const known = new Set(options.tools.map((t) => t.name));
    const unknown = Object.keys(policy).filter((name) => !known.has(name));
    if (unknown.length > 0) {
      throw new ConfigError(
        `Policy mentions unknown tool(s): ${unknown.join(", ")}. Known tools: ${[...known].join(", ")}`,
      );
    }
    for (const tool of options.tools) {
      const mode = policy[tool.name] ?? tool.kind;
      if (tool.kind === "write" && mode === "read") {
        throw new ConfigError(
          `Tool "${tool.name}" modifies state and cannot be configured as "read". Use "write" or "disabled".`,
        );
      }
      this.tools.set(tool.name, { tool, mode });
    }

    this.approver.onUnauthorized = (attempt) => {
      void this.record({
        event: "unauthorized_attempt",
        ts: new Date(this.now()).toISOString(),
        callId: attempt.requestId,
        actor: attempt.actor,
      });
    };
  }

  /** Tools visible to the agent, with `reason` added to the schema of write tools. */
  listTools(): ExposedTool[] {
    const out: ExposedTool[] = [];
    for (const { tool, mode } of this.tools.values()) {
      if (mode === "disabled") continue;
      if (mode === "read") {
        out.push({
          name: tool.name,
          mode,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      } else {
        out.push({
          name: tool.name,
          mode,
          description:
            `${tool.description}\n\nRequires human approval before it runs. Always pass a clear \`reason\`. ` +
            `If the result starts with "rejected by human:", the change did NOT happen; do not retry ` +
            "the same call unless the human asks you to.",
          inputSchema: { ...tool.inputSchema, reason: reasonSchema },
        });
      }
    }
    return out;
  }

  async call(name: string, rawArgs: unknown): Promise<ToolResult> {
    const callId = this.newId();
    const startedAt = this.now();
    const entry = this.tools.get(name);
    if (!entry || entry.mode === "disabled") {
      return { isError: true, text: `Unknown or disabled tool: ${name}` };
    }
    const { tool, mode } = entry;

    const schema = z.object(
      mode === "write" ? { ...tool.inputSchema, reason: reasonSchema } : tool.inputSchema,
    );
    const parsed = schema.safeParse(rawArgs ?? {});
    if (!parsed.success) {
      return {
        isError: true,
        text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}`,
      };
    }
    const { reason, ...args } = parsed.data as Record<string, unknown> & { reason?: string };
    const safeArgs = redact(args);

    const base = {
      event: "tool_call" as const,
      ts: new Date(startedAt).toISOString(),
      callId,
      tool: name,
      mode,
      args: safeArgs,
      ...(reason !== undefined ? { reason } : {}),
    };

    // Reads: run directly.
    if (mode === "read") {
      return this.execute(tool, args, {
        ...base,
        decision: "auto",
        decidedBy: "policy",
        approvalLatencyMs: 0,
      });
    }

    // Writes: ask a human first.
    const decision = await this.awaitDecision(callId, tool, safeArgs, reason ?? "");
    const approvalLatencyMs = this.now() - startedAt;

    if (decision.kind !== "approved") {
      const why = decision.reason;
      await this.record({
        ...base,
        decision: decision.kind,
        decidedBy: decision.approver,
        rejectReason: why,
        approvalLatencyMs,
        outcome: "rejected",
      });
      return { isError: true, text: `rejected by human: ${why}` };
    }

    return this.execute(tool, args, {
      ...base,
      decision: "approved",
      decidedBy: decision.approver,
      approvalLatencyMs,
    });
  }

  private async awaitDecision(
    callId: string,
    tool: AnyGatewayTool,
    safeArgs: Record<string, unknown>,
    reason: string,
  ): Promise<
    | { kind: "approved"; approver: string }
    | { kind: "rejected" | "timeout"; approver: string; reason: string }
  > {
    const controller = new AbortController();
    const expiresAt = new Date(this.now() + this.approvalTimeoutMs);
    const timer = setTimeout(
      () => controller.abort(new Error("approval timed out")),
      this.approvalTimeoutMs,
    );

    let preview: string | undefined;
    try {
      preview = tool.preview?.(safeArgs);
    } catch {
      preview = undefined;
    }

    try {
      const decision: ApprovalDecision = await raceAbort(
        this.approver.requestApproval(
          { id: callId, tool: tool.name, args: safeArgs, reason, preview, expiresAt },
          controller.signal,
        ),
        controller.signal,
      );
      if (controller.signal.aborted) {
        return { kind: "timeout", approver: "timeout", reason: this.timeoutReason() };
      }
      return decision.approved
        ? { kind: "approved", approver: decision.approver }
        : { kind: "rejected", approver: decision.approver, reason: decision.reason };
    } catch (err) {
      if (controller.signal.aborted) {
        return { kind: "timeout", approver: "timeout", reason: this.timeoutReason() };
      }
      // Fail closed: if the approval channel breaks, the write does not happen.
      this.log("error", "approval channel failed", { callId, error: String(err) });
      return {
        kind: "rejected",
        approver: this.approver.name,
        reason: `approval channel error (${(err as Error).message}); the change was not made`,
      };
    } finally {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(new Error("decided"));
    }
  }

  private async execute(
    tool: AnyGatewayTool,
    args: Record<string, unknown>,
    partial: Omit<ToolCallEntry, "outcome" | "executionMs" | "error">,
  ): Promise<ToolResult> {
    const execStart = this.now();
    let result: ToolResult;
    try {
      result = await tool.run(args);
    } catch (err) {
      result = { isError: true, text: `Tool ${tool.name} failed: ${(err as Error).message}` };
    }
    await this.record({
      ...partial,
      executionMs: this.now() - execStart,
      outcome: result.isError ? "error" : "ok",
      ...(result.isError ? { error: result.text.slice(0, 1_000) } : {}),
    });
    return result;
  }

  private timeoutReason(): string {
    const seconds = Math.round(this.approvalTimeoutMs / 1000);
    const human = seconds % 60 === 0 && seconds >= 60 ? `${seconds / 60} min` : `${seconds} s`;
    return `no decision within ${human} (timed out, auto-rejected)`;
  }

  private async record(entry: Parameters<AuditSink["write"]>[0]): Promise<void> {
    try {
      await this.audit.write(entry);
    } catch (err) {
      this.log("error", "failed to write audit entry", { error: String(err) });
    }
  }
}

/** Resolve/reject with `promise`, or reject as soon as `signal` aborts, whichever is first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
