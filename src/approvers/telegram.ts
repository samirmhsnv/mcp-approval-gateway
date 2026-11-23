import { type Logger, silentLogger } from "../log.js";
import { formatArgs } from "./format.js";
import type { ApprovalDecision, ApprovalRequest, Approver, UnauthorizedAttempt } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Bot API client (plain HTTPS + long polling, no framework)
// ---------------------------------------------------------------------------------------------

/** The small slice of the Telegram Bot API this approver needs. */
export interface TelegramApi {
  call<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T>;
}

export class TelegramApiError extends Error {
  override name = "TelegramApiError";
  constructor(
    readonly method: string,
    readonly errorCode: number | undefined,
    description: string,
  ) {
    super(`Telegram ${method} failed: ${description}`);
  }
}

export class BotApiClient implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.telegram.org",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal: signal ?? null,
    });
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: T;
      error_code?: number;
      description?: string;
    };
    if (!body.ok) {
      // Never include the URL in errors: it contains the bot token.
      throw new TelegramApiError(
        method,
        body.error_code ?? res.status,
        body.description ?? "unknown error",
      );
    }
    return body.result as T;
  }
}

// Minimal Telegram types (only the fields we read).
interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}
interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  reply_to_message?: { message_id: number };
}
interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}
export interface TgUpdate {
  update_id: number;
  callback_query?: TgCallbackQuery;
  message?: TgMessage;
}

// ---------------------------------------------------------------------------------------------
// Approver
// ---------------------------------------------------------------------------------------------

export interface TelegramApproverOptions {
  api: TelegramApi;
  /** Numeric Telegram user IDs allowed to decide. Everyone else is ignored (and reported). */
  approverIds: number[];
  /** Chats that receive requests. Defaults to a DM to each approver. */
  chatIds?: number[];
  /** Long-poll timeout passed to getUpdates. */
  pollTimeoutSeconds?: number;
  logger?: Logger;
}

interface Pending {
  request: ApprovalRequest;
  text: string;
  messages: { chatId: number; messageId: number }[];
  settle: (decision: ApprovalDecision) => void;
}

const APPROVE = "a";
const REJECT = "r";

/**
 * Sends each approval request as a Telegram message with inline Approve / Reject buttons.
 *
 * - Only users in `approverIds` can decide. Presses from anyone else get a polite refusal and
 *   are reported through `onUnauthorized` (the gateway writes them to the audit log).
 * - Replying to the request message with text rejects it, using the text as the reason.
 * - The first decision wins; every copy of the message is then edited to show the outcome.
 */
export class TelegramApprover implements Approver {
  readonly name = "telegram";
  onUnauthorized?: (attempt: UnauthorizedAttempt) => void;

  private readonly api: TelegramApi;
  private readonly approverIds: Set<number>;
  private readonly chatIds: number[];
  private readonly pollTimeoutSeconds: number;
  private readonly log: Logger;
  private readonly pending = new Map<string, Pending>();
  private readonly byMessage = new Map<string, string>();
  private offset = 0;
  private polling: AbortController | undefined;
  private loop: Promise<void> | undefined;

  constructor(options: TelegramApproverOptions) {
    if (options.approverIds.length === 0)
      throw new Error("TelegramApprover needs at least one approver id");
    this.api = options.api;
    this.approverIds = new Set(options.approverIds);
    this.chatIds = options.chatIds ?? options.approverIds;
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.log = options.logger ?? silentLogger;
  }

  async start(): Promise<void> {
    if (this.loop) return;
    this.polling = new AbortController();
    this.loop = this.pollLoop(this.polling.signal);
  }

  async stop(): Promise<void> {
    this.polling?.abort();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const text = renderRequest(request);
    const keyboard = {
      inline_keyboard: [
        [
          { text: "✅ Approve", callback_data: `${APPROVE}:${request.id}` },
          { text: "❌ Reject", callback_data: `${REJECT}:${request.id}` },
        ],
      ],
    };

    const sent = await Promise.allSettled(
      this.chatIds.map((chatId) =>
        this.api.call<TgMessage>("sendMessage", {
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard,
          link_preview_options: { is_disabled: true },
        }),
      ),
    );
    const messages: Pending["messages"] = [];
    for (const [i, result] of sent.entries()) {
      if (result.status === "fulfilled") {
        messages.push({ chatId: result.value.chat.id, messageId: result.value.message_id });
      } else {
        this.log("warn", "could not deliver approval request", {
          chatId: this.chatIds[i],
          error: String(result.reason),
        });
      }
    }
    if (messages.length === 0) {
      throw new Error("approval request could not be delivered to any Telegram chat");
    }

    return new Promise<ApprovalDecision>((resolve, reject) => {
      const entry: Pending = {
        request,
        text,
        messages,
        settle: (decision) => {
          cleanup();
          resolve(decision);
        },
      };
      const onAbort = () => {
        cleanup();
        void this.finalize(entry, "⌛ <b>Expired</b>, automatically rejected.");
        reject(signal.reason ?? new Error("aborted"));
      };
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        this.pending.delete(request.id);
        for (const m of messages) this.byMessage.delete(`${m.chatId}:${m.messageId}`);
      };

      this.pending.set(request.id, entry);
      for (const m of messages) this.byMessage.set(`${m.chatId}:${m.messageId}`, request.id);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Process one update from getUpdates. Public so it can be driven directly in tests. */
  async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) await this.handleCallback(update.callback_query);
    else if (update.message?.reply_to_message) await this.handleReply(update.message);
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const [action, requestId] = (query.data ?? "").split(":", 2);
    const entry = requestId ? this.pending.get(requestId) : undefined;

    if (!this.approverIds.has(query.from.id)) {
      this.reportUnauthorized(requestId ?? "unknown", query.from);
      await this.answer(query.id, "You are not on the approver list for this gateway.", true);
      return;
    }
    if (!entry || (action !== APPROVE && action !== REJECT)) {
      await this.answer(query.id, "This request is no longer pending.");
      return;
    }

    const who = describeUser(query.from);
    if (action === APPROVE) {
      entry.settle({ approved: true, approver: `telegram:${query.from.id}` });
      await this.answer(query.id, "Approved");
      await this.finalize(entry, `✅ <b>Approved</b> by ${escapeHtml(who)}`);
    } else {
      const reason = `rejected by ${who}`;
      entry.settle({ approved: false, approver: `telegram:${query.from.id}`, reason });
      await this.answer(query.id, "Rejected");
      await this.finalize(entry, `❌ <b>Rejected</b> by ${escapeHtml(who)}`);
    }
  }

