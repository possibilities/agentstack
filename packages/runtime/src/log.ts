import type { ChildId } from "@agentstack/contracts";

export interface LogRecord {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  component: "daemon" | ChildId | "control";
  event: string;
  generation?: string;
  requestId?: string;
  reason?: string;
  [key: string]: unknown;
}

const MAX_REASON_CHARS = 512;
const MAX_LOG_BYTES = 4096;
const MAX_LOG_DEPTH = 3;
const MAX_COLLECTION_ITEMS = 24;

const AUTHORIZATION_PATTERN = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const TOKEN_PATTERN =
  /\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,})\b/gi;
const ASSIGNMENT_PATTERN =
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|password|secret|token)\s*[=:]\s*)[^\s,;}]+/gi;
const ABSOLUTE_URL_PATTERN = /\bhttps?:\/\/[^\s,}\])]+/gi;
const QUERY_SECRET_PATTERN =
  /([?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|credential|password|secret|token)=)[^&\s,}\])]+/gi;

function safeLogLevel(value: unknown): LogRecord["level"] {
  return value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error"
    ? value
    : "error";
}

function safeLogComponent(value: unknown): LogRecord["component"] {
  return value === "daemon" ||
    value === "codex" ||
    value === "fx" ||
    value === "control"
    ? value
    : "daemon";
}

export function sanitizeReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(AUTHORIZATION_PATTERN, "Bearer [redacted]")
    .replace(TOKEN_PATTERN, "[redacted]")
    .replace(ABSOLUTE_URL_PATTERN, "[url-redacted]")
    .replace(ASSIGNMENT_PATTERN, "$1[redacted]")
    .replace(QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, MAX_REASON_CHARS);
}

function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean")
    return value;
  if (typeof value === "string" || value instanceof Error)
    return sanitizeReason(value);
  if (depth >= MAX_LOG_DEPTH) return "[truncated]";
  if (Array.isArray(value))
    return value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((entry) => sanitizeLogValue(entry, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(
      0,
      MAX_COLLECTION_ITEMS,
    ))
      result[key] = sanitizeLogValue(entry, depth + 1);
    return result;
  }
  return sanitizeReason(value);
}

export function log(record: Omit<LogRecord, "timestamp">): void {
  const timestamp = new Date().toISOString();
  const sanitized = sanitizeLogValue({ timestamp, ...record });
  let line = JSON.stringify(sanitized);
  if (Buffer.byteLength(line) > MAX_LOG_BYTES) {
    line = JSON.stringify({
      timestamp,
      level: safeLogLevel(record.level),
      component: safeLogComponent(record.component),
      event: "log_record_truncated",
      reason: "log_record_truncated",
    });
  }
  process.stderr.write(`${line}\n`);
}
