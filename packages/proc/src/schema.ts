import { z } from "zod";

const json = z.json().refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536, "JSON input exceeds 64 KiB");
const id = z.uuid();
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const absolute = z.string().min(1).max(4096).refine((value) => value.startsWith("/") && !value.includes("\0"), "must be an absolute path without NUL");
export const processSpec = z.strictObject({
  command: absolute.describe("Absolute executable path; no shell expansion or PATH lookup."),
  args: z.array(z.string().max(8192).refine((value) => !value.includes("\0"))).max(128).default([]),
  cwd: absolute.optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8192).refine((value) => !value.includes("\0"))).optional(),
  timeoutMs: z.number().int().min(1000).max(86_400_000).nullable().default(300_000),
  retainOutput: z.boolean().default(true),
}).refine((spec) => Buffer.byteLength(JSON.stringify([spec.args, spec.env ?? {}])) <= 65_536,
  "process arguments and environment exceed 64 KiB");
export type ProcessSpec = z.infer<typeof processSpec>;
export const action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api"), package: name, operation: name, input: json }),
  z.strictObject({ type: z.literal("process"), process: processSpec }),
]);
export type Action = z.infer<typeof action>;
export const scheduleSpec = z.strictObject({
  action, firstAt: z.iso.datetime({ offset: true }),
  everyMs: z.number().int().min(1000).max(31 * 86_400_000).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type ScheduleSpec = z.infer<typeof scheduleSpec>;
export const scheduleCreate = scheduleSpec.extend({ id: id.optional() });
export const scheduleUpdate = scheduleSpec.extend({ id, expectedRevision: z.number().int().positive() });
export const scheduleId = z.strictObject({ id });
export const scheduleRevision = scheduleId.extend({ expectedRevision: z.number().int().positive() });
export const scheduleRecord = scheduleSpec.extend({ id, revision: z.number().int().positive(), system: z.boolean(),
  nextAt: z.iso.datetime({ offset: true }).nullable(), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }) });
export const executionRecord = z.strictObject({
  id, scheduleId: z.string(), dueAt: z.iso.datetime({ offset: true }),
  state: z.enum(["running", "completed", "failed", "unknown"]),
  processId: id.nullable(), result: json.nullable(), error: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const runRecord = z.strictObject({
  id, scheduleExecutionId: id.nullable(), state: z.enum(["starting", "running", "exited", "failed", "cancelled", "unknown"]),
  pid: z.number().int().positive().nullable(), exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  error: z.string().nullable(), lineCount: z.number().int().nonnegative(), outputTruncated: z.boolean(),
  retainOutput: z.boolean(), startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const outputLine = z.strictObject({ seq: z.number().int().positive(), stream: z.enum(["stdout", "stderr"]), text: z.string(), partial: z.boolean() });
export const outputPage = z.strictObject({ run: runRecord, lines: z.array(outputLine), nextAfter: z.number().int().nonnegative(), done: z.boolean(), gap: z.boolean() });
export const runId = z.strictObject({ id });
export const runStart = z.strictObject({ requestId: id, process: processSpec });
export const runRead = runId.extend({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) });
export const runWait = runRead.extend({ waitMs: z.number().int().min(1).max(30_000).default(30_000) });
export const runJoin = runId.extend({ waitMs: z.number().int().min(1).max(300_000).default(30_000) });
export const runJoinResult = z.strictObject({ run: runRecord, timedOut: z.boolean() });
export const list = z.strictObject({ limit: z.number().int().min(1).max(100).default(50) });
export const executionId = z.strictObject({ id });
