# mcp-approval-gateway

[![CI](https://github.com/samirmhsnv/mcp-approval-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/samirmhsnv/mcp-approval-gateway/actions/workflows/ci.yml)
![Node 22+](https://img.shields.io/badge/node-%3E%3D22-informational)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

**An MCP server that lets an AI agent read your database freely, but holds every write until a human taps Approve on Telegram.**

It works with Claude Code, the Claude Agent SDK, or any other client that speaks the
[Model Context Protocol](https://modelcontextprotocol.io) over stdio.

---

## Why

Agents are useful when they can touch real systems. They are also wrong some of the time,
and a wrong `UPDATE` without a `WHERE` clause is not something you want to explain later.

The usual options are poor:

- **Read-only access.** Safe, but the agent can only tell you what to do and you end up
  copy-pasting SQL yourself.
- **Full access.** Fast, until the first bad write.
- **Approve every action in the agent UI.** Only works while you are sitting at that terminal,
  and you approve reads too, so you stop paying attention.

This gateway takes the middle path:

- **Reads run immediately**, inside a read-only transaction, so the agent can explore and
  answer questions without bothering anyone.
- **Writes wait for a person.** The approver gets a Telegram message with the exact SQL, the
  parameters and the agent's stated reason, and taps Approve or Reject. No answer within the
  timeout means no.
- **Everything is logged** to an append-only JSONL file: what was asked, who decided, how long
  it took, and what happened.

The policy lives in a small config file, not in the prompt, so the agent cannot talk its way
past it.

## How it works

```mermaid
flowchart LR
    Agent["AI agent<br/>(Claude Code, Agent SDK, ...)"]
    subgraph GW["mcp-approval-gateway"]
        Policy{"policy<br/>read or write?"}
        Redact["redact secrets"]
        Approver["Approver<br/>(Telegram / console)"]
        Tools["tools<br/>db_query, db_list_tables, db_execute"]
        Audit[("audit.jsonl")]
    end
    Human(["Human approver<br/>on Telegram"])
    DB[("Postgres")]

    Agent -- "MCP tool call (stdio)" --> Policy
    Policy -- read --> Tools
    Policy -- write --> Redact --> Approver
    Approver <-- "Approve / Reject buttons" --> Human
    Approver -- approved --> Tools
    Approver -. "rejected / timeout" .-> Agent
    Tools --> DB
    Tools -- result --> Agent
    Policy --> Audit
```

A write call, step by step:

```mermaid
sequenceDiagram
    participant A as Agent
    participant G as Gateway
    participant T as Telegram
    participant H as Approver (human)
    participant P as Postgres

    A->>G: db_execute(sql, params, reason)
    G->>G: validate args, redact secrets
    G->>T: sendMessage (SQL, params, reason, buttons)
    T->>H: notification
    H->>T: taps Approve
    T->>G: callback_query (from.id checked against allowlist)
    G->>P: BEGIN; statement; COMMIT
    P-->>G: rowCount
    G->>G: append audit entry
    G-->>A: {"command": "UPDATE", "rowCount": 1}
```

If nobody decides before the timeout, or the approver taps Reject, the tool returns an error
result that starts with `rejected by human:` and the statement never reaches the database.

## Example

The agent is asked: _"Edsger says he paid for his order. Can you check and mark it paid?"_

**1. The agent explores (no approval needed).**

```text
→ db_query
  sql:    SELECT o.id, c.name, b.title, o.status
            FROM orders o JOIN customers c ON c.id = o.customer_id
            JOIN books b ON b.id = o.book_id
           WHERE c.name = $1
  params: ["Edsger Dijkstra"]

← {"columns": ["id","name","title","status"], "rowCount": 1,
   "rows": [{"id": 4, "name": "Edsger Dijkstra",
             "title": "A Philosophy of Software Design", "status": "pending"}]}
```

**2. The agent asks for the write.** The call blocks while the gateway sends this to Telegram:

```text
Approval required: db_execute
Reason: Customer Edsger Dijkstra sent the bank transfer receipt for order 4.

SQL:
UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'

Params:
  $1 = 4

Expires in ~5 min, then auto-rejects. ID 487cff58
Reply to this message to reject with a reason.

        [ ✅ Approve ]   [ ❌ Reject ]
```

**3a. The human taps Approve.** The message is edited to `✅ Approved by @owner` and the agent gets:

```text
← {"command": "UPDATE", "rowCount": 1}
```

**3b. Or the human replies "check the bank statement first".** The agent gets:

```text
← (error) rejected by human: check the bank statement first
```

The write tool's description tells the agent that this means the change did not happen and
that it should not just retry.

**And if the agent tries to sneak a write through the read tool:**

```text
→ db_query  sql: "UPDATE books SET price = 0"
← (error) Database error: cannot execute UPDATE in a read-only transaction
```

## Quickstart

Requirements: Node.js 22+, pnpm (or npm), Docker for the demo database.

```bash
git clone https://github.com/samirmhsnv/mcp-approval-gateway.git
cd mcp-approval-gateway
pnpm install
pnpm build

# Demo Postgres on localhost:54329 with a small bookshop schema and two roles
docker compose up -d
```

### Try it locally without Telegram

The console approver asks `Approve? [y/N]` in your terminal. It reads from `/dev/tty`, not
stdin, because stdin and stdout carry the MCP protocol.

```bash
pnpm demo   # runs examples/demo-client.mjs against examples/gateway.console.json
```

The demo client plays the agent: it reads pending orders, tries (and fails) to write through
`db_query`, and then asks to mark an order as paid, which prompts you in the terminal.

### Use Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Find your numeric user ID (for example with [@userinfobot](https://t.me/userinfobot)).
3. Open a chat with your bot and press **Start**. Bots cannot message you first.
4. Put your ID in `approverIds` in [`examples/gateway.config.json`](examples/gateway.config.json).
5. Run:

```bash
export TELEGRAM_BOT_TOKEN=...   # from BotFather
pnpm demo examples/gateway.config.json
```

### Register it in Claude Code

Either use the CLI:

```bash
claude mcp add approval-gateway \
  -e DATABASE_URL=postgres://gateway_reader:reader@localhost:54329/demo \
  -e DATABASE_WRITE_URL=postgres://gateway_writer:writer@localhost:54329/demo \
  -e TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  -- node /absolute/path/to/mcp-approval-gateway/dist/index.js \
     --config /absolute/path/to/mcp-approval-gateway/examples/gateway.config.json
```

or commit a project-level `.mcp.json` like [`examples/claude-code.mcp.json`](examples/claude-code.mcp.json).

Approvals can take minutes. If your client gives up on long tool calls, raise its timeout
above `approval.timeoutSeconds` (in Claude Code, the `MCP_TOOL_TIMEOUT` environment variable,
in milliseconds).

Inside Claude Code, use the Telegram approver. Claude Code owns the terminal, so the console
approver is only for standalone demos like `pnpm demo`.

### Use it from the Claude Agent SDK

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Mark order 4 as paid if the customer has a pending order.",
  options: {
    mcpServers: {
      "approval-gateway": {
        command: "node",
        args: ["/path/to/dist/index.js", "--config", "/path/to/gateway.config.json"],
        env: { DATABASE_URL: "...", DATABASE_WRITE_URL: "...", TELEGRAM_BOT_TOKEN: "..." },
      },
    },
    allowedTools: ["mcp__approval-gateway__db_query", "mcp__approval-gateway__db_execute"],
  },
})) {
  if (message.type === "result") console.log(message.result);
}
```

Allowing `db_execute` in the SDK is fine here: the human check happens in the gateway, not in
the agent's permission prompt.

## Configuration

The gateway reads `gateway.config.json` from the working directory, or the path given with
`--config` / `GATEWAY_CONFIG`. The file is validated with [zod](https://zod.dev) at startup.
Unknown keys, unknown tool names and unsafe combinations stop the server with a clear message.
A JSON Schema for editor autocomplete is in [`gateway.config.schema.json`](gateway.config.schema.json).

```json
{
  "$schema": "./gateway.config.schema.json",
  "tools": { "db_query": "read", "db_list_tables": "read", "db_execute": "write" },
  "approval": { "approver": "telegram", "timeoutSeconds": 300 },
  "telegram": { "botTokenEnv": "TELEGRAM_BOT_TOKEN", "approverIds": [123456789] },
  "postgres": {
    "readUrlEnv": "DATABASE_URL",
    "writeUrlEnv": "DATABASE_WRITE_URL",
    "statementTimeoutMs": 5000,
    "maxRows": 200,
    "maxAffectedRows": 50
  },
  "audit": { "path": "./audit.jsonl" }
}
```

| Key                           | Default                    | Meaning                                                                                                                 |
| ----------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `tools.<name>`                | the tool's built-in kind   | `read` runs directly, `write` needs approval, `disabled` hides the tool. A tool that writes can never be set to `read`. |
| `approval.approver`           | `telegram`                 | `telegram` or `console`.                                                                                                |
| `approval.timeoutSeconds`     | `300`                      | Pending requests are rejected after this long.                                                                          |
| `telegram.botTokenEnv`        | `TELEGRAM_BOT_TOKEN`       | Name of the env var holding the bot token. The token is never stored in the config.                                     |
| `telegram.approverIds`        | required                   | Telegram user IDs allowed to approve or reject. Everyone else is ignored and logged.                                    |
| `telegram.chatIds`            | the approver IDs           | Where requests are sent. Use a group ID to share requests with a team.                                                  |
| `telegram.apiBaseUrl`         | `https://api.telegram.org` | For a self-hosted Bot API server or tests.                                                                              |
| `postgres.readUrlEnv`         | `DATABASE_URL`             | Env var with the connection string for reads.                                                                           |
| `postgres.writeUrlEnv`        | same as read               | Env var with the connection string for approved writes.                                                                 |
| `postgres.statementTimeoutMs` | `5000`                     | `SET LOCAL statement_timeout` for every statement.                                                                      |
| `postgres.maxRows`            | `200`                      | `db_query` returns at most this many rows and says when it truncated.                                                   |
| `postgres.maxAffectedRows`    | none                       | `db_execute` rolls back if the statement changes more rows than this.                                                   |
| `audit.path`                  | `./audit.jsonl`            | Append-only log. Relative to the config file.                                                                           |

### Built-in tools

| Tool             | Kind  | What it does                                                                                                       |
| ---------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `db_query`       | read  | One SQL statement in `BEGIN TRANSACTION READ ONLY`, with a statement timeout and row limit. Always rolled back.    |
| `db_list_tables` | read  | Tables and columns in a schema, from `information_schema`.                                                         |
| `db_execute`     | write | One SQL statement in its own transaction, after approval. Takes a required `reason`. Optional affected-rows limit. |

Write tools get an extra required `reason` argument. It is shown to the approver and stored in
the audit log.

### Audit log

One JSON object per line. Secrets are redacted before anything is written.

```json
{"event":"tool_call","ts":"2026-11-23T04:47:03.105Z","callId":"487cff58-cc72-4701-936a-4ddce5ac30b0","tool":"db_execute","mode":"write","args":{"sql":"UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending'","params":[4]},"reason":"Customer Edsger Dijkstra sent the bank transfer receipt for order 4.","decision":"approved","decidedBy":"telegram:123456789","approvalLatencyMs":736,"executionMs":4,"outcome":"ok"}
{"event":"unauthorized_attempt","ts":"2026-11-23T04:47:03.402Z","callId":"487cff58-cc72-4701-936a-4ddce5ac30b0","actor":"telegram:999 (@mallory)"}
```

`decision` is one of `auto` (reads), `approved`, `rejected` or `timeout`. `outcome` is `ok`,
`error` or `rejected`.

## Adding your own tools

The gateway is not tied to Postgres. Any function can be put behind the same policy and
approval flow (the package is not on npm yet; install it from git or import from `dist/`):

```ts
import {
  createMcpServer,
  defineTool,
  Gateway,
  JsonlAuditLog,
  TelegramApprover,
  BotApiClient,
} from "mcp-approval-gateway";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const refund = defineTool({
  name: "issue_refund",
  kind: "write",
  description: "Refund a payment.",
  inputSchema: { paymentId: z.string(), amountCents: z.number().int().positive() },
  preview: ({ paymentId, amountCents }) => `Refund ${amountCents / 100} EUR on ${paymentId}`,
  run: async ({ paymentId, amountCents }) => ({
    text: await payments.refund(paymentId, amountCents),
  }),
});

const approver = new TelegramApprover({
  api: new BotApiClient(process.env.TELEGRAM_BOT_TOKEN!),
  approverIds: [123456789],
});
const gateway = new Gateway({
  tools: [refund],
  approver,
  audit: new JsonlAuditLog("./audit.jsonl"),
  approvalTimeoutMs: 5 * 60_000,
});

await approver.start();
await createMcpServer(gateway).connect(new StdioServerTransport());
```

To use another approval channel (Slack, email, a web page), implement the `Approver`
interface: one `requestApproval(request, signal)` method that resolves with a decision.

## Security notes

What the gateway does:

- **Policy outside the model.** Which tools need approval is decided by the config file. The
  agent's arguments cannot change it, and a write tool cannot be configured as a read tool.
- **Read-only transactions.** `db_query` runs in `BEGIN TRANSACTION READ ONLY` and is always
  rolled back.
- **One statement per call.** Queries are sent with the extended query protocol, which
  Postgres refuses to run with more than one statement. This blocks `SELECT 1; COMMIT; DELETE ...`.
- **Fail closed.** Timeout, an unreachable Telegram, or a crashed approver all mean "rejected".
- **Allowlisted approvers.** Button presses and replies are checked against `approverIds`
  (Telegram's `from.id`, which a user cannot forge). Others get a "not an approver" notice
  and are logged as `unauthorized_attempt`.
- **The approver sees what runs.** The message shows the exact SQL text and parameters the
  database will receive.
- **Redaction.** Connection-string passwords, bearer tokens, common API key formats
  (Anthropic, OpenAI, GitHub, Slack, AWS, Stripe, Telegram), JWTs, PEM private keys,
  `password=...` pairs and `PASSWORD '...'` in SQL are masked in approval messages and the
  audit log. Object keys such as `password`, `token` or `apiKey` are masked whatever their value.
- **Secrets stay in the environment.** The config file holds env var names, not values, and
  the bot token never appears in error messages.

Honest limits:

- **Use database roles too.** The gateway is one layer. Point `readUrlEnv` at a role with only
  `SELECT` and `default_transaction_read_only = on`, and `writeUrlEnv` at a role without DDL
  rights. `docker/init/03-roles.sql` shows both. Read-only transactions do not stop every side
  effect: functions such as `pg_terminate_backend()`, `dblink`, or anything `SECURITY DEFINER`
  can still act, which is what role permissions are for.
- **Reads are not filtered.** Anything the read role can `SELECT`, the agent can see, and so can
  the model provider. Keep sensitive tables out of reach with grants, views or row-level security.
- **`maxRows` truncates after fetching.** A huge result is still read into memory before it is
  cut. The statement timeout is the real guard.
- **Redaction is pattern-based.** It catches common formats, not every secret. A secret inside an
  `INSERT` value is shown masked, which also means the approver cannot check it.
- **The approver approves text, not intent.** A plausible reason with a subtly wrong `WHERE`
  clause is still the approver's call. `maxAffectedRows` limits the damage of a bad one.
- **Telegram is the trust anchor.** Whoever controls an approver's Telegram account can approve
  writes. Turn on two-step verification for that account.
- **One process per bot token.** Telegram long polling allows a single consumer per bot. Run one
  gateway per bot, or use separate bots.
- **Pending approvals live in memory.** If the gateway restarts, pending requests are lost and
  the agent's call fails. Nothing is executed.
- **The audit log is append-only by convention.** It is a plain file. Ship it somewhere you trust
  (or use `chattr +a`) if you need tamper evidence.

## Development

```bash
pnpm install
pnpm typecheck   # tsc, strict mode
pnpm lint        # biome
pnpm test        # vitest, no network, Telegram or Postgres needed
pnpm build
pnpm schema      # regenerate gateway.config.schema.json after changing src/config.ts
```

```text
src/
  index.ts            CLI entry: load config, build pools, approver, gateway, start stdio server
  server.ts           registers gateway tools on an MCP server
  gateway.ts          policy, approval flow, timeout, audit
  config.ts           zod schema for gateway.config.json
  redact.ts           secret redaction
  audit.ts            JSONL audit log
  approvers/          Approver interface, TelegramApprover, ConsoleApprover
  tools/postgres.ts   db_query, db_list_tables, db_execute
test/                 vitest suites (fake pg pool, fake Telegram API, in-memory MCP client)
docker/init/          demo schema, seed data and database roles
examples/             configs, Claude Code .mcp.json, scripted demo client
```

## Roadmap

- YAML config support
- Approval with edits: let the approver adjust a statement (for example add a `LIMIT`) before running it
- `EXPLAIN` estimate of affected rows in the approval message
- Two-person rule: require N approvals for selected tools
- Slack and web approvers
- Proxy mode: put any existing MCP server behind the gateway and gate its tools by name
- Streamable HTTP transport
- Signed, hash-chained audit log

## License

[MIT](LICENSE) © 2026 Samir Mammadhasanov
