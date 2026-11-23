import { describe, expect, it, vi } from "vitest";
import { BotApiClient, type TelegramApi, TelegramApprover } from "../src/approvers/telegram.js";
import type { ApprovalRequest } from "../src/approvers/types.js";

const APPROVER = 111;
const STRANGER = 666;

class FakeTelegram implements TelegramApi {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  private nextMessageId = 100;

  async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    this.calls.push({ method, params });
    if (method === "sendMessage") {
      return { message_id: this.nextMessageId++, chat: { id: params.chat_id } } as T;
    }
    return true as T;
  }

  of(method: string) {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "3f1c2a9e-0000-4000-8000-000000000001",
    tool: "db_execute",
    args: { sql: "UPDATE orders SET status = 'shipped' WHERE id = 7" },
    reason: "Customer confirmed delivery",
    preview: "SQL:\nUPDATE orders SET status = 'shipped' WHERE id = 7",
    expiresAt: new Date(Date.now() + 300_000),
    ...overrides,
  };
}

function setup(chatIds?: number[]) {
  const api = new FakeTelegram();
  const approver = new TelegramApprover({
    api,
    approverIds: [APPROVER],
    ...(chatIds ? { chatIds } : {}),
  });
  const onUnauthorized = vi.fn();
  approver.onUnauthorized = onUnauthorized;
  return { api, approver, onUnauthorized };
}

const press = (userId: number, data: string, username = "user") => ({
  update_id: 1,
  callback_query: { id: `cb-${userId}`, from: { id: userId, username }, data },
});

/** Let the sendMessage microtasks settle so the request is registered as pending. */
const flush = () => new Promise((r) => setImmediate(r));

