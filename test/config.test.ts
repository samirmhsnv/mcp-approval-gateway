import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseConfig } from "../src/config.js";

const minimal = { telegram: { approverIds: [111] } };

describe("parseConfig", () => {
  it("applies defaults", () => {
    const cfg = parseConfig(minimal);
    expect(cfg.approval).toEqual({ approver: "telegram", timeoutSeconds: 300 });
    expect(cfg.telegram?.botTokenEnv).toBe("TELEGRAM_BOT_TOKEN");
    expect(cfg.tools).toEqual({});
    expect(cfg.audit.path).toBe("./audit.jsonl");
  });

  it("fills postgres defaults", () => {
    const cfg = parseConfig({ ...minimal, postgres: {} });
    expect(cfg.postgres).toEqual({
      readUrlEnv: "DATABASE_URL",
      statementTimeoutMs: 5000,
      maxRows: 200,
    });
  });

  it("accepts a full policy", () => {
    const cfg = parseConfig({
      tools: { db_query: "read", db_execute: "write", db_list_tables: "disabled" },
      approval: { approver: "console", timeoutSeconds: 60 },
      postgres: { maxRows: 50, maxAffectedRows: 10, writeUrlEnv: "DATABASE_WRITE_URL" },
      audit: { path: "/var/log/gateway.jsonl" },
    });
    expect(cfg.tools.db_list_tables).toBe("disabled");
    expect(cfg.postgres?.maxAffectedRows).toBe(10);
  });

  it("requires a telegram section when the approver is telegram", () => {
    expect(() => parseConfig({})).toThrow(/telegram/);
  });

  it("rejects unknown modes, unknown keys and bad values with readable paths", () => {
    expect(() => parseConfig({ ...minimal, tools: { db_query: "maybe" } })).toThrow(
      /tools\.db_query/,
    );
    expect(() => parseConfig({ ...minimal, typo: true })).toThrow(ConfigError);
    expect(() => parseConfig({ telegram: { approverIds: [] } })).toThrow(/approverIds/);
    expect(() => parseConfig({ ...minimal, approval: { timeoutSeconds: -1 } })).toThrow(
      /approval\.timeoutSeconds/,
    );
  });
});

describe("loadConfig", () => {
  it("reads JSON and resolves the audit path relative to the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
    const file = join(dir, "gateway.config.json");
    await writeFile(file, JSON.stringify({ ...minimal, audit: { path: "logs/audit.jsonl" } }));
    const cfg = await loadConfig(file);
    expect(cfg.audit.path).toBe(join(dir, "logs/audit.jsonl"));
  });

  it("reports invalid JSON and missing files as ConfigError", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gw-config-"));
    const file = join(dir, "bad.json");
    await writeFile(file, "{ nope");
    await expect(loadConfig(file)).rejects.toThrow(/not valid JSON/);
    await expect(loadConfig(join(dir, "missing.json"))).rejects.toBeInstanceOf(ConfigError);
  });
});
