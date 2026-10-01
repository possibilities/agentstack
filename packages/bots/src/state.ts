import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { z } from "zod";
import { StateJournal, clearStateFiles, listStateFiles, operation, readStateFile, requireStateOperator, snapshotStateFiles,
  socketCall, socketPath, stateApplyInput, stateDependencies, stateEntry, stateFilePage, stateFileRead, stateHash, statePageInput, statePlan, stateReceipt,
  type FileSnapshot, type StateApplyInput, type StateDependencies, type StateEntry, type StateOutcome } from "@stack/api";
import type { BotsContext } from "../api.js";

const botId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const relativePath = z.string().min(1).max(4096);
const selection = z.union([z.strictObject({ all: z.literal(true) }), z.strictObject({ paths: z.array(relativePath).min(1).max(100) })]);
const action = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("workspace_clear"), selection }),
  z.strictObject({ kind: z.literal("session_reset"), history: z.enum(["retain", "purge"]) }),
  z.strictObject({ kind: z.literal("history_clear"), generation: z.uuid() }),
  z.strictObject({ kind: z.literal("log_clear") }),
  z.strictObject({ kind: z.literal("launch_args_clear") }),
  z.strictObject({ kind: z.literal("upload_remove"), uploadId: z.uuid() }),
  z.strictObject({ kind: z.literal("recovery_discard"), directory: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/) }),
  z.strictObject({ kind: z.literal("queue_bodies_clear"), selection: z.union([z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) }), z.strictObject({ generation: z.uuid() })]) }),
]);
type Action = z.infer<typeof action>;
type Prepared = { action: Action; incarnation: string; generation: string; mainThreadId: string | null; cwd: string;
  botRevision: string; dependencies: StateDependencies; root: string | null; selection: z.infer<typeof selection> | null; snapshot: FileSnapshot | null; argsDigest: string | null;
  queue?: ReturnType<BotsContext["chats"]["queueState"]> };
const read = { readOnlyHint: true } as const;
const link = (operation: string, args: Record<string, unknown>) => ({ package: "bots", operation, arguments: args });
const retainedCopies = ["Signal captured messages and source-read blobs", "Infer request payloads and traces", "Worker sessions, transcripts, Git worktrees and retained branches",
  "Browser profiles and resolved handoff history", "HUD shared Work, collaboration journal and retired-root focus", "Content, Brain, external files and backups",
  "Minimal state-maintenance receipts; admission IDs and unknown outcomes are retained"];

