/** What a human sees when asked to approve a write. All fields are already redacted. */
export interface ApprovalRequest {
  /** Unique id of the tool call, shared with the audit log. */
  id: string;
  tool: string;
  /** Redacted tool arguments (excluding `reason`). */
  args: Record<string, unknown>;
  /** Why the agent says it needs this write. */
  reason: string;
  /**
   * Optional human-oriented rendering of exactly what will run, e.g. the SQL statement and
   * its parameters. Shown prominently by approvers.
   */
  preview?: string;
  /** When the request will auto-reject. */
  expiresAt: Date;
}

export type ApprovalDecision =
  | { approved: true; approver: string }
  | { approved: false; approver: string; reason: string };

export interface UnauthorizedAttempt {
  requestId: string;
  /** Identity of whoever tried, e.g. "telegram:42 (@someone)". */
  actor: string;
}

/**
 * A channel that can ask a human to approve or reject a request.
 *
 * Implementations must resolve with a decision, or reject only on infrastructure failure
 * (which the gateway treats as a rejection). When `signal` aborts (timeout or shutdown) the
 * implementation should stop waiting, tidy up any UI it created, and may resolve or reject.
 */
export interface Approver {
  readonly name: string;
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /** Optional hook: called when someone outside the allowlist tries to decide. */
  onUnauthorized?: (attempt: UnauthorizedAttempt) => void;
  /** Start background work (e.g. polling). Called once before the first request. */
  start?(): Promise<void>;
  /** Release resources. */
  stop?(): Promise<void>;
}
