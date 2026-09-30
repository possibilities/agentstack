import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, stateDir, stateDependencies, stateDependencyInput, stateHash, requireStateOperator, type PackageApi } from "@stack/api";
import { WorkerSupervisor } from "./src/supervisor.js";
import { WorkerManager } from "./src/manager.js";
import { workerSettingsOperations } from "./src/settings.js";
import { workContext } from "@stack/hud/schema";
import { workAdmissionPage } from "@stack/hud/client";
import { withStateInventory, statePageInput, stateFilePage, stateFileRead, listStateFiles, readStateFile } from "@stack/api";
import { workerStateCategories } from "./src/state-categories.js";

const id = z.uuid();
const model = z.strictObject({ id: z.string(), name: z.string(), efforts: z.array(z.string()), effortConfigId: z.string().nullable() });
const catalogSchema = z.strictObject({ accountId: id, provider: z.enum(["codex", "grok", "devin", "claude"]), observedAt: z.string(),
  source: z.string(), runtimeVersion: z.string(), modelConfigId: z.string().nullable(), models: z.array(model), nativeModelIds: z.array(z.string()), stale: z.boolean(), error: z.string().nullable() });
const phase = z.enum(["preparing", "idle", "running", "awaiting_input", "cancelling", "closed", "failed", "needs_recovery"]);
const turnPhase = z.enum(["queued", "running", "awaiting_input", "cancelling", "completed", "cancelled", "failed", "unknown"]);
const observedSettingsSchema = z.strictObject({ model: z.string().nullable(), effort: z.string().nullable(), mode: z.string().nullable(),
  at: z.number().int(), recordSeq: z.number().int() });
const workerSchema = z.strictObject({ id, botId: z.string(), threadId: z.string(), accountId: id, provider: z.enum(["codex", "grok", "devin", "claude"]),
  model: z.string(), effort: z.string().nullable(), repo: z.string(), cwd: z.string().nullable(), branch: z.string().nullable(),
  baseCommit: z.string().nullable(), sourceDirty: z.boolean(), roleId: z.uuid().nullable().describe("Role ID captured at creation; null for legacy or not-yet-prepared Workers. Recovery retains the saved snapshot."), roleRevision: z.number().int().nullable(), sessionId: z.string().nullable(),
  runtimeInstance: id.nullable(),
  phase, currentTurnId: id.nullable(), issue: z.string().nullable(), createdAt: z.number().int(), updatedAt: z.number().int() });
const turnSchema = z.strictObject({ id, workerId: id, phase: turnPhase, stopReason: z.string().nullable(), issue: z.string().nullable(),
  workContext: workContext.nullable().describe("HUD work and scope captured at admission; null for unassociated or legacy turns. Native completion does not complete this work."),
  requestId: id, prompt: z.string().nullable().describe("Submitted user prompt retained at admission; null for legacy turns whose prompt was not recorded."),
  requestedModel: z.string().nullable(), requestedEffort: z.string().nullable(), observedSettings: observedSettingsSchema.nullable(),
  dispatchedAt: z.number().int().nullable(), dispatchedPromptSeq: z.number().int().nullable(),
  createdAt: z.number().int(), updatedAt: z.number().int() });
const turnSummarySchema = turnSchema.omit({ prompt: true }).extend({
  promptChars: z.number().int().nonnegative().nullable().describe("Submitted prompt length in UTF-16 code units; null for legacy unrecorded prompts. Read worker_turn_list for the full prompt."),
});
const permissionSchema = z.strictObject({ id, workerId: id, turnId: id, acpRequestId: z.number().int(), kind: z.literal("permission"), title: z.string(),
  runtimeInstance: id.nullable(), toolCallId: z.string().nullable(), recordSeq: z.number().int().nullable(),
  options: z.array(z.strictObject({ optionId: z.string(), name: z.string(), kind: z.string() })), state: z.enum(["pending", "responded", "unknown"]) });
const recordSchema = z.strictObject({ seq: z.number().int(), workerId: id,
  turnId: id.nullable().describe("Active admission window, or the tool's original observed turn. Replay and unattributed session observations remain null."), kind: z.string(),
  source: z.enum(["live", "replay", "response", "submitted"]), at: z.number().int(),
  data: z.record(z.string(), z.unknown()).nullable().describe("Safe structured runtime observations; oversized values are recovered through worker_record_read."),
  dataChars: z.number().int(), oversized: z.boolean() });
