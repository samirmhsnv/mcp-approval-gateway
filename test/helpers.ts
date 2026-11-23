import type { ApprovalDecision, ApprovalRequest, Approver } from "../src/approvers/types.js";
import type { SqlClient, SqlPool, SqlQuery, SqlResult } from "../src/tools/postgres.js";

/** Approver whose decisions are scripted by the test. */
export class ScriptedApprover implements Approver {
  readonly name = "scripted";
  readonly requests: ApprovalRequest[] = [];
  readonly signals: AbortSignal[] = [];
  onUnauthorized?: Approver["onUnauthorized"];

  constructor(
    private readonly decide: (req: ApprovalRequest) => Promise<ApprovalDecision> | ApprovalDecision,
  ) {}

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    this.requests.push(request);
    this.signals.push(signal);
    return this.decide(request);
  }
}

/** Never answers: used to exercise the timeout path. */
export const neverAnswers = () => new Promise<ApprovalDecision>(() => {});

/** Fake node-postgres pool that records every query and lets the test script results. */
export class FakePool implements SqlPool {
  readonly queries: SqlQuery[] = [];
  released: (boolean | Error | undefined)[] = [];

  constructor(
    private readonly handler: (q: SqlQuery) => SqlResult | Promise<SqlResult> = () => empty(),
  ) {}

  async connect(): Promise<SqlClient> {
    return {
      query: async (q) => {
        this.queries.push(q);
        return this.handler(q);
      },
      release: (destroy) => {
        this.released.push(destroy);
      },
    };
  }

  /** Just the SQL text of each query, in order. */
  get texts(): string[] {
    return this.queries.map((q) => q.text);
  }
}

export function empty(): SqlResult {
  return { rows: [], rowCount: 0 };
}

export function isControl(q: SqlQuery): boolean {
  return /^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(q.text);
}
