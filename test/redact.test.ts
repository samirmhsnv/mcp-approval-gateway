import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactText } from "../src/redact.js";

describe("redactText", () => {
  it.each([
    [
      "postgres://app:s3cr3t@db.example.com:5432/shop",
      `postgres://app:${REDACTED}@db.example.com:5432/shop`,
    ],
    ["Authorization: Bearer abcdef1234567890xyz", `Authorization: Bearer ${REDACTED}`],
    ["key sk-ant-api03-AbCdEfGhIjKlMnOp", `key ${REDACTED}`],
    ["token ghp_0123456789abcdefghijklmnopqrstuvwxyz", `token ${REDACTED}`],
    ["aws AKIAIOSFODNN7EXAMPLE here", `aws ${REDACTED} here`],
    ["bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ", `bot ${REDACTED}`],
    ["password=hunter2 user=bob", `password=${REDACTED} user=bob`],
    ['{"api_key": "abc123"}', `{"api_key": "${REDACTED}"}`],
    ["ALTER ROLE app PASSWORD 'topsecret'", `ALTER ROLE app PASSWORD '${REDACTED}'`],
  ])("redacts %s", (input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(redactText(`session ${jwt}`)).toBe(`session ${REDACTED}`);
  });

  it("redacts PEM private keys", () => {
    const pem =
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\nkqhkiG9w0BAQEF\n-----END PRIVATE KEY-----";
    expect(redactText(`key:\n${pem}\nend`)).toBe(`key:\n${REDACTED}\nend`);
  });

  it("leaves ordinary text and SQL alone", () => {
    const sql = "UPDATE orders SET status = 'shipped' WHERE id = 42";
    expect(redactText(sql)).toBe(sql);
    expect(redactText("https://example.com/docs")).toBe("https://example.com/docs");
  });
});

describe("redact (deep)", () => {
  it("blanks sensitive keys and scans nested strings without mutating input", () => {
    const input = {
      sql: "SELECT 1",
      password: "hunter2",
      nested: {
        apiKey: "xyz",
        note: "conn postgres://u:p@h/db",
        list: ["Bearer abcdefghijklmnop"],
      },
      count: 3,
      empty: null,
    };
    const out = redact(input);
    expect(out).toEqual({
      sql: "SELECT 1",
      password: REDACTED,
      nested: {
        apiKey: REDACTED,
        note: `conn postgres://u:${REDACTED}@h/db`,
        list: [`Bearer ${REDACTED}`],
      },
      count: 3,
      empty: null,
    });
    expect(input.password).toBe("hunter2");
  });

  it("handles cycles", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(redact(a)).toEqual({ name: "a", self: "[Circular]" });
  });
});
