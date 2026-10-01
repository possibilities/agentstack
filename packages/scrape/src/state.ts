import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StateJournal, clearStateFilesSync, listStateFiles, operation, requireStateOperator, snapshotStateFilesSync, stateApplyInput,
  stateHash, statePlan, stateReceipt, type StateApplyInput } from "@stack/api";
import { resolveDataHome } from "./queue-paths.js";
import { initializeQueueMaintenance, queueMaintenanceSelection, withQueueMaintenanceClaims, publishQueueMaintenanceRetry, type QueueMaintenanceAction, type QueueMaintenanceJob } from "./queue.js";

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const capture = z.strictObject({ preset: name, id: z.string().regex(/^sample-[0-9]{3,10}$/) });
type Capture = z.infer<typeof capture>;
type Selection = { kind: "queue"; ids: string[]; action: QueueMaintenanceAction; retries: Record<string, string> }
  | { kind: "corpus"; captures: Capture[] };
const retained = ["Minimal request receipts and permanent generation fences; cancelling/discarding never recalls admitted extraction or overwrites a destination",
  "External destination files, Brain ledger/index, shipped corpus/presets/canaries, authenticated Browse sessions, native browser profiles and backups remain",
  "Unattributed publication/retirement quarantine stays under its existing recovery authority; maintenance never breaks claims"];