const captureSchema = z.strictObject({ records: z.number().int(), retainedChars: z.number().int(), droppedRecords: z.number().int(),
  lastObservedAt: z.number().int().nullable(), maxRecords: z.number().int(), maxChars: z.number().int(), truncated: z.boolean() });
const pageInput = { id, afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() };
const listTurnSchema = turnSummarySchema.pick({ id: true, phase: true, stopReason: true, issue: true, dispatchedAt: true, createdAt: true, updatedAt: true, workContext: true });
const listedWorkerSchema = workerSchema.extend({
  turn: listTurnSchema.nullable().describe("Most recent turn, as worker_status summarizes it; null before the first admission. An unknown phase stays until a later turn."),
  pendingPermissions: z.number().int().nonnegative().describe("Permission requests still waiting for an answer; read worker_status for them."),
});
const diffFileSchema = z.strictObject({ path: z.string(), oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "copied", "typechange", "unmerged", "untracked", "unknown"]),
  additions: z.number().int().nullable().describe("Added lines; null for binary and untracked files."), deletions: z.number().int().nullable(), binary: z.boolean() });
const resultSchema = z.strictObject({ worker: workerSchema, turn: turnSummarySchema, duplicate: z.boolean() });
const requestId = z.uuid().describe("Client-generated idempotency key. Retry with identical input after an uncertain response.");

export type WorkersContext = { supervisor: WorkerSupervisor; manager: WorkerManager };
export const workerWorkspaceList = operation({ name: "worker_workspace_list", description: "List one bounded, revision-fenced directory in the retained Worker Git worktree, including closed Workers. Symlinks are listed but never traversed. The worktree's files, native conversation and retained source branch have separate lifecycles; worker_diff inspects Git changes.",
  input: statePageInput.extend({ id, path: z.string().min(1).max(4096).default(".") }), output: stateFilePage, annotations: { readOnlyHint: true },
  async call(ctx: WorkersContext, { id, ...input }, invocation) { requireStateOperator(invocation); const { worker } = await ctx.manager.status(id);
    if (!worker.cwd) throw new Error("Worker has no prepared worktree"); return listStateFiles(worker.cwd, input); } });
export const workerWorkspaceRead = operation({ name: "worker_workspace_read", description: "Read up to 256 KiB of an exact Worker worktree regular file as base64 bytes. No absolute paths, parent traversal, symlink components or special files. Pass the observed file revision on continuation. This never reads shared native account homes.",
  input: z.strictObject({ id, path: z.string().min(1).max(4096), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(262144).default(65536), revision: z.string().optional() }), output: stateFileRead, annotations: { readOnlyHint: true },
  async call(ctx: WorkersContext, { id, ...input }, invocation) { requireStateOperator(invocation); const { worker } = await ctx.manager.status(id);
    if (!worker.cwd) throw new Error("Worker has no prepared worktree"); return readStateFile(worker.cwd, input); } });
export const workerBotDependencies = operation({ name: "worker_bot_dependencies", description: "Inspect Bot-owned Workers and known worktree writers for a maintenance plan. Close every nonclosed dependent Worker first. Closed transcripts, native sessions, captured Work context, worktrees and branches remain independently owned.",
  input: stateDependencyInput, output: stateDependencies, annotations: { readOnlyHint: true },
  async call(ctx: WorkersContext, { botId, cwd }, invocation) {
    requireStateOperator(invocation);
    const rows = (await ctx.manager.list()).filter(row => row.botId === botId || row.cwd === cwd || row.repo === cwd);
    if (rows.length > 1000) throw new Error("Worker dependency inventory exceeds 1000 records");
    return { revision: stateHash(rows.map(row => [row.id, row.phase, row.currentTurnId, row.updatedAt])),
      blockedBy: rows.filter(row => row.phase !== "closed").map(row => `Close Worker ${row.id} before Bot maintenance`),
      retained: rows.map(row => `Worker ${row.id}: transcript, native session, Work context, worktree and branch remain`),
      relationships: rows.map(row => ({ relation: "worker", package: "worker", kind: "worker", id: row.id })) };
  } });
