import type { ApprovalRequest } from "./types.js";

/** Pretty-print arguments for humans. Long values are truncated so messages stay readable. */
export function formatArgs(args: Record<string, unknown>, maxLength = 2_000): string {
  const text = Object.keys(args).length === 0 ? "(none)" : JSON.stringify(args, null, 2);
  return truncate(text, maxLength);
}

export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n… (${text.length - maxLength} more characters)`;
}

/** Plain-text rendering used by the console approver. */
export function formatRequestPlain(req: ApprovalRequest): string {
  const lines = [
    "──────────────── approval required ────────────────",
    `tool:    ${req.tool}`,
    `call id: ${req.id}`,
    `reason:  ${req.reason}`,
    `expires: ${req.expiresAt.toISOString()}`,
  ];
  // The preview is the exact action (e.g. the SQL), so it replaces the raw argument dump.
  if (req.preview) lines.push("", req.preview);
  else lines.push("", "arguments:", formatArgs(req.args));
  lines.push("────────────────────────────────────────────────────");
  return lines.join("\n");
}
