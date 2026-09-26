import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Envelope,
  type ErrorEnvelope,
  type GlobalOptions,
  SCHEMA_VERSION,
} from "./types.js";

/**
 * Where this process's command output goes.
 *
 * Ordinarily stdout. The Package API runs each operation
 * call inside `captureOutput`, which collects what the command would have
 * printed and hands it back as the tool result. Every write in this CLI goes
 * through `writeOut` so that redirection is total rather than mostly.
 *
 * AsyncLocalStorage rather than swapping `process.stdout.write`: a host may
 * have several tool calls in flight, and a global swap would hand one call's
 * output to another.
 */
const capture = new AsyncLocalStorage<string[]>();

export function setCommandExitCode(code: number): void {
  if (capture.getStore() === undefined) process.exitCode = code;
}

export function writeOut(text: string): void {
  const sink = capture.getStore();
  if (sink === undefined) {
    process.stdout.write(text);
    return;
  }
  sink.push(text);
}

/** Run `body`, returning everything it wrote instead of printing it. */
export async function captureOutput(
  body: () => Promise<void>,
): Promise<string> {
  const sink: string[] = [];
  await capture.run(sink, body);
  return sink.join("");
}

export function envelope<T>(
  command: string,
  data: T,
  globals: GlobalOptions,
  readOnly = true,
): Envelope<T> {
  return {
    schema_version: SCHEMA_VERSION,
    ok: true,
    command,
    data,
    meta: {
      db_path: globals.dbPath,
      read_only: readOnly,
      generated_at: new Date().toISOString(),
    },
  };
}

export function errorEnvelope(
  command: string,
  code: string,
  message: string,
  recovery?: string,
): ErrorEnvelope {
  return {
    schema_version: SCHEMA_VERSION,
    ok: false,
    command,
    error: {
      code,
      message,
      ...(recovery !== undefined ? { recovery } : {}),
    },
  };
}

export function writeJson(value: unknown): void {
  writeOut(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeByFormat<T>(
  command: string,
  data: T,
  globals: GlobalOptions,
  human: (data: T) => string,
  options: {
    jsonl?: (data: T) => unknown[];
    readOnly?: boolean;
  } = {},
): void {
  if (globals.format === "json") {
    writeJson(envelope(command, data, globals, options.readOnly ?? true));
    return;
  }
  if (globals.format === "jsonl") {
    const records = options.jsonl?.(data) ?? [
      envelope(command, data, globals, options.readOnly ?? true),
    ];
    for (const record of records) writeOut(`${JSON.stringify(record)}\n`);
    return;
  }
  writeOut(human(data));
}

export function formatList(
  rows: Array<Record<string, unknown>>,
  columns: string[],
): string {
  if (rows.length === 0) return "(none)\n";
  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => String(row[col] ?? "").length)),
  );
  const render = (values: string[]) =>
    values.map((value, i) => value.padEnd(widths[i] ?? 0)).join("  ");
  const lines = [render(columns), render(widths.map((w) => "─".repeat(w)))];
  for (const row of rows)
    lines.push(render(columns.map((col) => String(row[col] ?? ""))));
  return `${lines.join("\n")}\n`;
}
