import { z } from "zod";

const count = z.number().int().nonnegative();
const value = z.number().nonnegative().nullable();
const id = z.string().min(1).max(256);
export const resourceKindSchema = z.enum(["total", "component", "bot", "account", "runtime", "process", "subtree"]);
export const resourceMetricsSchema = z.object({
  processCount: count,
  rssBytes: value.describe("Sum of resident sets; shared pages are counted in each process, not unique physical RAM."),
  virtualBytes: value.describe("Sum of virtual address space, not committed memory."),
  cpuTimeMs: value.describe("Cumulative user + system CPU of the currently observed processes, excluding reaped children; can fall when membership changes."),
  cpuPercent: value.describe("Delta CPU / monotonic elapsed time * 100. 100 is one logical core; may exceed 100. Null if any member is warming up or reset."),
  cpuMeasuredProcessCount: count.describe("Members with a valid interval CPU measurement."),
  threads: value.describe("Sum of OS thread counts where available; null if any member is unavailable."),
});
export const resourceScopeSchema = z.object({
  id, kind: resourceKindSchema, name: z.string().max(160),
  component: z.string().max(160).nullable(), botId: z.string().max(160).nullable(),
  accountId: z.string().max(160).nullable(), runtimeInstance: z.string().max(160).nullable(),
  provider: z.string().max(40).nullable(),
  shared: z.boolean().describe("Includes costs shared across sessions/threads; never an allocation to a Worker or chat."),
  metrics: resourceMetricsSchema,
});
export const resourceProcessSchema = z.object({
  id, subtreeId: id, pid: count, ppid: count,
  birth: z.string().max(160).describe("OS birth token; identity is PID + birth, not PID alone. macOS ps has one-second birth resolution."),
  name: z.string().max(120).describe("Executable basename only; no command arguments or environment."),
  parentId: id.nullable().describe("Currently observed owned parent, if any."),
  ancestryParentId: id.nullable().describe("Last observed owned parent; retained across reparenting, may have exited."),
  ownership: z.enum(["root", "descendant", "retained"]),
  component: z.string().max(160), botId: z.string().max(160).nullable(),
  accountId: z.string().max(160).nullable(), runtimeInstance: z.string().max(160).nullable(),
  provider: z.string().max(40).nullable(),
  attribution: z.enum(["component", "current", "retained"]),
  attributedAt: z.string().nullable(),
  cpuIntervalMs: value,
  cpuStatus: z.enum(["measured", "warmup", "reset"]),
  self: resourceMetricsSchema, subtree: resourceMetricsSchema,
});
export const resourceHostSchema = z.object({
  platform: z.string(), logicalCpuCount: count,
  totalMemoryBytes: value, freeMemoryBytes: value,
  loadAverage: z.array(z.number().nonnegative()).length(3).nullable(),
}).describe("Host-wide OS context, not AgentStack consumption or cgroup capacity. Free memory is not available/reclaimable memory.");
export const domainStatusSchema = z.object({
  source: z.enum(["bots", "workers"]), capturedAt: z.string().nullable(),
  error: z.enum(["source_unavailable", "invalid_source"]).nullable(),
  state: z.enum(["current", "stale", "unavailable", "not_attached"]),
  unmatched: count.describe("Running records not safely matched within the observed component ancestry."),
});
export const resourceCoverageSchema = z.object({
  mode: z.enum(["owner_tree", "self_only"]),
  observedHostProcesses: count, ownedProcesses: count, unreadableProcesses: count,
  vanishedDuringCollection: count, retainedProcesses: count,
  excludedCollectorProcesses: count.describe("The short-lived ps collector itself is excluded; sampler work in the owner is included."),
  domains: z.array(domainStatusSchema).max(2),
});
export const resourceErrorSchema = z.enum(["unsupported_platform", "collection_failed", "collection_timeout", "process_limit", "owner_missing", "process_capacity"]);
export const resourceMetadataSchema = z.object({
  snapshotId: id.nullable(), capturedAt: z.string().nullable(), ageMs: value,
  freshness: z.enum(["fresh", "stale", "unavailable"]),
  lastAttemptAt: z.string().nullable(), error: resourceErrorSchema.nullable(),
  source: z.enum(["darwin_ps", "linux_proc", "unsupported"]),
  intervalMs: count, staleAfterMs: count, collectionDurationMs: value,
  coverage: resourceCoverageSchema.nullable(),
});
export const resourceRetentionSchema = z.object({
  maxSamples: count, maxProcessRecords: count, retainedSamples: count,
  oldestAttemptAt: z.string().nullable(), newestAttemptAt: z.string().nullable(),
  droppedSamples: count,
}).describe("In-memory attempts including failures. Actual retention can be shorter under process-record pressure; restart clears history.");
export const resourceCapabilitiesSchema = z.object({
  rssBytes: z.boolean(), virtualBytes: z.boolean(), cpuTimeMs: z.boolean(), cpuPercent: z.boolean(), threads: z.boolean(),
  diskIoBytes: z.literal(false), openFileDescriptors: z.literal(false), networkBytes: z.literal(false), gpu: z.literal(false),
  perSessionAllocation: z.literal(false),
}).describe("False means unavailable, never zero. Sampling misses processes that start and exit between observations.");
export const ownerResourcesInput = z.strictObject({
  snapshotId: id.optional().describe("Pin the returned immutable snapshot for subsequent pages; unknown/expired IDs are errors."),
  scopeId: id.optional().describe("Default total. Use scope/process/subtree IDs returned by this API; unknown IDs are errors."),
  view: z.enum(["scopes", "processes"]).optional(),
  kind: resourceKindSchema.optional().describe("Filter the scopes view by kind."),
  offset: count.max(20_000).optional(), limit: count.min(1).max(100).optional(),
});
export const ownerResourcesOutput = z.object({
  observation: resourceMetadataSchema, host: resourceHostSchema.nullable(), capabilities: resourceCapabilitiesSchema,
  retention: resourceRetentionSchema, scope: resourceScopeSchema.nullable(),
  scopes: z.array(resourceScopeSchema).max(100), processes: z.array(resourceProcessSchema).max(100),
  page: z.object({ offset: count, limit: count, total: count, nextOffset: count.nullable() }),
});
export const ownerResourceHistoryInput = z.strictObject({
  scopeId: id.optional(),
  since: z.iso.datetime().optional().describe("Inclusive attempt time; use returned retention boundaries to detect a truncated requested range."),
  until: z.iso.datetime().optional(),
  limit: count.min(1).max(120).optional().describe("Most recent matching attempts, returned oldest first; default 120."),
});
export const ownerResourceHistoryOutput = z.object({
  scopeId: id, intervalMs: count, retention: resourceRetentionSchema,
  truncated: z.boolean(),
  points: z.array(z.object({
    attemptId: id, attemptedAt: z.string(), snapshotId: id.nullable(), capturedAt: z.string().nullable(),
    state: z.enum(["measured", "absent", "gap"]), error: resourceErrorSchema.nullable(),
    metrics: resourceMetricsSchema.nullable(), host: resourceHostSchema.nullable(),
    coverage: resourceCoverageSchema.nullable(),
  })).max(120),
});

export type ResourceMetrics = z.infer<typeof resourceMetricsSchema>;
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export type ResourceProcess = z.infer<typeof resourceProcessSchema>;
export type ResourceHost = z.infer<typeof resourceHostSchema>;
export type ResourceCoverage = z.infer<typeof resourceCoverageSchema>;
export type DomainStatus = z.infer<typeof domainStatusSchema>;
export type ResourceError = z.infer<typeof resourceErrorSchema>;
export type ResourcesInput = z.infer<typeof ownerResourcesInput>;
export type ResourcesOutput = z.infer<typeof ownerResourcesOutput>;
export type HistoryInput = z.infer<typeof ownerResourceHistoryInput>;
export type HistoryOutput = z.infer<typeof ownerResourceHistoryOutput>;
