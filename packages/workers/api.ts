import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { WorkerSupervisor } from "./src/supervisor.js";
import { WorkerManager } from "./src/manager.js";

const id = z.uuid();
const model = z.strictObject({ id: z.string(), name: z.string(), efforts: z.array(z.string()), effortConfigId: z.string().nullable() });
const catalogSchema = z.strictObject({ accountId: id, provider: z.enum(["codex", "grok", "devin"]), observedAt: z.string(),
  source: z.string(), runtimeVersion: z.string(), modelConfigId: z.string().nullable(), models: z.array(model), nativeModelIds: z.array(z.string()), stale: z.boolean(), error: z.string().nullable() });
const phase = z.enum(["preparing", "idle", "running", "awaiting_input", "cancelling", "closed", "failed", "needs_recovery"]);
const turnPhase = z.enum(["queued", "running", "awaiting_input", "cancelling", "completed", "cancelled", "failed", "unknown"]);
const workerSchema = z.strictObject({ id, botId: z.string(), threadId: z.string(), accountId: id, provider: z.enum(["codex", "grok", "devin"]),
  model: z.string(), effort: z.string().nullable(), repo: z.string(), cwd: z.string().nullable(), branch: z.string().nullable(),
  baseCommit: z.string().nullable(), sourceDirty: z.boolean(), roleRevision: z.number().int().nullable(), acpSessionId: z.string().nullable(),
  runtimeInstance: id.nullable(),
  phase, currentTurnId: id.nullable(), issue: z.string().nullable(), createdAt: z.number().int(), updatedAt: z.number().int() });
const turnSchema = z.strictObject({ id, workerId: id, phase: turnPhase, stopReason: z.string().nullable(), issue: z.string().nullable(),
  createdAt: z.number().int(), updatedAt: z.number().int() });
const permissionSchema = z.strictObject({ id, workerId: id, turnId: id, acpRequestId: z.number().int(), kind: z.literal("permission"), title: z.string(),
  options: z.array(z.strictObject({ optionId: z.string(), name: z.string(), kind: z.string() })), state: z.enum(["pending", "responded", "unknown"]) });
const resultSchema = z.strictObject({ worker: workerSchema, turn: turnSchema, duplicate: z.boolean() });
const requestId = z.uuid().describe("Client-generated idempotency key. Retry with identical input after an uncertain response.");

export type WorkersContext = { supervisor: WorkerSupervisor; manager: WorkerManager };
export const workerCatalog = operation({
  name: "worker_catalog", description: "Read model and effort choices observed through this account's native ACP session. Refresh on demand; stale results are labelled and never authorize dispatch.",
  input: z.strictObject({ accountId: id, refresh: z.boolean().optional() }), output: catalogSchema,
  annotations: { title: "Account-bound worker catalog", readOnlyHint: true },
  async call(ctx: WorkersContext, { accountId, refresh }) { return ctx.supervisor.catalog(accountId, refresh ?? false); },
});
export const workerRuntimeList = operation({
  name: "worker_runtime_list", description: "Read owned per-account ACP process health without exposing credentials or the ACP pipes.",
  input: z.strictObject({}), output: z.strictObject({ runtimes: z.array(z.strictObject({ id, provider: z.enum(["codex", "grok", "devin"]),
    state: z.enum(["running", "stopped", "error"]), pid: z.number().int().nullable(), instance: id.nullable(), error: z.string().nullable() })) }),
  annotations: { title: "List ACP runtimes", readOnlyHint: true },
  async call(ctx: WorkersContext) { return { runtimes: ctx.supervisor.runtimeList() }; },
});
export const workerAccountDrain = operation({
  name: "worker_account_drain", description: "Internal operator lifecycle: stop one exact ACP process before disabling or removing its account.",
  input: z.strictObject({ id }), output: z.strictObject({ id }), annotations: { title: "Drain ACP account", idempotentHint: true },
  async call(ctx: WorkersContext, { id }, invocation) {
    if (invocation?.botId || invocation?.workerId) throw new Error("account lifecycle is operator-only");
    await ctx.supervisor.drain(id);
    return { id };
  },
});

