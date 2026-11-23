import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MemoryAuditLog, type ToolCallEntry } from "../src/audit.js";
import { ConfigError } from "../src/config.js";
import { Gateway } from "../src/gateway.js";
import { REDACTED } from "../src/redact.js";
import { defineTool } from "../src/tools/types.js";
import { neverAnswers, ScriptedApprover } from "./helpers.js";

const readTool = defineTool({
  name: "lookup",
  kind: "read",
  description: "read something",
  inputSchema: { id: z.number() },
  run: async ({ id }) => ({ text: `found ${id}` }),
});

function makeWriteTool() {
  const run = vi.fn(async ({ sql }: { sql: string; token?: string }) => ({ text: `ran ${sql}` }));
  const tool = defineTool({
    name: "write_thing",
    kind: "write",
    description: "change something",
    inputSchema: { sql: z.string(), token: z.string().optional() },
    preview: ({ sql }) => `SQL:\n${sql}`,
    run,
  });
  return { tool, run };
}

function setup(decide: ConstructorParameters<typeof ScriptedApprover>[0], timeoutMs = 60_000) {
  const { tool, run } = makeWriteTool();
  const approver = new ScriptedApprover(decide);
  const audit = new MemoryAuditLog();
  let id = 0;
  const gateway = new Gateway({
    tools: [readTool, tool],
    approver,
    audit,
    approvalTimeoutMs: timeoutMs,
    newId: () => `call-${++id}`,
  });
  const calls = () => audit.entries.filter((e): e is ToolCallEntry => e.event === "tool_call");
  return { gateway, approver, audit, run, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Gateway policy", () => {
  it("runs read tools directly without asking anyone", async () => {
    const { gateway, approver, calls } = setup(() => ({ approved: true, approver: "x" }));
    const res = await gateway.call("lookup", { id: 7 });
    expect(res).toEqual({ text: "found 7" });
    expect(approver.requests).toHaveLength(0);
    expect(calls()[0]).toMatchObject({
      tool: "lookup",
      mode: "read",
      decision: "auto",
      decidedBy: "policy",
      outcome: "ok",
    });
  });

  it("adds a required `reason` to write tools only", () => {
    const { gateway } = setup(() => ({ approved: true, approver: "x" }));
    const listed = Object.fromEntries(gateway.listTools().map((t) => [t.name, t]));
    expect(Object.keys(listed.lookup?.inputSchema ?? {})).toEqual(["id"]);
    expect(Object.keys(listed.write_thing?.inputSchema ?? {})).toEqual(["sql", "token", "reason"]);
    expect(listed.write_thing?.description).toMatch(/Requires human approval/);
  });

  it("refuses a write call without a reason", async () => {
    const { gateway, approver, run } = setup(() => ({ approved: true, approver: "x" }));
    const res = await gateway.call("write_thing", { sql: "DELETE FROM t" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/reason/);
    expect(approver.requests).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to treat a write tool as read", () => {
    const { tool } = makeWriteTool();
    const make = () =>
      new Gateway({
        tools: [tool],
        policy: { write_thing: "read" },
        approver: new ScriptedApprover(() => ({ approved: true, approver: "x" })),
        audit: new MemoryAuditLog(),
        approvalTimeoutMs: 1000,
      });
    expect(make).toThrow(ConfigError);
  });

  it("rejects policies that name unknown tools", () => {
    expect(
      () =>
        new Gateway({
          tools: [readTool],
          policy: { db_drop_everything: "write" },
          approver: new ScriptedApprover(() => ({ approved: true, approver: "x" })),
          audit: new MemoryAuditLog(),
          approvalTimeoutMs: 1000,
        }),
    ).toThrow(/unknown tool/);
  });

  it("hides disabled tools and refuses to call them", async () => {
    const gateway = new Gateway({
      tools: [readTool],
      policy: { lookup: "disabled" },
      approver: new ScriptedApprover(() => ({ approved: true, approver: "x" })),
      audit: new MemoryAuditLog(),
      approvalTimeoutMs: 1000,
    });
    expect(gateway.listTools()).toEqual([]);
    expect((await gateway.call("lookup", { id: 1 })).isError).toBe(true);
  });
});

describe("Gateway approval flow", () => {
  it("runs an approved write and records who approved it", async () => {
    const { gateway, approver, run, calls } = setup(() => ({
      approved: true,
      approver: "telegram:111",
    }));
    const res = await gateway.call("write_thing", {
      sql: "UPDATE t SET a = 1",
      reason: "fix typo",
    });

    expect(res).toEqual({ text: "ran UPDATE t SET a = 1" });
    expect(run).toHaveBeenCalledWith({ sql: "UPDATE t SET a = 1" });
    expect(approver.requests[0]).toMatchObject({
      id: "call-1",
      tool: "write_thing",
      reason: "fix typo",
      args: { sql: "UPDATE t SET a = 1" },
      preview: "SQL:\nUPDATE t SET a = 1",
    });
    expect(calls()[0]).toMatchObject({
      callId: "call-1",
      mode: "write",
      decision: "approved",
      decidedBy: "telegram:111",
      reason: "fix typo",
      outcome: "ok",
    });
  });

  it("returns 'rejected by human: <reason>' and does not run the tool", async () => {
    const { gateway, run, calls } = setup(() => ({
      approved: false,
      approver: "telegram:111",
      reason: "wrong table",
    }));
    const res = await gateway.call("write_thing", { sql: "DELETE FROM t", reason: "cleanup" });
    expect(res).toEqual({ isError: true, text: "rejected by human: wrong table" });
    expect(run).not.toHaveBeenCalled();
    expect(calls()[0]).toMatchObject({
      decision: "rejected",
      rejectReason: "wrong table",
      outcome: "rejected",
    });
  });

  it("auto-rejects when nobody answers before the timeout", async () => {
    vi.useFakeTimers();
    const { gateway, approver, run, calls } = setup(neverAnswers, 300_000);
    const pending = gateway.call("write_thing", { sql: "DELETE FROM t", reason: "cleanup" });
    await vi.advanceTimersByTimeAsync(299_999);
    expect(approver.signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const res = await pending;

    expect(res.isError).toBe(true);
    expect(res.text).toBe("rejected by human: no decision within 5 min (timed out, auto-rejected)");
    expect(approver.signals[0]?.aborted).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(calls()[0]).toMatchObject({
      decision: "timeout",
      decidedBy: "timeout",
      outcome: "rejected",
      approvalLatencyMs: 300_000,
    });
  });

  it("fails closed when the approval channel errors", async () => {
    const { gateway, run, calls } = setup(() => {
      throw new Error("telegram unreachable");
    });
    const res = await gateway.call("write_thing", { sql: "DELETE FROM t", reason: "cleanup" });
    expect(res.text).toMatch(/^rejected by human: approval channel error \(telegram unreachable\)/);
    expect(run).not.toHaveBeenCalled();
    expect(calls()[0]?.decision).toBe("rejected");
  });

  it("redacts secrets before they reach the approver or the audit log", async () => {
    const { gateway, approver, run, audit } = setup(() => ({ approved: true, approver: "x" }));
    await gateway.call("write_thing", {
      sql: "ALTER ROLE app PASSWORD 'hunter2'",
      token: "abc",
      reason: "rotate",
    });
    expect(approver.requests[0]?.args).toEqual({
      sql: `ALTER ROLE app PASSWORD '${REDACTED}'`,
      token: REDACTED,
    });
    expect(approver.requests[0]?.preview).not.toContain("hunter2");
    expect(JSON.stringify(audit.entries)).not.toContain("hunter2");
    // ...but the tool itself receives the real values.
    expect(run).toHaveBeenCalledWith({ sql: "ALTER ROLE app PASSWORD 'hunter2'", token: "abc" });
  });

  it("records tool failures after approval as outcome=error", async () => {
    const tool = defineTool({
      name: "explode",
      kind: "write",
      description: "fails",
      inputSchema: {},
      run: async () => {
        throw new Error("disk full");
      },
    });
    const audit = new MemoryAuditLog();
    const gateway = new Gateway({
      tools: [tool],
      approver: new ScriptedApprover(() => ({ approved: true, approver: "x" })),
      audit,
      approvalTimeoutMs: 1000,
    });
    const res = await gateway.call("explode", { reason: "test" });
    expect(res).toMatchObject({ isError: true, text: "Tool explode failed: disk full" });
    expect(audit.entries[0]).toMatchObject({
      decision: "approved",
      outcome: "error",
      error: "Tool explode failed: disk full",
    });
  });

  it("audits unauthorized approval attempts reported by the approver", async () => {
    const { approver, audit } = setup(() => ({ approved: true, approver: "x" }));
    approver.onUnauthorized?.({ requestId: "call-9", actor: "telegram:666 (@mallory)" });
    await vi.waitFor(() => expect(audit.entries).toHaveLength(1));
    expect(audit.entries[0]).toMatchObject({
      event: "unauthorized_attempt",
      callId: "call-9",
      actor: "telegram:666 (@mallory)",
    });
  });
});
