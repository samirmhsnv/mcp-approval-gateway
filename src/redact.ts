/**
 * Secret redaction for anything a human or a log file will see.
 *
 * Two layers:
 *  1. Key-based: object properties whose *name* looks sensitive (password, token, apiKey, ...)
 *     have their value replaced entirely.
 *  2. Pattern-based: free text is scanned for well-known secret shapes (connection-string
 *     credentials, bearer tokens, provider key prefixes, JWTs, PEM blocks, `password=...`).
 *
 * Redaction is best effort. It reduces accidental exposure; it is not a data-loss-prevention
 * system. See "Security notes" in the README.
 */

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|authorization|auth[-_]?header|cookie|session[-_]?id|credential|dsn|connection[-_]?string)/i;

interface Rule {
  pattern: RegExp;
  replace: string | ((match: string, ...groups: string[]) => string);
}

const RULES: Rule[] = [
  // PEM private keys (multi-line).
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  // Credentials embedded in URLs: scheme://user:secret@host -> scheme://user:[REDACTED]@host
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@/]+)@/gi,
    replace: (_m, scheme: string, user: string) => `${scheme}${user}:${REDACTED}@`,
  },
  // Authorization headers / bearer tokens.
  {
    pattern: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replace: (_m, kind: string) => `${kind} ${REDACTED}`,
  },
  // Well-known provider key prefixes.
  { pattern: /\bsk-ant-[A-Za-z0-9_-]{10,}/g, replace: REDACTED }, // Anthropic
  { pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{20,}/g, replace: REDACTED }, // OpenAI-style
  { pattern: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g, replace: REDACTED }, // GitHub
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{30,}/g, replace: REDACTED },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replace: REDACTED }, // Slack
  { pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED }, // AWS access key id
  { pattern: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/g, replace: REDACTED }, // Telegram bot token
  { pattern: /\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{16,}/g, replace: REDACTED }, // Stripe
  // JSON Web Tokens.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replace: REDACTED,
  },
  // SQL: CREATE/ALTER ROLE ... PASSWORD 'secret'
  {
    pattern: /\b(PASSWORD)\s+(E?'(?:[^']|'')*')/gi,
    replace: (_m, kw: string) => `${kw} '${REDACTED}'`,
  },
  // key=value / key: value pairs with a sensitive key name.
  {
    pattern:
      /\b((?:[a-z0-9_-]*?)(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key))(["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi,
    replace: (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`,
  },
];

/** Redact secrets inside a single string. */
export function redactText(input: string): string {
  let out = input;
  for (const rule of RULES) {
    out = out.replace(
      rule.pattern,
      rule.replace as (substring: string, ...args: string[]) => string,
    );
  }
  return out;
}

/** True when an object key name suggests its value is a secret. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/**
 * Deep-redact any JSON-like value. Returns a new value; the input is not mutated.
 * Strings are pattern-scanned, sensitive keys are blanked, cycles are handled.
 */
export function redact<T>(value: T): T {
  return redactInner(value, new WeakSet()) as T;
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactInner(v, seen));
  if (value instanceof Date) return value.toISOString();

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] =
      isSensitiveKey(key) && v !== null && v !== undefined && v !== ""
        ? REDACTED
        : redactInner(v, seen);
  }
  return out;
}
