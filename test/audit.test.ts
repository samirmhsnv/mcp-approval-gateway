import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JsonlAuditLog, type ToolCallEntry } from "../src/audit.js";
import { Gateway } from "../src/gateway.js";
import { REDACTED } from "../src/redact.js";
import { defineTool } from "../src/tools/types.js";
import { ScriptedApprover } from "./helpers.js";

async function readLines(path: string): Promise<ToolCallEntry[]> {
  const text = await readFile(path, "utf8");
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

describe("JsonlAuditLog", () => {
  it("appends one JSON object per line, in order, creating the directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-audit-"));
    const path = join(dir, "nested", "audit.jsonl");
    const log = new JsonlAuditLog(path);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        log.write({ event: "unauthorized_attempt", ts: "t", callId: `c${i}`, actor: "a" }),
      ),
    );
    const lines = await readLines(path);
    expect(lines.map((l) => l.callId)).toEqual(Array.from({ length: 20 }, (_, i) => `c${i}`));
  });

  it("records reads, approvals and rejections end to end, with secrets redacted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-audit-"));
    const path = join(dir, "audit.jsonl");
    const read = defineTool({
      name: "lookup",
      kind: "read",
      description: "",
      inputSchema: { q: z.string() },
      run: async () => ({ text: "ok" }),
    });
    const write = defineTool({
      name: "mutate",
      kind: "write",
      description: "",
      inputSchema: { dsn: z.string() },
      run: async () => ({ text: "done" }),
    });
    const answers = [
      { approved: true as const, approver: "telegram:111" },
      { approved: false as const, approver: "telegram:111", reason: "not now" },
    ];
    let t = 1_000;
    const gateway = new Gateway({
      tools: [read, write],
      approver: new ScriptedApprover(() => {
        t += 2_500; // simulate the human taking 2.5 s
        return answers.shift() ?? { approved: false, approver: "x", reason: "none" };
      }),
      audit: new JsonlAuditLog(path),
      approvalTimeoutMs: 10_000,
      now: () => t,
    });

    await gateway.call("lookup", { q: "postgres://bob:pw123@db/app" });
    await gateway.call("mutate", { dsn: "postgres://bob:pw123@db/app", reason: "migrate" });
    await gateway.call("mutate", { dsn: "x", reason: "again" });

    const [r, approved, rejected] = await readLines(path);
    expect(r).toMatchObject({
      tool: "lookup",
      decision: "auto",
      approvalLatencyMs: 0,
      outcome: "ok",
    });
    expect(r?.args).toEqual({ q: `postgres://bob:${REDACTED}@db/app` });
    expect(approved).toMatchObject({
      tool: "mutate",
      decision: "approved",
      decidedBy: "telegram:111",
      reason: "migrate",
      approvalLatencyMs: 2_500,
      outcome: "ok",
      args: { dsn: REDACTED },
    });
    expect(typeof approved?.executionMs).toBe("number");
    expect(rejected).toMatchObject({
      decision: "rejected",
      rejectReason: "not now",
      outcome: "rejected",
    });
    expect(rejected?.executionMs).toBeUndefined();
    expect(await readFile(path, "utf8")).not.toContain("pw123");
  });
});