export const workerCatalog = operation({
  name: "worker_catalog", description: "Read model and effort choices observed through this account's ACP session or Claude SDK supportedModels, first when its runtime starts. Codex omits no-effort, o3, realtime and image OpenAI entries; Grok omits Imagine media models; Devin omits no-effort entries; Claude omits models needing purchased usage credits. Refresh on demand; stale results are labelled and never authorize dispatch.",
  input: z.strictObject({ accountId: id, refresh: z.boolean().optional() }), output: catalogSchema,
  annotations: { title: "Account-bound worker catalog", readOnlyHint: true },
  async call(ctx: WorkersContext, { accountId, refresh }) { return ctx.supervisor.catalog(accountId, refresh ?? false); },
});
export const workerRuntimeList = operation({
  name: "worker_runtime_list", description: "Read account runtime health. ACP owns one account process; Claude SDK owns separate session children (pid is null, pids lists current children). A running SDK group may have no children until catalog or session setup.",
  input: z.strictObject({}), output: z.strictObject({ runtimes: z.array(z.strictObject({ id, provider: z.enum(["codex", "grok", "devin", "claude"]),
    backend: z.enum(["acp", "claude-sdk"]), processModel: z.enum(["account", "session"]), pids: z.array(z.number().int()),
    state: z.enum(["running", "stopped", "error"]), pid: z.number().int().nullable(), instance: id.nullable(), error: z.string().nullable() })) }),
  annotations: { title: "List Worker runtimes", readOnlyHint: true },
  async call(ctx: WorkersContext) { return { runtimes: ctx.supervisor.runtimeList() }; },
});
export const workerAccountDrain = operation({
  name: "worker_account_drain", description: "Internal operator lifecycle: stop an account's exact runtime and all owned session children before disabling or removing it.",
  input: z.strictObject({ id }), output: z.strictObject({ id }), annotations: { title: "Drain Worker account", idempotentHint: true },
  async call(ctx: WorkersContext, { id }, invocation) {
    if (invocation?.botId || invocation?.workerId) throw new Error("account lifecycle is operator-only");
    await ctx.supervisor.drain(id);
    return { id };
  },
});

