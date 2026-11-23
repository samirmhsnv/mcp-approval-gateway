import { closeSync, createReadStream, createWriteStream, openSync } from "node:fs";
import { createInterface, type Interface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { formatRequestPlain } from "./format.js";
import type { ApprovalDecision, ApprovalRequest, Approver } from "./types.js";

export interface ConsoleApproverOptions {
  /**
   * Where to read answers from. Defaults to /dev/tty, NOT process.stdin: in an MCP stdio
   * server, stdin/stdout carry the protocol and must never be used for human interaction.
   */
  input?: Readable;
  /** Where to print prompts. Defaults to /dev/tty. */
  output?: Writable;
  /** Identity recorded in the audit log. */
  identity?: string;
}

/**
 * Asks for approval with a y/n prompt on the controlling terminal.
 * Meant for local demos and development, where setting up a Telegram bot is overkill.
 *
 * Answers: `y` / `yes` approves. `n`, `n: <reason>`, an empty line, or anything else rejects.
 * Requests are asked one at a time, in arrival order.
 */
export class ConsoleApprover implements Approver {
  readonly name = "console";
  private readonly options: ConsoleApproverOptions;
  private rl: Interface | undefined;
  private output: Writable | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private ttyFd: number | undefined;

  constructor(options: ConsoleApproverOptions = {}) {
    this.options = options;
  }

  /** Fail fast at startup if there is no terminal to ask on. */
  async start(): Promise<void> {
    this.ensureInterface();
  }

  private ensureInterface(): Interface {
    if (this.rl) return this.rl;
    let { input, output } = this.options;
    if (!input || !output) {
      let fd: number;
      try {
        fd = openSync("/dev/tty", "r+");
      } catch (err) {
        throw new Error(
          `the console approver needs an interactive terminal (/dev/tty): ${(err as Error).message}`,
        );
      }
      this.ttyFd = fd;
      input ??= createReadStream("/dev/tty", { fd, autoClose: false });
      output ??= createWriteStream("/dev/tty", { fd, autoClose: false });
    }
    // A broken terminal must never crash the MCP server; pending questions just fail.
    input.on("error", () => this.rl?.close());
    output.on("error", () => this.rl?.close());
    this.output = output;
    this.rl = createInterface({ input, output, terminal: false });
    return this.rl;
  }

  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const run = this.queue.then(() => this.ask(request, signal));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ask(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    const identity = this.options.identity ?? `console:${process.env.USER ?? "local"}`;
    if (signal.aborted) {
      return { approved: false, approver: identity, reason: "timed out before it was shown" };
    }
    const rl = this.ensureInterface();
    this.output?.write(`\n${formatRequestPlain(request)}\n`);
    let answer: string;
    try {
      answer = await rl.question("Approve? [y/N] (or 'n: reason') > ", { signal });
    } catch (err) {
      if (signal.aborted) {
        this.output?.write("\n(no answer, request expired)\n");
        return { approved: false, approver: identity, reason: "timeout" };
      }
      throw err;
    }
    return parseAnswer(answer, identity);
  }

  async stop(): Promise<void> {
    this.rl?.close();
    this.rl = undefined;
    if (this.ttyFd !== undefined) {
      closeSync(this.ttyFd);
      this.ttyFd = undefined;
    }
  }
}

export function parseAnswer(answer: string, approver: string): ApprovalDecision {
  const trimmed = answer.trim();
  if (/^y(es)?$/i.test(trimmed)) return { approved: true, approver };
  const match = /^no?(?:\s*[:,-]\s*|\s+|$)(.*)$/is.exec(trimmed);
  const reason = (match ? match[1] : trimmed)?.trim();
  return { approved: false, approver, reason: reason || "rejected at console" };
}