describe("TelegramApprover", () => {
  it("sends the request with Approve/Reject buttons, HTML-escaped", async () => {
    const { api, approver } = setup();
    void approver.requestApproval(
      request({ reason: "<b>urgent</b> & now" }),
      new AbortController().signal,
    );
    await flush();

    const [msg] = api.of("sendMessage");
    expect(msg?.chat_id).toBe(APPROVER);
    expect(msg?.parse_mode).toBe("HTML");
    expect(msg?.text).toContain("&lt;b&gt;urgent&lt;/b&gt; &amp; now");
    expect(msg?.text).toContain("UPDATE orders SET status = 'shipped' WHERE id = 7");
    expect(msg?.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `a:${request().id}` },
          { text: "❌ Reject", callback_data: `r:${request().id}` },
        ],
      ],
    });
  });

  it("resolves approved when an allowlisted user presses Approve, then edits the message", async () => {
    const { api, approver } = setup();
    const decision = approver.requestApproval(request(), new AbortController().signal);
    await flush();
    await approver.handleUpdate(press(APPROVER, `a:${request().id}`, "alice"));

    await expect(decision).resolves.toEqual({ approved: true, approver: `telegram:${APPROVER}` });
    const [edit] = api.of("editMessageText");
    expect(edit?.text).toContain("Approved</b> by @alice");
    expect(edit?.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("ignores presses from users who are not on the allowlist", async () => {
    const { api, approver, onUnauthorized } = setup();
    let settled = false;
    const decision = approver.requestApproval(request(), new AbortController().signal);
    void decision.then(() => {
      settled = true;
    });
    await flush();

    await approver.handleUpdate(press(STRANGER, `a:${request().id}`, "mallory"));
    await flush();

    expect(settled).toBe(false);
    expect(onUnauthorized).toHaveBeenCalledWith({
      requestId: request().id,
      actor: `telegram:${STRANGER} (@mallory)`,
    });
    expect(api.of("answerCallbackQuery")[0]).toMatchObject({ show_alert: true });
    expect(api.of("editMessageText")).toHaveLength(0);

    // The real approver can still decide afterwards.
    await approver.handleUpdate(press(APPROVER, `r:${request().id}`, "alice"));
    await expect(decision).resolves.toEqual({
      approved: false,
      approver: `telegram:${APPROVER}`,
      reason: "rejected by @alice",
    });
  });

  it("treats a reply to the request message as a rejection with that reason", async () => {
    const { approver } = setup();
    const decision = approver.requestApproval(request(), new AbortController().signal);
    await flush();
    await approver.handleUpdate({
      update_id: 2,
      message: {
        message_id: 200,
        chat: { id: APPROVER },
        from: { id: APPROVER, username: "alice" },
        text: "use the staging table first",
        reply_to_message: { message_id: 100 },
      },
    });
    await expect(decision).resolves.toMatchObject({
      approved: false,
      reason: "use the staging table first",
    });
  });

  it("ignores replies from non-approvers", async () => {
    const { approver, onUnauthorized } = setup([-1001]);
    void approver.requestApproval(request(), new AbortController().signal);
    await flush();
    await approver.handleUpdate({
      update_id: 3,
      message: {
        message_id: 201,
        chat: { id: -1001 },
        from: { id: STRANGER },
        text: "no",
        reply_to_message: { message_id: 100 },
      },
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("marks the message expired and rejects when the signal aborts", async () => {
    const { api, approver } = setup();
    const controller = new AbortController();
    const decision = approver.requestApproval(request(), controller.signal);
    await flush();
    controller.abort(new Error("approval timed out"));

    await expect(decision).rejects.toThrow("approval timed out");
    await flush();
    expect(api.of("editMessageText")[0]?.text).toContain("Expired");

    // A late press is answered but changes nothing.
    await approver.handleUpdate(press(APPROVER, `a:${request().id}`));
    expect(api.of("answerCallbackQuery").at(-1)?.text).toMatch(/no longer pending/);
  });

  it("sends one copy per chat and finalizes all of them", async () => {
    const { api, approver } = setup([10, 20]);
    const decision = approver.requestApproval(request(), new AbortController().signal);
    await flush();
    await approver.handleUpdate(press(APPROVER, `a:${request().id}`));
    await decision;
    expect(api.of("sendMessage").map((m) => m.chat_id)).toEqual([10, 20]);
    expect(api.of("editMessageText").map((m) => m.chat_id)).toEqual([10, 20]);
  });

  it("fails if the request cannot be delivered anywhere", async () => {
    const api: TelegramApi = {
      call: async () => {
        throw new Error("Forbidden: bot was blocked by the user");
      },
    };
    const approver = new TelegramApprover({ api, approverIds: [APPROVER] });
    await expect(approver.requestApproval(request(), new AbortController().signal)).rejects.toThrow(
      /could not be delivered/,
    );
  });
});

describe("BotApiClient", () => {
  it("does not leak the bot token in error messages", async () => {
    const fakeFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: false, error_code: 401, description: "Unauthorized" }), {
          status: 401,
        }),
    );
    const client = new BotApiClient(
      "123456789:SECRET_TOKEN_VALUE",
      "https://tg.test",
      fakeFetch as unknown as typeof fetch,
    );
    const error = await client.call("getMe", {}).catch((e: Error) => e);
    expect(String(error)).toContain("Unauthorized");
    expect(String(error)).not.toContain("SECRET_TOKEN_VALUE");
    expect(fakeFetch).toHaveBeenCalledWith(
      "https://tg.test/bot123456789:SECRET_TOKEN_VALUE/getMe",
      expect.anything(),
    );
  });
});

describe("renderRequest", () => {
  it("stays within Telegram's 4096 character limit for huge inputs", async () => {
    const { renderRequest } = await import("../src/approvers/telegram.js");
    const huge = "<>&".repeat(5_000);
    const text = renderRequest(request({ preview: huge, reason: huge }));
    expect(text.length).toBeLessThan(4_096 - 200);
    expect(text).toContain("(truncated)");
    const noPreview = renderRequest(request({ preview: undefined, args: { blob: huge } }));
    expect(noPreview.length).toBeLessThan(4_096 - 200);
  });
});
