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

const SECRET_PATTERN = /(bearer\s+|sk-[a-z0-9_-]+|token[=:]\s*)[^\s,}]+/gi;

export function sanitizeReason(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replace(SECRET_PATTERN, "$1[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 512);
}

export function log(record: Omit<LogRecord, "timestamp">): void {
  process.stderr.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
  );
}
