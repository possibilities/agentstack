import { z } from "zod";
import { scheduledAuthority } from "@stack/api";

export const authority = scheduledAuthority;
export type Authority = z.infer<typeof authority>;
export const actor = z.union([authority, z.strictObject({ kind: z.literal("legacy_unknown") })]);
export type Actor = z.infer<typeof actor>;
export const operator: Authority = { kind: "operator" };
export const systemBrainId = "00000000-0000-4000-8000-000000000001";
export const brainAuthority: Authority = { kind: "system", name: "brain-source-sync" };

const json = z.json().refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536, "JSON input exceeds 64 KiB");
const id = z.uuid();
const name = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const absolute = z.string().min(1).max(4096).refine((value) => value.startsWith("/") && !value.includes("\0"), "must be an absolute path without NUL");
const label = z.string().trim().min(1).max(120);
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
export const processSummary = z.strictObject({ command: z.string(), args: z.array(z.string()), cwd: z.string().nullable(),
  envKeys: z.array(z.string()), timeoutMs: z.number().int().nullable(), retainOutput: z.boolean() });
export type ProcessSummary = z.infer<typeof processSummary>;
/** The durable run summary deliberately retains only environment variable names, never values. */
export function summarizeProcess(spec: ProcessSpec): ProcessSummary {
  return { command: spec.command, args: spec.args, cwd: spec.cwd ?? null,
    envKeys: Object.keys(spec.env ?? {}).sort(), timeoutMs: spec.timeoutMs, retainOutput: spec.retainOutput };
}
export const action = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("api"), package: name, operation: name, input: json }),
  z.strictObject({ type: z.literal("process"), process: processSpec }),
]);
export type Action = z.infer<typeof action>;
export const scheduleSpec = z.strictObject({
  label: label.nullable().default(null).describe("A short human-readable purpose the UI shows, e.g. \"Nightly repo backup\"; callers should set it."),
  action, firstAt: z.iso.datetime({ offset: true }),
  everyMs: z.number().int().min(1000).max(31 * 86_400_000).nullable().default(null),
  enabled: z.boolean().default(true),
});
export type ScheduleSpec = z.infer<typeof scheduleSpec>;
export const scheduleCreate = scheduleSpec.extend({ id: id.optional() });
export const scheduleUpdate = scheduleSpec.extend({ id, expectedRevision: z.number().int().positive() });
export const scheduleId = z.strictObject({ id });
export const scheduleGet = z.strictObject({ id, includeRemoved: z.boolean().default(false) });
export const scheduleRevision = scheduleId.extend({ expectedRevision: z.number().int().positive() });
export const scheduleRecord = scheduleSpec.extend({ id, revision: z.number().int().positive(), system: z.boolean(),
  createdBy: actor, lastEditedBy: actor, authority: authority.nullable().describe("Null until a legacy schedule is explicitly reauthorized."),
  blockedReason: z.string().nullable(), retryAt: z.iso.datetime({ offset: true }).nullable(), removedAt: z.iso.datetime({ offset: true }).nullable(),
  contentClearedAt: z.iso.datetime().nullable().optional(), specDigest: z.string().nullable().optional(),
  nextAt: z.iso.datetime({ offset: true }).nullable(), createdAt: z.iso.datetime({ offset: true }), updatedAt: z.iso.datetime({ offset: true }) });
export type Schedule = z.infer<typeof scheduleRecord>;
export const executionState = z.enum(["running", "completed", "failed", "refused", "unknown"]);
export const executionRecord = z.strictObject({
  id, scheduleId: z.string(), dueAt: z.iso.datetime({ offset: true }),
  state: executionState,
  authority: authority.nullable(), action: action.nullable().describe("Captured at admission; null for legacy execution history."),
  processId: id.nullable(), result: json.nullable(), error: z.string().nullable(),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const executionSummary = z.strictObject({ id, state: executionState, dueAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(), error: z.string().nullable() });
export const scheduleListItem = scheduleRecord.extend({ recent: z.array(executionSummary).max(12) });
export const runRecord = z.strictObject({
  createdBy: actor,
  id, label: z.string().nullable(), command: z.string().nullable(), scheduleId: id.nullable(),
  scheduleExecutionId: id.nullable(), state: z.enum(["starting", "running", "exited", "failed", "cancelled", "unknown"]),
  pid: z.number().int().positive().nullable(), exitCode: z.number().int().nullable(), signal: z.string().nullable(),
  error: z.string().nullable(), lineCount: z.number().int().nonnegative(), outputTruncated: z.boolean(),
  retainOutput: z.boolean(), startedAt: z.iso.datetime({ offset: true }), finishedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const runDetail = runRecord.extend({ process: processSummary.nullable() });
export const outputLine = z.strictObject({ seq: z.number().int().positive(), stream: z.enum(["stdout", "stderr"]), text: z.string(), partial: z.boolean() });
export const outputPage = z.strictObject({ run: runRecord, lines: z.array(outputLine), nextAfter: z.number().int().nonnegative(), done: z.boolean(), gap: z.boolean() });
export const runId = z.strictObject({ id });
export const runStart = z.strictObject({ requestId: id, label: label.nullable().default(null), process: processSpec });
export const runRead = runId.extend({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(100) });
export const runWait = runRead.extend({ waitMs: z.number().int().min(1).max(30_000).default(30_000) });
export const runJoin = runId.extend({ waitMs: z.number().int().min(1).max(300_000).default(30_000) });
export const runJoinResult = z.strictObject({ run: runRecord, timedOut: z.boolean() });
export const list = z.strictObject({ limit: z.number().int().min(1).max(100).default(50) });
export const scheduleList = list.extend({ includeRemoved: z.boolean().default(false) });
export const executionList = z.strictObject({ id: id.optional(), since: z.iso.datetime({ offset: true }).optional(),
  cursor: z.string().max(200).optional(), limit: list.shape.limit });
export const executionPage = z.strictObject({ executions: z.array(executionRecord), nextCursor: z.string().nullable() });
export const runList = list.extend({ state: z.enum(["active", "terminal"]).optional(), cursor: z.string().max(200).optional() });
export const runPage = z.strictObject({ runs: z.array(runRecord), nextCursor: z.string().nullable() });
export const executionId = z.strictObject({ id });
export const procStatus = z.strictObject({
  running: z.number().int(), capacity: z.number().int(),
  inFlightCalls: z.number().int(), callCapacity: z.number().int(),
  schedules: z.strictObject({ total: z.number().int(), enabled: z.number().int(), held: z.number().int(),
    blocked: z.number().int(), legacy: z.number().int(), removed: z.number().int() }),
  lastSweepAt: z.iso.datetime({ offset: true }).nullable(), lastPruneAt: z.iso.datetime({ offset: true }).nullable(),
  closing: z.boolean(), retentionDays: z.number().int(),
  output: z.strictObject({ maxBytes: z.number().int(), maxLines: z.number().int(), lineChunkChars: z.number().int() }),
});

export function isBrainSchedule(spec: ScheduleSpec): boolean {
  return spec.enabled && spec.everyMs === 300_000 && spec.action.type === "api" && spec.action.package === "brain"
    && spec.action.operation === "sources_sync" && JSON.stringify(spec.action.input) === JSON.stringify({ due: true });
}
