import { z } from "zod";
import { randomUUID } from "node:crypto";
import { operation, requireStateOperator, socketCall, socketPath, stateApplyInput, stateHash, statePageInput, statePlan, stateReceipt, type StateApplyInput, type StateOutcome } from "@stack/api";
import type { WorkerManager } from "./manager.js";
import type { WorkersContext } from "../api.js";
import { collectWorkerBranch, prepareWorkerBranch, prepareWorkerReset, resetWorkerWorktree } from "./worktree-maintenance.js";
import { observeNativeSession, purgeNativeSession } from "./native-session.js";

export const workerStateSelection = z.strictObject({ ids: z.array(z.uuid()).min(1).max(100), kind: z.enum(["git_reset", "transcript", "branch", "native_session", "catalog"]), allowUnmerged: z.array(z.uuid()).max(100).default([]) });
type Selection = z.infer<typeof workerStateSelection>;
const retained = ["Worker/turn identity, admission digests, outcomes including unknown, usage, settings and captured Work context remain",
  "Native credentials/profiles, Signal/Infer/HUD copies, source checkout, remotes and backups remain independent", "Frozen Role resources and minimal maintenance receipts remain; no Worker is reopened or started implicitly"];
export class WorkerState {
  private readonly callbacks = new Map<string, { id: string; workerId: string; run: () => Promise<Record<string, unknown>> }>();
  constructor(private readonly manager: WorkerManager, private readonly root: string, private readonly env: NodeJS.ProcessEnv) {}
  get journal() { return this.manager.ledger.settings.maintenance; }
  private async guardedNative<T extends Record<string, unknown>>(workerId: string, run: () => Promise<T>): Promise<T> {
    const worker = this.manager.ledger.worker(workerId); if (!worker) throw new Error("Unknown Worker");
    const token = randomUUID(); this.callbacks.set(token, { id: worker.accountId, workerId, run });
    try { return await socketCall(socketPath("auth", this.env), "tools/call", { name: "worker_account_state_guard", arguments: { id: worker.accountId, workerId, token } }, { timeoutMs: 120_000 }) as T; }
    finally { this.callbacks.delete(token); }
  }
  async nativeEffect(input: { id: string; workerId: string; token: string; provider: string }) {
    const pending = this.callbacks.get(input.token), worker = this.manager.ledger.worker(input.workerId);
    if (!pending || pending.id !== input.id || pending.workerId !== input.workerId || worker?.accountId !== input.id || worker.provider !== input.provider) throw new Error("No exact owner-issued native maintenance callback");
    this.callbacks.delete(input.token);
    return this.manager.supervisor.maintainNative(input.id, pending.run);
  }
  private normalize(input: Selection) {
    const selection = { ids: [...new Set(input.ids)].sort(), kind: input.kind, allowUnmerged: [...new Set(input.allowUnmerged)].sort() };
    if (selection.allowUnmerged.some(id => selection.kind !== "branch" || !selection.ids.includes(id))) throw new Error("Unmerged override requires an exact selected retained branch");
    if (selection.kind === "native_session") {
      const accounts = selection.ids.map(id => this.manager.ledger.worker(id)?.accountId);
      if (new Set(accounts).size !== accounts.length) throw new Error("Select at most one native-session root per account in a plan; descendant and sibling scope is verified together");
    }
    return selection;
  }
  private async prepare(selection: Selection) {
    const ledger = this.manager.ledger;
    const rows = await Promise.all(selection.ids.map(async id => {
      if (selection.kind === "branch") {
        const claim = ledger.branches().find(row => row.workerId === id); if (!claim) throw new Error("No recorded Worker branch; foreign branches are not adopted");
        const observed = await prepareWorkerBranch(claim, ledger.workers().some(worker => worker.repo === claim.repo && worker.branch === claim.branch), selection.allowUnmerged.includes(id));
        return { id, revision: observed.revision, blockedBy: observed.blockedBy, branch: { claim, observed } };
      }
      const worker = ledger.worker(id); if (!worker) throw new Error("Unknown Worker");
      const blockedBy = selection.kind !== "catalog" && worker.phase !== "closed" ? [`${id}: Worker must be closed`] : [];
      if (selection.kind === "transcript") return { id, revision: ledger.contentRevision(id), blockedBy };
      if (selection.kind === "git_reset") { const reset = await prepareWorkerReset(this.root, worker); return { id, revision: reset.revision, blockedBy: [...blockedBy, ...reset.blockedBy], reset, worker }; }
      if (selection.kind === "catalog") { const catalog = await this.manager.supervisor.catalogObservation(worker.accountId); return { id, revision: stateHash([worker.accountId, catalog.revision]), blockedBy: catalog.blockedBy, catalog, accountId: worker.accountId }; }
      let native: Awaited<ReturnType<typeof observeNativeSession>> | null = null;
      try { native = await this.guardedNative(id, () => observeNativeSession(this.root, worker, this.env)); }
      catch (error) {
        // Native process/SQLite exceptions may contain provider output. Only
        // owner-authored scope refusals are suitable for a content-safe plan.
        const message = error instanceof Error ? error.message : "";
        const safe = /^(Native |Exact |Offline |No exact owner-issued|Account native|Native session maintenance requires)/.test(message) && !message.includes("\n") && message.length < 200;
        blockedBy.push(safe ? message : "Native scope/lifecycle proof unavailable: disable account, drain runtime, retain exact session/cwd and supported private profile/version");
      }
      if (native && ledger.workers().some(sibling => sibling.id !== id && sibling.accountId === worker.accountId && sibling.sessionId && native!.nativeIds.includes(sibling.sessionId))) blockedBy.push("Native descendant selection includes another Worker identity");
      return { id, revision: stateHash([worker, native]), blockedBy: [...blockedBy, ...(native?.blockedBy ?? [])], native, worker };
    }));
    return { rows, preview: { subject: null, action: `worker_${selection.kind}`, revision: stateHash([selection, rows.map(row => [row.id, row.revision, row.blockedBy])]), resources: selection.ids, blockedBy: rows.flatMap(row => row.blockedBy), retained: [...retained,
      ...(selection.kind === "git_reset" ? rows.flatMap(row => "reset" in row && row.reset ? [row.reset.summary] : []) : []),
       ...(selection.kind === "catalog" ? ["Catalog is account-shared derived state; all sibling views on each selected account lose the same cached catalog, but their sessions/settings remain"] : []),
       ...(selection.kind === "native_session" ? ["Exact native sessions and verified descendants selected: " + rows.flatMap(row => "native" in row ? row.native?.nativeIds ?? [] : []).join(", "), "Native provider logs, shared caches/instruction blobs, external shares and backups remain. Operator must quiesce untracked external native processes"] : [])],
      regeneration: [selection.kind === "catalog" ? "Explicit later native catalog discovery can recreate the account cache; cleanup admits no turn" : "New explicit Worker admissions may create new state; closed Workers and cleared unknown turns never replay"] } };
  }
  async plan(input: Selection) { const selection = this.normalize(input); return this.manager.maintain(selection.ids, async () => { const current = await this.prepare(selection); return this.journal.plan(current.preview, { selection }); }); }
  async clear(input: StateApplyInput) {
    const existing = this.journal.existing(input); if (existing) return existing;
    const saved = this.journal.getPlan(input.planId), selection = this.normalize(workerStateSelection.parse((saved.payload as { selection: unknown }).selection));
    if (saved.plan.action !== `worker_${selection.kind}`) throw new Error("Worker maintenance action mismatch");
    return this.manager.maintain(selection.ids, async () => {
      const run = async () => {
        const current = await this.prepare(selection);
        if (saved.plan.revision !== input.expectedRevision || current.preview.revision !== input.expectedRevision) throw new Error("Worker state changed; prepare again");
        if (saved.plan.blockedBy.length || current.preview.blockedBy.length) throw new Error([...saved.plan.blockedBy, ...current.preview.blockedBy].join("; "));
        let result;
        if (selection.kind === "transcript") result = this.journal.atomic(input, () => {
          if (selection.ids.some(id => this.manager.ledger.worker(id)?.phase !== "closed") || stateHash([selection, selection.ids.map(id => [id, this.manager.ledger.contentRevision(id), []])]) !== input.expectedRevision) throw new Error("Worker transcript changed");
        }, () => selection.ids.map(resource => { this.manager.ledger.clearContent(resource); return { resource, outcome: "removed", detail: "Message/tool/prompt payloads redacted; turn/replay/outcome/usage and Work authority retained" }; }));
        else {
          this.journal.begin(input, saved.plan);
          const outcomes: StateOutcome[] = [];
          try {
            const clearedAccounts = new Set<string>();
            for (const row of current.rows) {
              if (selection.kind === "git_reset" && "reset" in row && row.reset && "worker" in row && row.worker) await resetWorkerWorktree(this.root, row.worker, row.reset);
              else if (selection.kind === "branch" && "branch" in row && row.branch) { await collectWorkerBranch(row.branch.claim, row.branch.observed, this.manager.ledger.workers().some(worker => worker.repo === row.branch.claim.repo && worker.branch === row.branch.claim.branch), selection.allowUnmerged.includes(row.id)); this.manager.ledger.collectBranch(row.id); }
              else if (selection.kind === "catalog" && "catalog" in row && row.catalog && "accountId" in row && row.accountId && !clearedAccounts.has(row.accountId)) { await this.manager.supervisor.clearCatalog(row.accountId, row.catalog.files); clearedAccounts.add(row.accountId); }
              else if (selection.kind === "native_session" && "native" in row && row.native && "worker" in row && row.worker) {
                const expected = row.native.revision;
                await this.guardedNative(row.id, async () => {
                  const worker = this.manager.ledger.worker(row.id)!;
                  if (this.manager.ledger.workers().some(sibling => sibling.id !== row.id && sibling.accountId === worker.accountId && sibling.sessionId && row.native!.nativeIds.includes(sibling.sessionId))) throw new Error("Native selection includes another Worker");
                  return { nativeIds: await purgeNativeSession(this.root, worker, this.env, expected) };
                });
              }
              outcomes.push({ resource: row.id, outcome: "removed", detail: `Exact ${selection.kind} effect verified; disclosed independent copies retained` });
            }
            result = this.journal.finish(input.requestId, "completed", outcomes);
          } catch {
            result = this.journal.finish(input.requestId, outcomes.length ? "partial" : "unknown", [...outcomes, ...selection.ids.filter(id => !outcomes.some(row => row.resource === id)).map(resource => ({ resource, outcome: "unknown" as const, detail: "Admitted external effect failed or interrupted; inspect exact resources/quarantine; this request never reruns" }))]);
          }
        }
        this.manager.onChange?.(); selection.ids.forEach(id => this.manager.onChange?.(id)); return result;
      };
      const accounts = selection.kind === "catalog" ? [...new Set(selection.ids.map(id => this.manager.ledger.worker(id)!.accountId))] : [];
      return accounts.length ? this.manager.supervisor.maintainCatalogs(accounts, run) : run();
    });
  }
  branches(input: z.infer<typeof statePageInput>) {
    const rows = this.manager.ledger.branches(); const revision = stateHash(rows);
    if (input.revision && input.revision !== revision) throw new Error("Worker branch inventory changed");
    return { branches: rows.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null };
  }
}
export const workerStateOperations = [
  operation({ name: "worker_state_native_effect", description: "Internal single-use owner-issued callback held under Auth's disabled-account/sign-in mutex and Worker's drained-runtime fence. It cannot execute without an active exact Worker owner callback. Not a standalone cleanup control. Local operator only.", input: z.strictObject({ id: z.uuid(), workerId: z.uuid(), token: z.uuid(), provider: z.enum(["codex", "devin", "claude"]) }), output: z.record(z.string(), z.unknown()),
    async call(ctx: WorkersContext, input, invocation) { requireStateOperator(invocation); return ctx.manager.state.nativeEffect(input); } }),
  operation({ name: "worker_state_plan", description: "Preview exact Worker Git reset, transcript redaction, branch collection, native-session purge or shared catalog clear. Closed-only except catalog. Reset keeps old tip. Branches require recorded, unreferenced, unchecked-out scope and merged base or exact override. Native purge requires disabled/drained account and verified scope/version. Local operator only.", input: workerStateSelection, output: statePlan,
    async call(ctx: WorkersContext, input, invocation) { requireStateOperator(invocation); return ctx.manager.state.plan(input); } }),
  operation({ name: "worker_state_clear", description: "Apply an exact Worker plan under lifecycle/revision fences. Transcript retirement commits atomically with its receipt. Git/native/file effects persist admission first and report partial/unknown without rerun. No implicit Worker resume, turn admission or credential/profile removal. Local operator only.", input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: WorkersContext, input, invocation) { requireStateOperator(invocation); return ctx.manager.state.clear(input); } }),
  operation({ name: "worker_state_branches", description: "Page metadata of branches recorded at Worker worktree creation, including retained branches after record removal and collected identities. Source repositories, checked-out worktrees and remotes are not mutated by this read. Local operator only.", input: statePageInput,
    output: z.strictObject({ branches: z.array(z.strictObject({ workerId: z.uuid(), repo: z.string(), branch: z.string(), baseCommit: z.string(), collectedAt: z.number().int().nullable() })), revision: z.string(), nextOffset: z.number().int().nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: WorkersContext, input, invocation) { requireStateOperator(invocation); return ctx.manager.state.branches(input); } }),
];