export const workerStart = operation({
  name: "worker_start", description: "Start a persistent ACP worker session in an owned Git worktree and dispatch its first turn. Choose exact account, model and effort from worker_catalog. An acknowledged request returns IDs promptly; read worker_status for completion.",
  input: z.strictObject({ accountId: id, model: z.string().min(1).max(200), effort: z.string().min(1).max(64).optional(),
    repo: z.string().min(1).max(4_096), baseRef: z.string().min(1).max(256).optional(), task: z.string().min(1).max(65_536), requestId }),
  output: resultSchema, annotations: { title: "Start ACP worker" },
  async call(ctx: WorkersContext, input, invocation) { return ctx.manager.start(input, invocation); },
});
export const workerList = operation({
  name: "worker_list", description: "List durable workers owned by this Bot; a local operator sees all. A turn outcome can be unknown after interruption.",
  input: z.strictObject({}), output: z.strictObject({ workers: z.array(workerSchema) }), annotations: { title: "List workers", readOnlyHint: true },
  async call(ctx: WorkersContext, _input, invocation) { return { workers: await ctx.manager.list(invocation) }; },
});
export const workerStatus = operation({
  name: "worker_status", description: "Read one worker, its most recent turn and exact pending permission requests. No turn is started by this read.",
  input: z.strictObject({ id }), output: z.strictObject({ worker: workerSchema, turn: turnSchema.nullable(), pending: z.array(permissionSchema) }),
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
export const workerSend = operation({
  name: "worker_send", description: "Give the same idle ACP session follow-up work, including a request to fix or revise. Optional model/effort changes must match this account's current catalog.",
  input: z.strictObject({ id, message: z.string().min(1).max(65_536), requestId,
    model: z.string().min(1).max(200).optional(), effort: z.string().min(1).max(64).optional() }),
  output: resultSchema, annotations: { title: "Send worker follow-up" },
  async call(ctx: WorkersContext, input, invocation) { return ctx.manager.send(input, invocation); },
});
export const workerRespond = operation({
  name: "worker_respond", description: "Answer one exact pending ACP permission request with an offered optionId, or null to cancel. Never infer approval from silence.",
  input: z.strictObject({ id, permissionId: id, optionId: z.string().nullable() }), output: permissionSchema,
  annotations: { title: "Respond to worker permission" },
  async call(ctx: WorkersContext, { id, permissionId, optionId }, invocation) { return ctx.manager.respond(id, permissionId, optionId, invocation); },
});
export const workerCancel = operation({
  name: "worker_cancel", description: "Request cancellation of the active turn and pending permissions. Inspect status for the final stop reason; this acknowledgement is not completion.",
  input: z.strictObject({ id }), output: z.strictObject({ worker: workerSchema, turn: turnSchema.nullable() }),
  annotations: { title: "Cancel worker turn", idempotentHint: true },
  async call(ctx: WorkersContext, { id }, invocation) { return ctx.manager.cancel(id, invocation); },
});
export const workerResume = operation({
  name: "worker_resume", description: "Load a saved ACP session after process interruption without replaying a turn. If its prior outcome is unknown, explicitly acknowledge that after inspecting the worktree.",
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
  workers_changed: "ACP account, catalog or Worker state changed. Refresh the relevant read operation.",
  worker_changed: "One Worker's turn, permission or recovery state changed. Subscribe with its Worker ID and re-read worker_status for the latest value.",
} as const;
export const api: PackageApi<WorkersContext, keyof typeof topics> = {
  operations: [workerCatalog, workerRuntimeList, workerAccountDrain, workerStart, workerList, workerStatus, workerRead,
    workerSend, workerRespond, workerCancel, workerResume, workerClose, workerRemove],
  events: {
    topics,
    scope: { description: "Optional Worker ID. A Bot subscription to worker_changed requires this exact ID and a matching worker_status read.",
      example: "00000000-0000-4000-8000-000000000001", valid: (ctx, scope) => Boolean(ctx.manager.ledger.worker(scope)) },
    start(ctx, publish) {
      ctx.manager.onChange = (workerId) => {
        publish("workers_changed");
        if (workerId && ctx.manager.ledger.worker(workerId)) publish("worker_changed", workerId);
      };
      return () => { ctx.manager.onChange = undefined; };
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
