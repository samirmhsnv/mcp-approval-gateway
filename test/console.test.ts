import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ConsoleApprover, parseAnswer } from "../src/approvers/console.js";
import type { ApprovalRequest } from "../src/approvers/types.js";

const req: ApprovalRequest = {
  id: "call-1",
  tool: "db_execute",
  args: { sql: "DELETE FROM sessions" },
  reason: "clear stale sessions",
  preview: "SQL:\nDELETE FROM sessions",
  expiresAt: new Date(Date.now() + 60_000),
};

function setup() {
  const input = new PassThrough();
  const output = new PassThrough();
  let printed = "";
  output.on("data", (chunk) => {
    printed += String(chunk);
  });
  const approver = new ConsoleApprover({ input, output, identity: "console:test" });
  return { input, approver, printed: () => printed };
}

describe("parseAnswer", () => {
  it.each([
    ["y", { approved: true, approver: "me" }],
    ["YES", { approved: true, approver: "me" }],
    ["n", { approved: false, approver: "me", reason: "rejected at console" }],
    ["", { approved: false, approver: "me", reason: "rejected at console" }],
    ["n: wrong table", { approved: false, approver: "me", reason: "wrong table" }],
    ["no, not today", { approved: false, approver: "me", reason: "not today" }],
    ["nope", { approved: false, approver: "me", reason: "nope" }],
  ])("%j", (answer, expected) => {
    expect(parseAnswer(answer, "me")).toEqual(expected);
  });
});

describe("ConsoleApprover", () => {
  it("prints the request and approves on 'y'", async () => {
    const { input, approver, printed } = setup();
    const decision = approver.requestApproval(req, new AbortController().signal);
    await new Promise((r) => setImmediate(r));
    input.write("y\n");
    await expect(decision).resolves.toEqual({ approved: true, approver: "console:test" });
    expect(printed()).toContain("DELETE FROM sessions");
    expect(printed()).toContain("clear stale sessions");
    await approver.stop();
  });

  it("rejects with a timeout reason when the signal aborts", async () => {
    const { approver } = setup();
    const controller = new AbortController();
    const decision = approver.requestApproval(req, controller.signal);
    await new Promise((r) => setImmediate(r));
    controller.abort();
    await expect(decision).resolves.toMatchObject({ approved: false, reason: "timeout" });
    await approver.stop();
  });
});
