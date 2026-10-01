import { join } from "node:path";
import { StateJournal, clearStateFiles, snapshotStateFiles, socketCall, stateHash, stateDependencies,
  type StateApplyInput, type FileSnapshot, type StateDependencies } from "@stack/api";
import type { AuthContext } from "../api.js";
import { accountRoot } from "./worker-accounts.js";

const cachePaths = ["cache/opencode/models.json"];
type Selection = { accountId: string; snapshot: FileSnapshot | null };
export class AccountCacheState {
  readonly journal: StateJournal;
  private active = new Set<string>();
  constructor(private readonly root: string) { this.journal = new StateJournal(join(root, "auth-cache-maintenance.sqlite"), "auth"); }
  close() { this.journal.close(); }
  async mutate<T>(id: string, run: () => Promise<T>): Promise<T> {
    if (this.active.has(id)) throw new Error("Account maintenance or lifecycle change is in progress");
    this.active.add(id); try { return await run(); } finally { this.active.delete(id); }
  }
  private account(ctx: AuthContext, id: string) {
    const account = ctx.store.workerAccounts().find(account => account.id === id); if (!account) throw new Error("worker account not found");
    return { ...account, signingIn: ctx.workerLogin.busy(id) };
  }
  private async prepare(ctx: AuthContext, accountId: string) {
    const account = this.account(ctx, accountId);
    let dependency: StateDependencies | null = null;
    if (ctx.workersSocket) try { dependency = stateDependencies.parse(await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_state_dependencies", arguments: { id: accountId } }, { timeoutMs: 30000 })); } catch { /* refuse unavailable dependency evidence */ }
    let snapshot: FileSnapshot | null = null;
    if (account.provider === "codex") try {
      snapshot = await snapshotStateFiles(accountRoot(this.root, accountId), { paths: cachePaths });
      if (snapshot.entries.length !== 1 || snapshot.entries[0]!.type !== "file") snapshot = null;
    } catch { /* missing/unsafe caches are not empty measurements */ }
    if (stateHash(account) !== stateHash(this.account(ctx, accountId))) throw new Error("Account changed while observing cache dependencies; prepare again");
    return { preview: { subject: { kind: "worker-account", id: accountId }, action: "account_cache_clear", revision: stateHash([account, dependency?.revision ?? null, snapshot]), resources: snapshot ? cachePaths : [],
      blockedBy: [...(account.provider !== "codex" ? ["Provider has no proven separable pure-cache allow-list"] : []),
        ...(account.enabled || account.removing ? ["Account must be disabled and not removing before cache maintenance"] : []),
        ...(account.signingIn ? ["Account sign-in is still in progress"] : []),
        ...(dependency ? dependency.blockedBy : ["Worker runtime/dependency observation unavailable; explicit drain cannot be inferred"]),
        ...(account.provider === "codex" && !snapshot ? ["Allow-listed cache is missing or unsafe; no removal is admitted"] : [])],
      retained: ["Sign-in tokens, keychain items, native session/history databases, sibling accounts and all non-allow-listed profile files remain", "Stack Worker catalogs and minimal maintenance receipts are independent copies", "Only cache/opencode/models.json is allow-listed; Devin and Claude cache cleanup is unsupported"],
      regeneration: ["Explicit later native catalog discovery may recreate model-list cache; cleanup never signs in, drains or restarts a runtime"] }, payload: { accountId, snapshot } };
  }
  async plan(ctx: AuthContext, accountId: string) { return this.mutate(accountId, async () => { const prepared = await this.prepare(ctx, accountId); return this.journal.plan(prepared.preview, prepared.payload); }); }
  async clear(ctx: AuthContext, input: StateApplyInput) {
    const prior = this.journal.existing(input); if (prior) return prior;
    const { plan, payload } = this.journal.getPlan(input.planId), selection = payload as Selection;
    if (plan.action !== "account_cache_clear") throw new Error("Auth cache maintenance action mismatch");
    return this.mutate(selection.accountId, async () => {
      const current = await this.prepare(ctx, selection.accountId);
      if (plan.revision !== current.preview.revision) throw new Error("Account cache/dependencies changed; prepare again");
      if (plan.blockedBy.length || current.preview.blockedBy.length || !selection.snapshot) throw new Error([...plan.blockedBy, ...current.preview.blockedBy].join("; "));
      this.journal.begin(input, plan);
      try {
        const result = await clearStateFiles(accountRoot(this.root, selection.accountId), { paths: cachePaths }, selection.snapshot);
        return this.journal.finish(input.requestId, result.error ? "partial" : "completed", cachePaths.map(resource => ({ resource, outcome: result.removed.includes(resource) ? "removed" : "unknown", detail: result.error ?? "Pure model-list cache removed; native sign-in, sessions and all other files retained" })));
      } catch { return this.journal.finish(input.requestId, "unknown", cachePaths.map(resource => ({ resource, outcome: "unknown", detail: "Filesystem helper interrupted; inspect exact profile/quarantine; this request will not execute again" }))); }
    });
  }
}