export class BotState {
  readonly journal: StateJournal;
  onChange?: (botId: string) => void;
  constructor(readonly dir: string, private readonly env: NodeJS.ProcessEnv) { this.journal = new StateJournal(join(dir, "bots", "state-control.sqlite"), "bots"); }
  close(): void { this.journal.close(); }
  bot(ctx: BotsContext, id: string) {
    const bot = ctx.supervisor.list().find(row => row.id === id);
    if (!bot) throw new Error(`unknown bot: ${id}`);
    return bot;
  }
  async dependencies(ctx: BotsContext, id: string): Promise<StateDependencies> {
    const bot = this.bot(ctx, id);
    const results = await Promise.all(["worker", "browse", "proc", "serve"].map(async (owner): Promise<StateDependencies> => {
      try { return stateDependencies.parse(await socketCall(socketPath(owner, this.env), "tools/call", {
        name: `${owner}_bot_dependencies`, arguments: { botId: id, cwd: bot.cwd },
      }, { timeoutMs: 5000 })); }
      catch { return { revision: "unavailable", blockedBy: [`${owner} dependencies unavailable; start or repair that owner before cleanup`], retained: [], relationships: [] }; }
    }));
    const queues = ctx.chats.queueState(id);
    const blockers = results.flatMap(result => result.blockedBy);
    if (queues.some(row => row.state === "dispatching")) blockers.push("Chat queue dispatch is still in flight");
    if (ctx.voice.status()?.botId === id) blockers.push("End this Bot's voice call before cleanup");
    if (bot.state !== "stopped" || bot.recoveryIssue) blockers.push("Stop and verify the Bot before cleanup");
    if (ctx.store.maintenanceFence(id)) blockers.push("An earlier maintenance request requires receipt inspection and exact fence release");
    return { revision: stateHash([results.map(row => row.revision), queues, ctx.voice.status()?.botId === id]), blockedBy: blockers,
      retained: [...results.flatMap(result => result.retained), ...retainedCopies], relationships: results.flatMap(result => result.relationships) };
  }
  async entries(ctx: BotsContext, id: string): Promise<StateEntry[]> {
    const bot = this.bot(ctx, id), identity = ctx.store.stateIdentity(id), observedAt = new Date().toISOString();
    const deps = await this.dependencies(ctx, id);
    const owned = ctx.ledger.ownsWorkspace(id) && bot.cwd === join(ctx.root, id);
    const base = { ownerPackage: "bots", subject: { kind: "bot", id }, authority: "authoritative" as const, location: "server" as const,
      ownership: "stack" as const, observedAt, coverage: "partial" as const, revision: stateHash([identity, bot]), items: null, bytes: null,
      sensitivity: "content" as const, relationships: deps.relationships, issues: [] as string[] };
    return [
      { ...base, id: `bot:${id}:workspace`, kind: "workspace", location: owned ? "server" : "external", ownership: owned ? "stack" : "external",
        reads: [link("bot_workspace_list", { botId: id })], actions: [{ ...link("bot_state_plan", { botId: id, action: { kind: "workspace_clear", selection: { all: true } } }),
          blockedBy: owned ? deps.blockedBy : ["Supplied cwd is externally owned; no Stack workspace deletion authority"] }],
        retention: "Files remain until explicitly selected or an owned workspace is removed with its Bot. Whole-workspace selection includes Git metadata.", regeneration: "Bot and external tools can write files; explicitly refresh file observations." },
      { ...base, id: `bot:${id}:conversation`, kind: "conversation", items: bot.mainThreadId ? 1 : 0, coverage: "complete", revision: identity.generation,
        reads: [link("chat_tree", { botId: id }), link("bot_history_list", { botId: id })], actions: [{ ...link("bot_state_plan", { botId: id, action: { kind: "session_reset", history: "retain" } }), blockedBy: deps.blockedBy }],
        retention: "Only the active sanctioned root resumes. Retired history generations remain separately addressable until purged.", regeneration: "The first durable turn in a fresh namespace binds a new root. Server startup still autostarts recorded Bots." },
      { ...base, id: `bot:${id}:queue`, kind: "queue", items: ctx.chats.queueState(id).length, coverage: "complete", revision: stateHash(ctx.chats.queueState(id)),
        reads: [link("bot_queue_history", { botId: id })], actions: [{ ...link("bot_state_plan", { botId: id }), blockedBy: deps.blockedBy }], retention: "Exact terminal queue bodies can clear with original byte counts/digests retained. Reset cancels pending deliveries; unknown remains unknown. Native queue/history are independent copies.", regeneration: "Explicit new enqueue IDs only; cleared admissions can never dispatch again." },
      { ...base, id: `bot:${id}:uploads`, kind: "storage", reads: [link("chat_upload_list", { botId: id })], actions: [],
        retention: "Staged and finalized bytes remain until upload removal or Bot removal. Transcript attachment associations and copied bytes are independent.", regeneration: "Explicit upload admissions." },
      { ...base, id: `bot:${id}:launch`, kind: "configuration", sensitivity: "credential", reads: [link("bot_launch_read", { botId: id }), link("bot_settings_read", { id })],
        actions: [{ ...link("bot_state_plan", { botId: id, action: { kind: "launch_args_clear" } }), blockedBy: deps.blockedBy }],
        retention: "Saved arguments survive stop/start; running Role materializations are lifecycle-owned. Managed settings are reset separately through bot_settings_patch.", regeneration: "Start captures a new Role snapshot and resolves saved settings." },
      { ...base, id: `bot:${id}:log`, kind: "history", reads: [link("bot_log_read", { botId: id })],
        actions: [{ ...link("bot_state_plan", { botId: id, action: { kind: "log_clear" } }), blockedBy: deps.blockedBy }], retention: "Log bytes remain until clear or Bot removal.", regeneration: "The next Bot launch writes a new log." },
      { ...base, id: `bot:${id}:recovery`, kind: "credentials", sensitivity: "credential", reads: [link("bot_recovery_list", { botId: id })], actions: [],
        retention: "Unreconciled credentials remain under runtime-recovery. Metadata only; generic readers cannot reveal auth files.", regeneration: "A failed credential reconciliation can create a new recovery directory." },
    ];
  }
  async prepare(ctx: BotsContext, id: string, selected: Action) {
    const bot = this.bot(ctx, id), identity = ctx.store.stateIdentity(id), deps = await this.dependencies(ctx, id);
    const blockedBy = [...deps.blockedBy];
    let queue: Prepared["queue"];
    if (selected.kind === "queue_bodies_clear") {
      if ("generation" in selected.selection) {
        const generation = selected.selection.generation;
        const history = ctx.store.historyGenerations(id).find(row => row.generation === generation);
        if (!history || !history.retiredAt) throw new Error("Queue generation selection requires an exact retired generation of this Bot incarnation");
      }
      queue = ctx.chats.queueBodySelection(id, selected.selection);
      if (queue.length > 10000) throw new Error("Queue generation exceeds the selection bound; select exact IDs");
      blockedBy.push(...queue.filter(row => ["pending", "dispatching"].includes(row.state)).map(row => `Queue ${row.id} is ${row.state}; cancel or reconcile before body cleanup`));
    }
    let root: string | null = null, files: Prepared["selection"] = null, snapshot: FileSnapshot | null = null;
    if (selected.kind === "workspace_clear") {
      if (!ctx.ledger.ownsWorkspace(id) || bot.cwd !== join(ctx.root, id)) blockedBy.push("Workspace is external; Stack does not own its contents");
      else { root = bot.cwd; files = selected.selection; }
    } else if (selected.kind === "session_reset" && selected.history === "purge" || selected.kind === "history_clear") {
      const generation = selected.kind === "history_clear" ? selected.generation : identity.generation;
      const history = ctx.store.historyGenerations(id).find(row => row.generation === generation);
      if (!history) throw new Error("unknown history generation for this Bot incarnation");
      if (selected.kind === "history_clear" && !history.retiredAt) blockedBy.push("Active history cannot be purged; reset the conversation first");
      if (history.ownership !== "stack") blockedBy.push("Legacy shared history is not fully attributable; retain it when resetting");
      else { root = history.historyPath; files = { all: true }; }
    } else if (selected.kind === "log_clear") { root = join(this.dir, "logs"); files = { paths: [`${id}.log`] }; }
    else if (selected.kind === "upload_remove") { root = join(this.dir, "chat-uploads", id); files = { paths: [selected.uploadId] }; }
    else if (selected.kind === "recovery_discard") { root = join(this.dir, "runtime-recovery", id); files = { paths: [selected.directory] }; }
    if (root && files) {
      try { snapshot = await snapshotStateFiles(root, files); }
      catch (error) { blockedBy.push(`File selection unavailable: ${String(error)}`); }
    }
    const payload: Prepared = { action: selected, ...identity, mainThreadId: bot.mainThreadId, cwd: bot.cwd, botRevision: stateHash(bot),
      dependencies: deps, root, selection: files, snapshot, argsDigest: selected.kind === "launch_args_clear" ? stateHash(ctx.supervisor.settingsArgs(id)) : null, ...(queue ? { queue } : {}) };
    return { payload, preview: { subject: { kind: "bot-incarnation", id: identity.incarnation }, action: selected.kind,
      revision: stateHash(payload), resources: queue ? queue.map(row => row.id) : snapshot ? snapshot.roots : [`bot:${id}:${identity.generation}:${selected.kind}`], blockedBy,
      retained: [...deps.retained, ...(selected.kind === "session_reset" && selected.history === "retain" ? [`History generation ${identity.generation}`] : []),
        ...(selected.kind === "upload_remove" ? ["Attachment associations, transcript paths and copied upload bytes remain; references to these bytes will no longer open", "Upload UUID remains retired for this Bot incarnation; use a new UUID for future uploads"] : []),
        ...(selected.kind === "recovery_discard" ? ["Only the selected retired credential copy is discarded; unsaved credential refreshes in it will be lost"] : [])],
      regeneration: selected.kind === "session_reset" ? ["Bot identity, account, workspace and settings remain; next start uses a fresh history namespace", "Server restart autostarts the Bot; no old-root inputs gain new-root authority"]
        : ["Future owned launches or explicit admissions may create new state"] } };
  }
  async apply(ctx: BotsContext, id: string, input: StateApplyInput, kind: Action["kind"]) {
    const identity = ctx.store.stateIdentity(id);
    const journal = kind === "queue_bodies_clear" ? ctx.chats.maintenance : this.journal;
    const other = kind === "queue_bodies_clear" ? this.journal : ctx.chats.maintenance;
    const existing = journal.existing(input) ?? other.existing(input);
    if (existing) {
      if (existing.subject?.id !== identity.incarnation || existing.action !== kind) throw new Error("receipt belongs to another Bot incarnation or action");
      return existing;
    }
    return ctx.supervisor.maintain(id, async () => {
      const duplicate = journal.existing(input); if (duplicate) return duplicate;
      const saved = journal.getPlan(input.planId), payload = saved.payload as Prepared;
      if (saved.plan.subject?.id !== identity.incarnation || saved.plan.action !== kind) throw new Error("plan belongs to another Bot incarnation or action");
      const current = await this.prepare(ctx, id, payload.action);
      if (current.preview.revision !== input.expectedRevision || saved.plan.revision !== input.expectedRevision) throw new Error("Bot state or dependencies changed; prepare a new plan");
      if (current.preview.blockedBy.length) throw new Error(current.preview.blockedBy.join("; "));
      // Dependency observations await other owners. A different Bot may have
      // admitted this UUID in the other journal while those reads were pending.
      if (other.existing(input)) throw new Error("state request ID already used by another Bot maintenance journal");
      if (kind === "queue_bodies_clear") {
        const ids = payload.queue!.map(row => row.id);
        const receipt = journal.atomic(input, (plan) => {
          if (plan.revision !== input.expectedRevision || stateHash(ctx.chats.queueBodySelection(id, { ids })) !== stateHash(payload.queue)) throw new Error("Queue changed; prepare a new plan");
        }, () => ctx.chats.clearQueueBodies(id, ids));
        ctx.queue.onChange?.(id); this.onChange?.(id); return receipt;
      }
      ctx.store.fenceMaintenance(id, input.requestId);
      this.journal.begin(input, saved.plan);
      const outcomes: StateOutcome[] = [];
      try {
        if (payload.action.kind === "session_reset") {
          ctx.chats.retireQueue(id);
          const reset = ctx.supervisor.resetConversation(id, payload.generation);
          ctx.chats.clearProjection(id); ctx.liveChats.remove(id); ctx.queue.onChange?.(id);
          outcomes.push({ resource: reset.previous, outcome: payload.action.history === "retain" ? "retained" : "pending", detail: `Retired; current conversation generation is ${reset.generation}` });
        }
        if (payload.root && payload.selection && payload.snapshot) {
          if (payload.action.kind === "upload_remove") ctx.store.retireUpload(id, payload.action.uploadId);
          const result = await clearStateFiles(payload.root, payload.selection, payload.snapshot);
          outcomes.push({ resource: payload.root, outcome: result.error ? "unknown" : "removed", detail: `${result.removed.length} selected filesystem entries removed; external symlink targets were not followed` });
          if (result.error) {
            outcomes.push({ resource: input.planId, outcome: "blocked", detail: result.error });
            return this.journal.finish(input.requestId, "partial", outcomes);
          }
          if (payload.action.kind === "history_clear" || payload.action.kind === "session_reset") {
            const generation = payload.action.kind === "history_clear" ? payload.action.generation : payload.generation;
            ctx.store.markHistoryPurged(generation);
            outcomes.push({ resource: generation, outcome: "removed", detail: "Owned native history bytes purged; generation identity remains" });
          }
        }
        if (payload.action.kind === "launch_args_clear") { ctx.supervisor.replaceLaunchArgs(id, []); outcomes.push({ resource: `bot:${id}:args`, outcome: "removed", detail: "Saved launch arguments cleared" }); }
        const receipt = this.journal.finish(input.requestId, "completed", outcomes);
        ctx.store.releaseMaintenance(id, input.requestId);
        return receipt;
      } catch (error) {
        return this.journal.finish(input.requestId, "unknown", [...outcomes, { resource: input.planId, outcome: "unknown", detail: String(error) }]);
      } finally { this.onChange?.(id); }
    });
  }
}