export class ScrapeState {
  readonly root = resolveDataHome();
  readonly journal: StateJournal;
  private readonly db: DatabaseSync;
  constructor() {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, "maintenance.sqlite");
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (!lstatSync(path).isFile()) throw new Error("Scrape maintenance journal must be a regular file");
    chmodSync(path, 0o600);
    this.db = new DatabaseSync(path);
    // This owner binds its root's directory identity in filesystem plans. WAL
    // keeps plan/receipt writes from creating and removing rollback-journal
    // entries in that root between observation and apply.
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS queue_fences(id TEXT PRIMARY KEY,digest TEXT NOT NULL,request_id TEXT NOT NULL,action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS corpus_fences(preset TEXT NOT NULL,id TEXT NOT NULL,request_id TEXT NOT NULL,PRIMARY KEY(preset,id))`);
    this.journal = new StateJournal(this.db, "scrape");
  }
  close() { this.db.close(); }
  private prepare(selection: Selection, held = false) {
    const blockedBy: string[] = [];
    let jobs: QueueMaintenanceJob[] = [], paths: string[];
    if (selection.kind === "queue") {
      const retired = new Set(selection.ids.filter(id => this.db.prepare("SELECT id FROM queue_fences WHERE id=?").get(id)));
      jobs = queueMaintenanceSelection(selection.ids, selection.action, retired);
      for (const job of jobs) {
        const fence = this.db.prepare("SELECT request_id FROM queue_fences WHERE id=?").get(job.id);
        if (fence && selection.action !== "discard") blockedBy.push(`Generation ${job.id} has an admitted maintenance fence; inspect receipt, never execute it again`);
        blockedBy.push(...job.blockedBy.filter(reason => !held || !reason.includes("has claim evidence")));
      }
      paths = jobs.flatMap(job => job.files.map(file => file.path));
    } else {
      paths = [...new Set(selection.captures.map(item => `corpus/${item.preset}/${item.id}`))].sort();
      // Captures publish by atomic directory rename. Only final IDs are selectable,
      // never a preset directory, shipped fixture or a .capture-tmp publication.
    }
    const files = snapshotStateFilesSync(this.root, { paths });
    return { subject: null, action: selection.kind === "queue" ? `queue_${selection.action}` : "corpus_clear",
      revision: stateHash([selection, jobs.map(({ claims: _claims, blockedBy: _blocked, ...job }) => job), files]),
      resources: selection.kind === "queue" ? jobs.map(job => `generation:${job.id}:digest:${job.digest}`) : paths,
      blockedBy, retained, regeneration: selection.kind === "queue" && selection.action === "retry"
        ? ["Retry explicitly publishes a new pending generation. Subsequent queue processing may extract/spend and publish to the retained external destination"]
        : ["Maintenance dispatches no work. New explicit submissions/captures can regenerate content; old generations remain fenced"], jobs, files };
  }
  queuePlan(ids: string[], action: QueueMaintenanceAction) {
    initializeQueueMaintenance();
    const retries = Object.fromEntries(action === "retry" ? ids.map(id => [id, `${Date.now()}-retry-${randomUUID()}.yaml`]) : []);
    return this.plan({ kind: "queue", ids: [...new Set(ids)].sort(), action, retries });
  }
  corpusPlan(captures: Capture[]) { return this.plan({ kind: "corpus", captures }); }
  private plan(selection: Selection) {
    const { jobs: _jobs, files: _files, ...preview } = this.prepare(selection);
    return this.journal.plan(preview, selection);
  }
  apply(input: StateApplyInput, kind: Selection["kind"]) {
    const prior = this.journal.existing(input);
    if (prior) { if (!prior.action.startsWith(`${kind}_`)) throw new Error("Maintenance action mismatch"); return prior; }
    const { plan, payload } = this.journal.getPlan(input.planId), selection = payload as Selection;
    if (selection.kind !== kind) throw new Error("Maintenance action mismatch");
    const observed = this.prepare(selection);
    if (plan.revision !== input.expectedRevision || observed.revision !== input.expectedRevision) throw new Error("Scrape state changed; prepare a new plan");
    if (plan.blockedBy.length || observed.blockedBy.length) throw new Error([...plan.blockedBy, ...observed.blockedBy].join("; "));
    const mutate = () => {
      const current = this.prepare(selection, kind === "queue");
      if (current.revision !== input.expectedRevision || current.blockedBy.length) throw new Error("Scrape state changed or blocked under the generation fence; prepare a new plan");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.journal.begin(input, plan);
        if (selection.kind === "queue" && selection.action === "retry") this.journal.finish(input.requestId, "running",
          Object.values(selection.retries).map(name => ({ resource: `retry-attempt:${name}`, outcome: "pending", detail: "Exact planned retry filename; admission is durable, publication not yet observed" })));
        for (const job of observed.jobs) this.db.prepare("INSERT INTO queue_fences VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").run(job.id, job.digest, input.requestId, selection.kind === "queue" ? selection.action : kind);
        if (selection.kind === "corpus") for (const capture of selection.captures) this.db.prepare("INSERT INTO corpus_fences VALUES(?,?,?) ON CONFLICT(preset,id) DO NOTHING").run(capture.preset, capture.id, input.requestId);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
      const retries: string[] = [];
      try {
        if (selection.kind === "queue" && selection.action === "retry") for (const job of observed.jobs) retries.push(publishQueueMaintenanceRetry(job, selection.retries[job.id]!));
        // Publishing into an existing queue directory does not change the owner
        // root or selected predecessors. Any root/file change still fails closed.
        const result = clearStateFilesSync(this.root, { paths: observed.files.roots }, observed.files);
        return this.journal.finish(input.requestId, result.error ? "partial" : "completed", [
          ...plan.resources.map(resource => ({ resource, outcome: result.error ? "unknown" as const : "removed" as const,
            detail: result.error ? `Cleanup uncertain; inspect exact predecessors and quarantine. ${result.error}` : "Exact captured files removed; permanent admission fence and independently retained copies remain" })),
          ...retries.map(id => ({ resource: `generation:${id}`, outcome: "retained" as const, detail: "New retry attempt admitted; extraction completion is separate" })),
        ]);
      } catch { return this.journal.finish(input.requestId, "unknown", [
        ...plan.resources.map(resource => ({ resource, outcome: "unknown" as const, detail: "Filesystem apply interrupted. Inspect predecessors and any new retry generation; this request never executes again" })),
        ...(selection.kind === "queue" ? Object.values(selection.retries).map(name => ({ resource: `retry-attempt:${name}`, outcome: "unknown" as const, detail: "Inspect this exact planned retry filename; publication may have happened" })) : []),
        ...retries.map(id => ({ resource: `generation:${id}`, outcome: "retained" as const, detail: "New retry generation was published before uncertainty; no automatic retry" })),
      ]); }
    };
    return kind === "queue" ? withQueueMaintenanceClaims(observed.jobs, mutate) : mutate();
  }
}

export type ScrapeStateContext = { controller: AbortController; state: ScrapeState | null; work: Promise<unknown> | null; changed?: () => void };
const state = (ctx: ScrapeStateContext) => ctx.state ??= new ScrapeState();
const captures = z.array(capture).min(1).max(100);
export const scrapeStateOperations = [
  operation({ name: "scrape_queue_plan", description: "Preview exact queue generation cancel (pending only), retry (failed only, new attempt) or discard (failed or receipt-retired remaining files). Claims and publication recovery block; maintenance never breaks a claim or removes external destinations. Retired uncertain generations remain permanently fenced. Local operator only.",
    input: z.strictObject({ ids: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100), action: z.enum(["cancel", "retry", "discard"]) }), output: statePlan,
    async call(ctx: ScrapeStateContext, input, invocation) { requireStateOperator(invocation); return state(ctx).queuePlan(input.ids, input.action); } }),
  operation({ name: "scrape_corpus_list", description: "List final local corpus capture IDs for one preset. This inventories only the Stack-owned overlay, not shipped fixtures, definitions, temporary publication or Browse sessions. Local operator only.",
    input: z.strictObject({ preset: name }), output: z.strictObject({ captures: z.array(capture), revision: z.string() }), annotations: { readOnlyHint: true },
    async call(_ctx: ScrapeStateContext, { preset }, invocation) { requireStateOperator(invocation);
      const result = await listStateFiles(resolveDataHome(), { path: `corpus/${preset}`, offset: 0, limit: 10000 });
      if (result.nextOffset !== null) throw new Error("Capture census exceeds its bound");
      return { captures: result.entries.filter(entry => entry.type === "directory" && /^sample-[0-9]{3,10}$/.test(entry.path.split("/").at(-1)!)).map(entry => ({ preset, id: entry.path.split("/").at(-1)! })), revision: result.revision }; } }),
  operation({ name: "scrape_corpus_plan", description: "Preview exact final local corpus captures by preset/capture ID. Do not select shipped fixtures, whole preset directories or temporary publication. Browse authentication and external copied evidence remain. Local operator only.",
    input: z.strictObject({ captures }), output: statePlan,
    async call(ctx: ScrapeStateContext, input, invocation) { requireStateOperator(invocation); return state(ctx).corpusPlan(input.captures); } }),
  ...(["queue", "corpus"] as const).map(kind => operation({ name: kind === "queue" ? "scrape_queue_apply" : "scrape_corpus_clear", description: "Apply one exact Scrape plan. Recheck selected file revisions; queue effects hold native generation claims without reclaiming existing evidence. Persist admission and fences before effects; retries/restarts return the original receipt and never repeat uncertain publication. Local operator only.",
    input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: ScrapeStateContext, input, invocation) { requireStateOperator(invocation); if (ctx.controller.signal.aborted) throw new Error("scrape_stopping");
      const result = state(ctx).apply(input, kind); ctx.changed?.(); return result; } })),
  operation({ name: "scrape_state_receipt_get", description: "Read one durable Scrape receipt, including uncertain predecessor removal and new retry generations. Unknown never authorizes another extraction or cleanup.",
    input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ScrapeStateContext, input, invocation) { requireStateOperator(invocation); return { receipt: state(ctx).journal.receipt(input.requestId) }; } }),
];