  private async handleReply(message: TgMessage): Promise<void> {
    const replyTo = message.reply_to_message;
    if (!replyTo || !message.from) return;
    const requestId = this.byMessage.get(`${message.chat.id}:${replyTo.message_id}`);
    if (!requestId) return;
    const entry = this.pending.get(requestId);
    if (!entry) return;

    if (!this.approverIds.has(message.from.id)) {
      this.reportUnauthorized(requestId, message.from);
      return;
    }
    const reason = message.text?.trim() || `rejected by ${describeUser(message.from)}`;
    entry.settle({ approved: false, approver: `telegram:${message.from.id}`, reason });
    await this.finalize(
      entry,
      `❌ <b>Rejected</b> by ${escapeHtml(describeUser(message.from))}: ${escapeHtml(reason)}`,
    );
  }

  private reportUnauthorized(requestId: string, user: TgUser): void {
    this.log("warn", "ignored decision from non-approver", { userId: user.id, requestId });
    this.onUnauthorized?.({ requestId, actor: `telegram:${user.id} (${describeUser(user)})` });
  }

  /** Edit every copy of the request to show the outcome and remove the buttons. */
  private async finalize(entry: Pending, outcomeHtml: string): Promise<void> {
    const text = `${entry.text}\n\n${outcomeHtml}`;
    await Promise.allSettled(
      entry.messages.map((m) =>
        this.api.call("editMessageText", {
          chat_id: m.chatId,
          message_id: m.messageId,
          text,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [] },
        }),
      ),
    );
  }

  private async answer(callbackQueryId: string, text: string, showAlert = false): Promise<void> {
    try {
      await this.api.call("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      });
    } catch (err) {
      this.log("debug", "answerCallbackQuery failed", { error: String(err) });
    }
  }

  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoffMs = 1_000;
    while (!signal.aborted) {
      try {
        const updates = await this.api.call<TgUpdate[]>(
          "getUpdates",
          {
            offset: this.offset,
            timeout: this.pollTimeoutSeconds,
            allowed_updates: ["callback_query", "message"],
          },
          signal,
        );
        backoffMs = 1_000;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          await this.handleUpdate(update).catch((err) =>
            this.log("error", "failed to handle update", { error: String(err) }),
          );
        }
      } catch (err) {
        if (signal.aborted) return;
        this.log("warn", "getUpdates failed, retrying", {
          error: String(err),
          retryInMs: backoffMs,
        });
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

const TELEGRAM_LIMIT = 4_096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderRequest(req: ApprovalRequest): string {
  const minutes = Math.max(1, Math.round((req.expiresAt.getTime() - Date.now()) / 60_000));
  const header = [
    `<b>Approval required</b>: <code>${escapeHtml(req.tool)}</code>`,
    `<b>Reason:</b> ${fitEscaped(req.reason, 600)}`,
  ];
  const footer = [
    `Expires in ~${minutes} min, then auto-rejects. ID <code>${escapeHtml(req.id.slice(0, 8))}</code>`,
    "<i>Reply to this message to reject with a reason.</i>",
  ];
  // Leave room for the tags below and for the outcome line appended when the request is decided.
  const budget = TELEGRAM_LIMIT - 400 - header.join("\n").length - footer.join("\n").length;
  // The preview is the exact action (e.g. the SQL), so it replaces the raw argument dump.
  const body = req.preview
    ? `<pre>${fitEscaped(req.preview, budget)}</pre>`
    : `<b>Arguments</b>\n<pre>${fitEscaped(formatArgs(req.args, budget), budget)}</pre>`;
  return [...header, "", body, "", ...footer].join("\n");
}

/** HTML-escape `text`, truncating it so the *escaped* result fits in `budget` characters. */
function fitEscaped(text: string, budget: number): string {
  let raw = text;
  let escaped = escapeHtml(raw);
  while (escaped.length > budget && raw.length > 0) {
    raw = raw.slice(0, Math.floor(raw.length * 0.9));
    escaped = escapeHtml(raw);
  }
  return escaped.length < escapeHtml(text).length ? `${escaped}\n… (truncated)` : escaped;
}

function describeUser(user: TgUser): string {
  if (user.username) return `@${user.username}`;
  return user.first_name ? `${user.first_name} (${user.id})` : String(user.id);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