export const workerStart = operation({
  name: "worker_start", description: "Start a Worker in an owned Git worktree and dispatch its first turn through ACP or Claude SDK. Choose an account, model and effort from worker_catalog. Optional roleId selects a Role; omission uses the Worker default. Workers capture its enabled instructions, skills and MCP servers. Recovery retains the snapshot. Admission returns promptly; read worker_status for completion.",
  input: z.strictObject({ accountId: id, model: z.string().min(1).max(200).optional().describe("Native model choice; omit to use the saved provider default. If neither exists, admission fails."), effort: z.string().min(1).max(64).optional(),
    repo: z.string().min(1).max(4_096), baseRef: z.string().min(1).max(256).optional(), roleId: id.optional().describe("Role to capture at creation; omit for the current Worker default. Cannot change on an existing Worker."), task: z.string().min(1).max(65_536), requestId,
    workItemId: id.nullable().optional().describe("Capture this open HUD work item and scope in the first turn. Omit to inherit verified Chat focus; null explicitly opts out. Focus lookup failure refuses admission, never silently drops association.") }),
  output: resultSchema, annotations: { title: "Start Worker" },
  async call(ctx: WorkersContext, input, invocation) { return ctx.manager.start(input, invocation); },
});
export const workerList = operation({
  name: "worker_list", description: "List durable workers owned by this Bot; a Worker caller sees only itself and a local operator sees all. Includes the most recent turn summary and pending permission count. Outcomes can be unknown after interruption.",
  input: z.strictObject({}), output: z.strictObject({ workers: z.array(listedWorkerSchema) }), annotations: { title: "List workers", readOnlyHint: true },
  async call(ctx: WorkersContext, _input, invocation) { return { workers: await ctx.manager.list(invocation) }; },
});
export const workerStatus = operation({
  name: "worker_status", description: "Read one worker, its compact most recent turn summary and exact pending permissions. Worker callers may read only themselves through their exact live runtime; Bot callers see their own Workers and operators see all. Full prompts are in worker_turn_list. No turn starts.",
  input: z.strictObject({ id }), output: z.strictObject({ worker: workerSchema, turn: turnSummarySchema.nullable(), pending: z.array(permissionSchema) }),
  annotations: { title: "Read worker status", readOnlyHint: true },
  async call(ctx: WorkersContext, { id }, invocation) { return ctx.manager.status(id, invocation); },
});
export const workerRead = operation({
  name: "worker_read", description: "Page through durable user, agent, tool and plan transcript entries by sequence number; output is bounded and excludes raw reasoning.",
  input: z.strictObject({ id, afterSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(50).optional() }),
  output: z.strictObject({ entries: z.array(z.strictObject({ seq: z.number().int(), workerId: id, turnId: id, kind: z.string(), text: z.string(), at: z.number().int() })),
    nextSeq: z.number().int(), hasMore: z.boolean() }), annotations: { title: "Read worker transcript", readOnlyHint: true },
  async call(ctx: WorkersContext, { id, afterSeq, limit }, invocation) { return ctx.manager.read(id, afterSeq ?? 0, limit ?? 20, invocation); },
});
export const workerDetail = operation({
  name: "worker_detail", description: "Read retained Worker session metadata, safe runtime arguments/capabilities, observed settings, capture limits and freshness. Submitted model/effort remains distinct from native observations. Subagent coverage is explicitly partial; no complete hierarchy or child transcript is claimed.",
  input: z.strictObject({ id }), output: z.strictObject({ worker: workerSchema, observedSettings: observedSettingsSchema.nullable(),
    metadata: z.array(recordSchema), capture: captureSchema,
    freshness: z.strictObject({ connected: z.boolean(), stale: z.boolean(), readAt: z.number().int(), reason: z.string().nullable() }),
    subagents: z.strictObject({ coverage: z.enum(["partial", "unavailable"]), hierarchyAvailable: z.literal(false), childTranscriptsAvailable: z.literal(false), reason: z.string() }) }),
  annotations: { title: "Inspect Worker session", readOnlyHint: true },
  async call(ctx: WorkersContext, { id }, invocation) { return ctx.manager.detail(id, invocation); },
});
export const workerTurnList = operation({
  name: "worker_turn_list", description: "Page durable Worker turns in admission order, including submitted prompt, requested model/effort, separately observed settings and dispatch evidence. Failed preparation and owner restarts retain admitted prompts. Legacy missing fields are null. Pages are byte-bounded.",
  input: z.strictObject({ id, afterId: id.optional(), limit: z.number().int().min(1).max(50).optional() }),
  output: z.strictObject({ turns: z.array(turnSchema), nextId: id.nullable(), hasMore: z.boolean() }),
  annotations: { title: "Read Worker turn history", readOnlyHint: true },
  async call(ctx: WorkersContext, { id, afterId, limit }, invocation) { return ctx.manager.turns(id, afterId, limit ?? 20, invocation); },
});
export const workerRecordList = operation({
  name: "worker_record_list", description: "Page structured safe runtime observations: content parts, tool calls and merged updates, plans, configuration, session info, commands, usage and vendor _meta. Claude SDK projections identify their backend. Excludes raw reasoning. Replay/out-of-turn observations have no fabricated turn ID. Oversized JSON is recoverable through worker_record_read; capture reports retention loss.",
  input: z.strictObject({ ...pageInput, turnId: id.optional() }),
  output: z.strictObject({ entries: z.array(recordSchema), nextSeq: z.number().int(), hasMore: z.boolean(), capture: captureSchema }),
  annotations: { title: "Read structured Worker records", readOnlyHint: true },
  async call(ctx: WorkersContext, { id, afterSeq, limit, turnId }, invocation) { return ctx.manager.records(id, afterSeq ?? 0, limit ?? 20, turnId, invocation); },
});
export const workerRecordRead = operation({
  name: "worker_record_read", description: "Recover one immutable structured Worker record as bounded JSON text chunks. Offsets and totalChars count UTF-16 code units; concatenate chunks before JSON parsing. The exact Worker ownership check also applies to the record sequence.",
  input: z.strictObject({ id, seq: z.number().int().positive(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(16_000).optional() }),
  output: z.strictObject({ seq: z.number().int(), offset: z.number().int(), data: z.string(), nextOffset: z.number().int(), totalChars: z.number().int(), hasMore: z.boolean(), encoding: z.literal("json-utf16") }),
  annotations: { title: "Read Worker record chunk", readOnlyHint: true },
  async call(ctx: WorkersContext, { id, seq, offset, limit }, invocation) { return ctx.manager.recordChunk(id, seq, offset ?? 0, limit ?? 16_000, invocation); },
});
export const workerToolList = operation({
  name: "worker_tool_list", description: "Page merged Worker tool calls in first-observed order, retaining no-title status/output updates. Records include rawInput/rawOutput/content/locations and _meta. OpenCode task references are projected only from matching input and explicit output metadata; they are not verified parent IDs or live child status. Refresh from the first page after progress invalidation.",
  input: z.strictObject(pageInput), output: z.strictObject({ tools: z.array(z.strictObject({ toolCallId: z.string(), turnId: id.nullable(),
    firstSeq: z.number().int(), lastSeq: z.number().int(), title: z.string().nullable(), kind: z.string().nullable(), status: z.string().nullable(), record: recordSchema })),
    tasks: z.array(z.strictObject({ toolCallId: z.string(), sessionId: z.string(), callingSessionId: z.string(), toolStatus: z.string().nullable(),
      background: z.boolean(), model: z.strictObject({ providerID: z.string().nullable(), modelID: z.string().nullable() }).nullable(),
      recordSeq: z.number().int(), visibility: z.literal("task_reference"), hierarchyVerified: z.literal(false), childStatus: z.literal("unknown") })),
    nextSeq: z.number().int(), hasMore: z.boolean() }),
  annotations: { title: "Read Worker tools and task evidence", readOnlyHint: true },
  async call(ctx: WorkersContext, { id, afterSeq, limit }, invocation) { return ctx.manager.tools(id, afterSeq ?? 0, limit ?? 20, invocation); },
});
export const workerDiff = operation({
  name: "worker_diff", description: "Read a Worker's changes in its retained worktree against its base commit without writing to it: branch commits since the base, changed and untracked files with line counts, uncommitted state, and optionally a bounded unified patch for all files (patch: true) or one listed path. External diff and textconv programs are not run. Fails after worker_remove discards the worktree.",
  input: z.strictObject({ id, path: z.string().min(1).max(4_096).optional().describe("One path from files; its patch is returned."),
    patch: z.boolean().optional().describe("Return the patch for every file, untracked files last."),
    maxChars: z.number().int().min(1).max(200_000).optional().describe("Patch limit in UTF-16 code units; default 100,000.") }),
  output: z.strictObject({ workerId: id, branch: z.string().nullable(), baseCommit: z.string(), head: z.string(),
    commits: z.array(z.strictObject({ sha: z.string(), subject: z.string(), at: z.number().int() })), commitsTruncated: z.boolean(),
    files: z.array(diffFileSchema), filesTruncated: z.boolean(), uncommitted: z.boolean().describe("The worktree has uncommitted or untracked changes."),
    path: z.string().nullable(), patch: z.string().nullable(), truncated: z.boolean().describe("The patch was cut at maxChars.") }),
  annotations: { title: "Read Worker changes", readOnlyHint: true },
  async call(ctx: WorkersContext, { id, path, patch, maxChars }, invocation) { return ctx.manager.diff(id, { path, patch, maxChars }, invocation); },
});
export const workerSend = operation({
  name: "worker_send", description: "Give the same idle native session follow-up work, including a request to fix or revise. Optional model/effort changes must match this account's current catalog.",
  input: z.strictObject({ id, message: z.string().min(1).max(65_536), requestId,
    model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(64).optional(),
    workItemId: id.nullable().optional().describe("Capture this open HUD work item. Omit to continue the prior turn's work at its current scope, falling back to Chat focus if unassociated; null opts out for this turn. Historical turns never move.") }),
  output: resultSchema, annotations: { title: "Send worker follow-up" },
  async call(ctx: WorkersContext, input, invocation) { return ctx.manager.send(input, invocation); },
});
export const workerRespond = operation({
  name: "worker_respond", description: "Answer one exact pending native permission request with an offered optionId, or null to cancel. Claude offers allow-once and deny-once for the exact SDK tool callback; no persistent grant is inferred.",
  input: z.strictObject({ id, permissionId: id, optionId: z.string().nullable() }), output: permissionSchema,
  annotations: { title: "Respond to worker permission" },
  async call(ctx: WorkersContext, { id, permissionId, optionId }, invocation) { return ctx.manager.respond(id, permissionId, optionId, invocation); },
});
export const workerCancel = operation({
  name: "worker_cancel", description: "Request cancellation of the active turn and pending permissions. Inspect status for the final stop reason; this acknowledgement is not completion.",
  input: z.strictObject({ id }), output: z.strictObject({ worker: workerSchema, turn: turnSummarySchema.nullable() }),
  annotations: { title: "Cancel worker turn", idempotentHint: true },
  async call(ctx: WorkersContext, { id }, invocation) { return ctx.manager.cancel(id, invocation); },
});
export const workerResume = operation({
  name: "worker_resume", description: "Load a saved native session after runtime interruption without replaying a turn. If its prior outcome is unknown, explicitly acknowledge that after inspecting the worktree. Claude uses SDK resume with open input; no prompt is sent by recovery.",
  input: z.strictObject({ id, acknowledgeUnknownTurn: z.boolean().optional() }), output: workerSchema,
  annotations: { title: "Resume worker session" },
  async call(ctx: WorkersContext, { id, acknowledgeUnknownTurn }, invocation) { return ctx.manager.resume(id, acknowledgeUnknownTurn ?? false, invocation); },
});
export const workerClose = operation({
  name: "worker_close", description: "Close an idle or inspected worker session while retaining its worktree, branch, transcript and account credentials for review.",
  input: z.strictObject({ id }), output: workerSchema, annotations: { title: "Close worker", idempotentHint: true },
  async call(ctx: WorkersContext, { id }, invocation) { return ctx.manager.closeWorker(id, invocation); },
});
export const workerRemove = operation({
  name: "worker_remove", description: "After closing, explicitly discard the owned worktree and durable worker record. The Git branch and any commits on it are retained.",
  input: z.strictObject({ id, discardWorktree: z.literal(true) }), output: z.strictObject({ id, retainedBranch: z.string().nullable() }),
  annotations: { title: "Remove worker record", destructiveHint: true },
  async call(ctx: WorkersContext, { id, discardWorktree }, invocation) { return ctx.manager.remove(id, discardWorktree, invocation); },
});

export const topics = {
  workers_changed: "Worker account, runtime, catalog, settings defaults or session state changed. Refresh the relevant read operation, including worker_settings_catalog/read for defaults.",
  worker_changed: "One Worker's turn, permission, settings or recovery state changed. Subscribe with its Worker ID and re-read worker_status and worker_settings_read for the latest values.",
  worker_progress: "Scoped UI invalidation for structured transcript, tool and session metadata progress. Subscribe with a Worker ID and refresh Worker detail/history reads. This is separate from Bot wakeups on worker_changed.",
} as const;
export const workerWorkList = operation({ name: "worker_work_list", description: "Page immutable work associations captured with Worker turn admission, with separately observed native phases. Bot callers see their own Workers; operators see all. Old scope revisions remain evidence. Restart pagination on workers_changed. Removed Worker records no longer appear; HUD semantic work and notes remain independent.",
  input: z.strictObject({ workItemId: id, after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(50).default(30) }),
  output: workAdmissionPage, annotations: { readOnlyHint: true },
  async call(ctx: WorkersContext, input, invocation) { return ctx.manager.workAdmissions(input.workItemId, input.after, input.limit, invocation); },
});
export const workerTurnContext = operation({ name: "worker_turn_context", description: "Read one exact retained turn's captured HUD work context and validate its Worker ownership. Null context means no association was recorded, not that the turn did no work. Worker callers may read only their own exact live runtime.",
  input: z.strictObject({ id, turnId: id }), output: z.strictObject({ workerId: id, turnId: id, workContext: workContext.nullable() }), annotations: { readOnlyHint: true },
  async call(ctx: WorkersContext, input, invocation) { return ctx.manager.turnContext(input.id, input.turnId, invocation); },
});
const packageApi: PackageApi<WorkersContext, keyof typeof topics> = {
  operations: [workerBotDependencies, workerWorkspaceList, workerWorkspaceRead, ...workerSettingsOperations, workerCatalog, workerRuntimeList, workerAccountDrain, workerStart, workerList, workerStatus, workerRead,
    workerDetail, workerTurnList, workerRecordList, workerRecordRead, workerToolList, workerDiff,
     workerSend, workerRespond, workerCancel, workerResume, workerClose, workerRemove, workerWorkList, workerTurnContext],
  events: {
    topics,
    scope: { description: "Optional Worker ID for scoped worker_changed and worker_progress notices. A Bot subscription to worker_changed requires this exact ID and a matching worker_status read; worker_progress is for UI reads, not Bot wakeups.",
      example: "00000000-0000-4000-8000-000000000001", valid: (ctx, scope) => Boolean(ctx.manager.ledger.worker(scope)) },
    start(ctx, publish) {
      ctx.manager.onChange = (workerId) => {
        publish("workers_changed");
        if (workerId && ctx.manager.ledger.worker(workerId)) publish("worker_changed", workerId);
      };
      ctx.manager.onProgress = (workerId) => { if (ctx.manager.ledger.worker(workerId)) publish("worker_progress", workerId); };
      return () => { ctx.manager.onChange = undefined; ctx.manager.onProgress = undefined; };
    },
  },
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const supervisor = new WorkerSupervisor(dir, env);
    const manager = new WorkerManager(dir, supervisor, env);
    supervisor.start();
    return { supervisor, manager };
  },
  async closeContext(ctx) { await ctx.manager.close(); },
};
export const api = withStateInventory("worker", workerStateCategories, packageApi);