export const botStateOperations = [
  operation({ name: "bot_state_read", description: "Inspect one Bot's workspace ownership, conversation generation, retained state, detailed read links and cleanup blockers. Dependency failures are unavailable, never empty. Does not start the Bot or reveal credentials.",
    input: z.strictObject({ botId }), output: z.strictObject({ incarnation: z.uuid(), generation: z.uuid(), maintenanceRequestId: z.uuid().nullable(), entries: z.array(stateEntry) }), annotations: read,
    async call(ctx: BotsContext, { botId: id }, invocation) { requireStateOperator(invocation); return { ...ctx.store.stateIdentity(id), maintenanceRequestId: ctx.store.maintenanceFence(id), entries: await ctx.state.entries(ctx, id) }; } }),
  operation({ name: "bot_state_fence_release", description: "After inspecting an interrupted cleanup receipt and remaining files, release exactly its durable Bot start fence. This acknowledges inspection, not cleanup completion; the original partial/unknown receipt remains unchanged. Never releases another request or a newer conversation generation.",
    input: z.strictObject({ botId, requestId: z.uuid(), expectedGeneration: z.uuid() }), output: z.strictObject({ released: z.literal(true) }), annotations: { idempotentHint: true },
    async call(ctx: BotsContext, { botId: id, requestId, expectedGeneration }, invocation) { requireStateOperator(invocation);
      return ctx.supervisor.maintain(id, async () => {
        if (ctx.store.stateIdentity(id).generation !== expectedGeneration) throw new Error("Bot generation changed");
        const fence = ctx.store.maintenanceFence(id); if (fence && fence !== requestId) throw new Error("another request holds the maintenance fence");
        if ((ctx.state.journal.receipt(requestId) ?? ctx.chats.maintenance.receipt(requestId))?.status === "running") throw new Error("maintenance is still running");
        ctx.store.releaseMaintenance(id, requestId); ctx.state.onChange?.(id); return { released: true as const };
      }); } }),
  operation({ name: "bot_workspace_list", description: "List one relative directory in a Bot workspace, including stopped or externally owned workspaces. Bounded to 10000 siblings and paged at 100. Symlinks are listed but never traversed. Pass revision on later pages; native tools can change files without API events.",
    input: statePageInput.extend({ botId, path: relativePath.default(".") }), output: stateFilePage, annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); return listStateFiles(ctx.state.bot(ctx, id).cwd, input); } }),
  operation({ name: "bot_workspace_read", description: "Read at most 256 KiB from a workspace regular file as base64 bytes. Relative paths only; no symlink components or special files. Pass the observed file revision to fence changes. Reading does not grant deletion authority over an external cwd.",
    input: z.strictObject({ botId, path: relativePath, offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(262144).default(65536), revision: z.string().optional() }), output: stateFileRead, annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); return readStateFile(ctx.state.bot(ctx, id).cwd, input); } }),
  operation({ name: "bot_state_plan", description: "Preview exact workspace, conversation, retired-history, queue-body, log or saved-argument cleanup. Queue bodies select exact IDs or an attributed retired generation; pending/dispatching entries block. Requires explicit history retention/file selection. One-hour plans bind incarnation, generation, resource identities and dependencies. Apply never implicitly stops or starts a Bot.",
    input: z.strictObject({ botId, action }), output: statePlan,
    async call(ctx: BotsContext, { botId: id, action }, invocation) { requireStateOperator(invocation); const prepared = await ctx.state.prepare(ctx, id, action); return (action.kind === "queue_bodies_clear" ? ctx.chats.maintenance : ctx.state.journal).plan(prepared.preview, prepared.payload); } }),
  ...(["workspace_clear", "session_reset", "history_clear", "log_clear", "launch_args_clear", "upload_remove", "recovery_discard", "queue_bodies_clear"] as const).map(kind => operation({ name: `bot_${kind}`,
    description: `Apply an exact ${kind} plan under the stopped Bot lifecycle fence. Supply the plan revision and a fresh request ID; identical retries return the durable receipt, including partial or unknown outcomes. Changed state requires a new plan. Related owner copies and minimal receipts remain as disclosed.`,
    input: stateApplyInput.extend({ botId }), output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); return ctx.state.apply(ctx, id, input, kind); } })),
  operation({ name: "bot_state_receipt_get", description: "Read the durable result of one Bot state-maintenance request, including retained copies and partial or unknown outcomes. A lost response never authorizes repeating cleanup against newer files or a reused Bot ID.",
    input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: read,
    async call(ctx: BotsContext, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.state.journal.receipt(requestId) ?? ctx.chats.maintenance.receipt(requestId) }; } }),
  operation({ name: "bot_history_list", description: "Page this Bot incarnation's active and retired conversation generations. Each retains its formerly sanctioned root and owned namespace; legacy shared history is labelled shared and cannot be purged wholesale. Purged generations retain only lifecycle metadata.",
    input: statePageInput.extend({ botId }), output: z.strictObject({ generations: z.array(z.strictObject({ generation: z.uuid(), mainThreadId: z.string().nullable(), active: z.boolean(), ownership: z.enum(["stack", "shared"]), createdAt: z.string(), retiredAt: z.string().nullable(), purgedAt: z.string().nullable() })), revision: z.string(), nextOffset: z.number().int().nullable() }), annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); const current = ctx.store.stateIdentity(id);
      const rows = ctx.store.historyGenerations(id).map(({ historyPath: _path, incarnation: _inc, botId: _id, ...row }) => ({ ...row, active: row.generation === current.generation,
        mainThreadId: row.generation === current.generation ? ctx.state.bot(ctx, id).mainThreadId : row.mainThreadId }));
      const revision = stateHash(rows); if (input.revision && input.revision !== revision) throw new Error("history generations changed; restart paging");
      return { generations: rows.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null }; } }),
  operation({ name: "bot_queue_history", description: "Page content-free queue entries across active and retired Bot roots, including stranded, cancelled and unknown admissions. Conversation reset cancels pending entries without changing unknown outcomes. Detailed active-root messages remain in chat_queue_list.",
    input: statePageInput.extend({ botId }), output: z.strictObject({ entries: z.array(z.strictObject({ id: z.uuid(), threadId: z.string(), state: z.enum(["pending", "dispatching", "sent", "unknown", "cancelled"]), bytes: z.number().int(), admissionDigest: z.string(), generation: z.uuid().nullable(), contentClearedAt: z.iso.datetime().nullable() })), revision: z.string(), nextOffset: z.number().int().nullable() }), annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); ctx.state.bot(ctx, id); const rows = ctx.chats.queueState(id), revision = stateHash(rows);
      if (input.revision && input.revision !== revision) throw new Error("queue changed; restart paging");
      return { entries: rows.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null }; } }),
  operation({ name: "bot_launch_read", description: "Read saved launch argument count/digest and captured Role identity. revealArguments explicitly returns potentially sensitive argument values through local operator authority. Settings keep their separate saved/loaded/resolved contract. A stopped Bot has no live Role materialization.",
    input: z.strictObject({ botId, revealArguments: z.boolean().default(false) }), output: z.strictObject({ count: z.number().int(), revision: z.string(), arguments: z.array(z.string()).nullable(), roleId: z.string().nullable(), roleRevision: z.number().nullable(), running: z.boolean() }), annotations: read,
    async call(ctx: BotsContext, { botId: id, revealArguments }, invocation) { requireStateOperator(invocation); const bot = ctx.state.bot(ctx, id), args = [...ctx.supervisor.settingsArgs(id)];
      return { count: args.length, revision: stateHash(args), arguments: revealArguments ? args : null, roleId: bot.roleId, roleRevision: bot.roleRevision, running: bot.state === "running" }; } }),
  operation({ name: "bot_log_read", description: "Read at most 256 KiB of this Bot's log as base64 bytes. Pass revision for a stable continuation; a live writer may change it. Missing logs are unavailable rather than an empty transcript. Log clearing requires a stopped-Bot state plan.",
    input: z.strictObject({ botId, offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(262144).default(65536), revision: z.string().optional() }), output: stateFileRead, annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); ctx.state.bot(ctx, id); return readStateFile(join(ctx.state.dir, "logs"), { path: `${id}.log`, ...input }); } }),
  operation({ name: "bot_recovery_list", description: "List metadata for this Bot's retired runtime credential-recovery directories, without reading auth contents. Missing recovery storage returns an empty page; unreadable or replaced storage fails explicitly. These credentials may be the only unreconciled copy.",
    input: statePageInput.extend({ botId }), output: stateFilePage, annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); ctx.state.bot(ctx, id); const root = join(ctx.state.dir, "runtime-recovery", id);
      try { await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], revision: "absent", nextOffset: null }; throw error; }
      return listStateFiles(root, { path: ".", ...input }); } }),
  operation({ name: "chat_upload_list", description: "Page Bot-private upload directory identities with observation revisions. Follow a returned UUID with chat_upload_status for staging/finalization and declared bytes, or chat_upload_read for bounded finalized content. Associations are independent; removal uses bot_state_plan with upload_remove.",
    input: statePageInput.extend({ botId }), output: stateFilePage, annotations: read,
    async call(ctx: BotsContext, { botId: id, ...input }, invocation) { requireStateOperator(invocation); ctx.state.bot(ctx, id); const root = join(ctx.state.dir, "chat-uploads", id);
      try { await lstat(root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { entries: [], revision: "absent", nextOffset: null }; throw error; }
      return listStateFiles(root, { path: ".", ...input }); } }),
  operation({ name: "chat_upload_read", description: "Read finalized upload bytes in bounded base64 chunks. The exact Bot/upload identity resolves the file; callers cannot supply a filesystem path. Missing or unfinished uploads fail explicitly. Deleting uploaded bytes does not remove attachment metadata or copied content.",
    input: z.strictObject({ botId, id: z.uuid(), offset: z.number().int().nonnegative().default(0), length: z.number().int().min(1).max(262144).default(65536), revision: z.string().optional() }), output: stateFileRead, annotations: read,
    async call(ctx: BotsContext, { botId: id, id: uploadId, ...input }, invocation) { requireStateOperator(invocation); ctx.state.bot(ctx, id);
      const root = join(ctx.state.dir, "chat-uploads", id, uploadId);
      const raw = await readStateFile(root, { path: "manifest.json", offset: 0, length: 16384 });
      if (raw.nextOffset !== null) throw new Error("upload manifest exceeds budget");
      const manifest = JSON.parse(Buffer.from(raw.data, "base64").toString("utf8")) as { botId: string; id: string; name: string; path: string | null };
      if (manifest.botId !== id || manifest.id !== uploadId || !manifest.path || !manifest.name || /[/\\]/.test(manifest.name)) throw new Error("upload is not a finalized owned file");
      return readStateFile(root, { path: manifest.name, ...input }); } }),
];
