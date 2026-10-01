import { z } from "zod";
import { clearStateFilesSync, operation, requireStateOperator, snapshotStateFilesSync, socketCall, socketPath,
  stateApplyInput, stateHash, statePlan, stateReceipt, type StateApplyInput, type StateJournal, type StateOutcome } from "@stack/api";
import type { BrainContext } from "../api.js";
import type { Job, Run } from "./types.js";
import type { Source } from "./source-types.js";

const ids = z.array(z.number().int().positive()).min(1).max(100);
type Selection = { kind: "jobs"; ids: number[] } | { kind: "runs"; ids: number[] } | { kind: "source"; id: string; action: "remove" | "checkpoint_reset"; procRevision: string }
  | { kind: "artifacts"; digests: string[] };
const terminalJob = (job: Job) => ["failed", "excluded", "cancelled", "completed"].includes(job.state);
const retained = ["Admission IDs/digests, transitions, timing, dispositions, immutable recovery authority and maintenance receipts",
  "Indexed documents, other jobs/sources, shared Artifact bytes, external files, backups and device outboxes are separate copies",
  "Payload redaction is logical; SQLite WAL/free pages and backup media may retain bytes"];

export class BrainState {
  readonly journal: StateJournal;
  constructor(private readonly ctx: BrainContext) { this.journal = ctx.store.db.stateJournal("brain"); }
  private job(id: number): Job {
    const job = this.ctx.store.db.query("SELECT * FROM jobs WHERE id=?").get(id) as Job | null;
    if (!job) throw new Error(`job_not_found: ${id}`);
    return job;
  }
  private jobSnapshot(id: number) {
    const db = this.ctx.store.db, job = this.job(id);
    const attempts = db.query("SELECT * FROM attempts WHERE job_id=? ORDER BY id").all(id);
    const document = job.resource_id === null ? null : db.query("SELECT document_id FROM resources WHERE id=?").get(job.resource_id);
    const policy = job.run_id === null ? null : db.query("SELECT * FROM operator_run_policies WHERE run_id=?").get(job.run_id);
    return { job, attempts, document, policy, transitions: db.query("SELECT * FROM job_transitions WHERE job_id=? ORDER BY id").all(id) };
  }
  private artifact(digest: string) {
    const db = this.ctx.store.db;
    const rows = db.query("SELECT * FROM artifacts WHERE content_hash=? ORDER BY id").all(digest);
    const references = db.query(`SELECT 'resource' AS kind, ra.resource_id AS id FROM resource_artifacts ra JOIN artifacts a ON a.id=ra.artifact_id WHERE a.content_hash=?
      UNION ALL SELECT 'derivation', d.id FROM artifact_derivations d JOIN artifacts a ON a.id=d.artifact_id OR a.id=d.parent_artifact_id WHERE a.content_hash=?
      UNION ALL SELECT 'provenance', p.id FROM provenance p JOIN artifacts a ON a.id=p.artifact_id WHERE a.content_hash=?
      UNION ALL SELECT 'job', j.id FROM jobs j WHERE instr(COALESCE(j.intent,''),?)>0
        OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(j.intent) THEN j.intent ELSE '{}' END) v
          JOIN artifacts a ON v.key='artifact_id' AND v.value=a.id WHERE a.content_hash=?)
      UNION ALL SELECT 'recovery', r.run_id FROM recovery_online_items r WHERE r.artifact_digest=?`).all(digest, digest, digest, digest, digest, digest);
    return { rows, references };
  }
  prepare(selection: Selection) {
    const db = this.ctx.store.db, blockedBy: string[] = [], resources: string[] = [];
    let snapshot: unknown;
    if (selection.kind === "jobs") {
      snapshot = [...new Set(selection.ids)].sort((a, b) => a - b).map(id => {
        const row = this.jobSnapshot(id); resources.push(`job:${id}`);
        if (!terminalJob(row.job) || row.attempts.some(attempt => attempt.state === "leased")) blockedBy.push(`Job ${id} is active or claimed; dispose and drain first`);
        if (row.document?.document_id) blockedBy.push(`Job ${id} has an indexed document; delete the document through its lifecycle instead`);
        if (row.policy && !row.job.content_cleared_at) blockedBy.push(`Job ${id} belongs to an immutable operator Run; select terminal Run retirement`);
        return row;
      });
    } else if (selection.kind === "runs") {
      snapshot = [...new Set(selection.ids)].sort((a, b) => a - b).map(id => {
        const run = db.query("SELECT * FROM runs WHERE id=?").get(id) as Run | null;
        if (!run) throw new Error(`run_not_found: ${id}`);
        const jobs = (db.query("SELECT id FROM jobs WHERE run_id=? ORDER BY id").all(id) as { id: number }[]).map(job => this.jobSnapshot(job.id));
        const lease = db.query("SELECT * FROM operator_run_execution_leases WHERE run_id=?").get(id);
        resources.push(`run:${id}`, ...jobs.map(row => `job:${row.job.id}`));
        if (["pending", "active"].includes(run.state) || lease || jobs.some(row => !terminalJob(row.job) || row.attempts.some(attempt => attempt.state === "leased")))
          blockedBy.push(`Run ${id} is not terminal and drained`);
        if (jobs.some(row => row.document?.document_id)) blockedBy.push(`Run ${id} retains indexed documents; clear those separately before captured job payloads`);
        return { run, jobs, lease, policy: db.query("SELECT * FROM operator_run_policies WHERE run_id=?").get(id),
          recovery: db.query("SELECT * FROM recovery_online_runs WHERE run_id=?").get(id), items: db.query("SELECT * FROM recovery_online_items WHERE run_id=? ORDER BY job_id").all(id) };
      });
    } else if (selection.kind === "source") {
      const source = db.query("SELECT * FROM sources WHERE identifier=?").get(selection.id) as Source | null;
      if (!source) throw new Error("source_not_found");
      if (source.removed_at) throw new Error("source_removed: source is already retired");
      const runs = db.query("SELECT id,state,updated_at FROM runs WHERE source_id=? AND state IN ('pending','active') ORDER BY id").all(source.id);
      const claims = db.query("SELECT j.id,j.state,a.id AS attempt FROM jobs j LEFT JOIN attempts a ON a.job_id=j.id AND a.state='leased' WHERE j.source_id=? AND (j.state='running' OR a.id IS NOT NULL) ORDER BY j.id").all(source.id);
      if (!source.paused) blockedBy.push("Pause the source before removal or checkpoint reset");
      if (runs.length || claims.length) blockedBy.push("Source sync or ingestion claims are active; dispose and drain first");
      resources.push(`source:${selection.id}`, ...runs.map(row => `run:${row.id}`), ...claims.map(row => `job:${row.id}:attempt:${row.attempt}`));
      snapshot = { source, runs, claims };
    } else {
      const claims = db.query("SELECT id FROM attempts WHERE state='leased' ORDER BY id").all();
      if (claims.length) blockedBy.push("Drain ingestion claims before collecting Artifact bytes");
      const artifacts = [...new Set(selection.digests)].sort().map(digest => {
        const value = this.artifact(digest), path = this.ctx.artifacts.relativePath(digest);
        resources.push(`artifact:${digest}`);
        if (value.references.length) blockedBy.push(`Artifact ${digest} is referenced`);
        if (value.rows.some(row => row.storage_path !== null && row.storage_path !== path)) blockedBy.push(`Artifact ${digest} has external or unrecognized storage`);
        return { digest, ...value };
      });
      snapshot = { artifacts, files: snapshotStateFilesSync(this.ctx.artifacts.root, { paths: artifacts.map(row => this.ctx.artifacts.relativePath(row.digest)) }) };
    }
    return { subject: selection.kind === "source" ? { kind: "source", id: selection.id } : null,
      action: selection.kind === "source" ? `source_${selection.action}` : `${selection.kind}_payload`, revision: stateHash([selection, snapshot]),
      resources, blockedBy, retained: [...retained, ...(selection.kind === "source" ? ["Prior source definitions, checkpoint history, indexed documents and admitted child jobs remain; protected Proc schedule stays Brain-controlled"] : [])],
      regeneration: selection.kind === "source" && selection.action === "checkpoint_reset"
        ? ["Reset admits no work. Explicit resume/sync re-reads and may re-admit indexed content; existing digest dedupe applies, but extraction/inference may spend"]
        : ["Cleared jobs and retired sources cannot reopen. New IDs/explicit admissions may create new content; cleanup never dispatches or spends"], snapshot };
  }
  plan(selection: Selection) {
    const { snapshot: _snapshot, ...preview } = this.prepare(selection);
    return this.journal.plan(preview, selection);
  }
  clear(input: StateApplyInput, expected: Selection["kind"], procRevision?: string) {
    const old = this.journal.existing(input);
    if (old) { if (!old.action.startsWith(`${expected}_`)) throw new Error("maintenance action mismatch"); return old; }
    const { plan, payload } = this.journal.getPlan(input.planId);
    const selected = payload as Selection;
    const selection = selected.kind === "source" ? { ...selected, procRevision: procRevision ?? selected.procRevision } : selected;
    if (selection.kind !== expected) throw new Error("maintenance action mismatch");
    const verify = () => {
      const current = this.prepare(selection);
      if (plan.revision !== input.expectedRevision || current.revision !== input.expectedRevision) throw new Error("Brain state changed; prepare a new plan");
      if (current.blockedBy.length) throw new Error(current.blockedBy.join("; "));
      return current;
    };
    const db = this.ctx.store.db;
    if (selection.kind === "artifacts") {
      let observed: ReturnType<BrainState["prepare"]>;
      db.transaction(() => {
        observed = verify(); this.journal.begin(input, plan);
        for (const digest of selection.digests) db.query("DELETE FROM artifacts WHERE content_hash=?").run(digest);
      }).immediate();
      try {
        // Registration removal/admission is durable first. Hold the SQLite write
        // fence while descriptor-relative deletion runs, so no new CAS reference
        // can win between the last check and unlinking bytes.
        return db.transaction(() => {
          const outcomes: StateOutcome[] = [];
          const snapshot = observed!.snapshot as { artifacts: Array<{ digest: string }>; files: ReturnType<typeof snapshotStateFilesSync> };
          for (const row of snapshot.artifacts) {
            const now = this.artifact(row.digest);
            if (now.rows.length || now.references.length) outcomes.push({ resource: `artifact:${row.digest}`, outcome: "blocked", detail: "Artifact was re-registered or referenced after admission; entire byte selection retained" });
          }
          if (outcomes.length) return this.journal.finish(input.requestId, "blocked", outcomes);
          const result = clearStateFilesSync(this.ctx.artifacts.root, { paths: snapshot.files.roots }, snapshot.files);
          for (const row of snapshot.artifacts) outcomes.push({ resource: `artifact:${row.digest}`, outcome: result.error ? "unknown" : "removed", detail: result.error ? "Filesystem state changed or cleanup interrupted; inspect bytes" : "Unreferenced object bytes removed; independently retained copies remain" });
          return this.journal.finish(input.requestId, outcomes.every(row => row.outcome === "removed") ? "completed" : "partial", outcomes);
        }).immediate();
      } catch { return this.journal.finish(input.requestId, "unknown", [{ resource: plan.id, outcome: "unknown", detail: "Artifact cleanup interrupted; inspect exact bytes. This request will not execute again" }]); }
    }
    return this.journal.atomic(input, verify, () => {
      const at = new Date().toISOString();
      if (selection.kind === "jobs") {
        for (const id of selection.ids) this.ctx.store.retireJobPayload(id);
      } else if (selection.kind === "runs") {
        for (const id of selection.ids) {
          const run = db.query("SELECT * FROM runs WHERE id=?").get(id);
          db.query("UPDATE runs SET checkpoint=NULL,attempted_cursor=NULL,committed_checkpoint=NULL,warnings='[]',content_cleared_at=COALESCE(content_cleared_at,?),payload_digest=COALESCE(payload_digest,?),updated_at=? WHERE id=?").run(at, stateHash(run), at, id);
          for (const job of db.query("SELECT id FROM jobs WHERE run_id=?").all(id)) this.ctx.store.retireJobPayload(job.id);
          db.query("UPDATE recovery_online_items SET failure_class=NULL WHERE run_id=?").run(id);
        }
      } else {
        const source = db.query("SELECT id FROM sources WHERE identifier=?").get(selection.id);
        if (selection.action === "remove") db.query("UPDATE sources SET enabled=0,paused=1,next_due_at=NULL,removed_at=?,updated_at=? WHERE id=?").run(at, at, source.id);
        else db.query("UPDATE sources SET checkpoint=NULL,checkpoint_generation=checkpoint_generation+1,next_due_at=NULL,updated_at=? WHERE id=?").run(at, source.id);
      }
      return plan.resources.map(resource => ({ resource, outcome: "removed" as const, detail: selection.kind === "source" ? "Source disabled/retired or checkpoint re-baselined; documents and admitted jobs retained" : "Captured payloads redacted; IDs/digests, authority, timing and unknown outcomes retained" }));
    });
  }
}

async function sourceFence(ctx: BrainContext) {
  try {
    const schedule = await socketCall(socketPath("proc", ctx.env), "tools/call", { name: "proc_schedule_get", arguments: { id: "00000000-0000-4000-8000-000000000001", includeRemoved: true } }, { timeoutMs: 5000 }) as { system: boolean; revision: number; action: { type: string; package: string; operation: string } };
    if (!schedule.system || schedule.action?.type !== "api" || schedule.action.package !== "brain" || schedule.action.operation !== "sources_sync") throw new Error("Protected Proc source schedule changed");
    return stateHash(schedule);
  } catch { throw new Error("Protected Proc source schedule unavailable; repair Proc before source maintenance"); }
}
const read = { readOnlyHint: true } as const;
export const brainStateOperations = [
  operation({ name: "brain_jobs_plan", description: "Preview exact terminal jobs without indexed documents. Redact intent/attempt diagnostics, preserving admission digest and lifecycle. Active claims block; immutable operator jobs require terminal Run selection. Artifact bytes and other owner copies remain separately retained. Local operator only.",
    input: z.strictObject({ ids, scope: z.literal("payload") }), output: statePlan,
    async call(ctx: BrainContext, { ids }, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "jobs", ids }); } }),
  operation({ name: "brain_runs_plan", description: "Preview captured payload retirement for exact terminal, drained Runs and their jobs. Retain immutable recovery authorization, generation/snapshot digests, outcome and timing; active claims or indexed documents block. No automatic retry, extraction or spend. Local operator only.",
    input: z.strictObject({ ids, scope: z.literal("payload") }), output: statePlan,
    async call(ctx: BrainContext, { ids }, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "runs", ids }); } }),
  operation({ name: "brain_source_plan", description: "Preview removal or checkpoint reset of one paused, drained source; verify the protected Proc schedule. Removal retains definitions/history, documents and admissions; the source identity cannot revive. Checkpoint reset permits later re-read/re-admission and spend after explicit resume. Local operator only.",
    input: z.strictObject({ id: z.string().min(1).max(200), action: z.enum(["remove", "checkpoint_reset"]) }), output: statePlan,
    async call(ctx: BrainContext, input, invocation) { requireStateOperator(invocation); const procRevision = await sourceFence(ctx); return ctx.state.plan({ kind: "source", ...input, procRevision }); } }),
  operation({ name: "brain_artifacts_plan", description: "Preview exact stranded Artifact digests with no Resource, derivation, job or recovery references. Ingestion claims block. Registered metadata and owned object bytes are separate commit boundaries; changed files or new references fail closed. External paths, caches and backups remain. Local operator only.",
    input: z.strictObject({ digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100) }), output: statePlan,
    async call(ctx: BrainContext, { digests }, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "artifacts", digests }); } }),
  ...(["jobs", "runs", "source", "artifacts"] as const).map(kind => operation({ name: `brain_${kind}_clear`, description: `Apply an exact ${kind} plan under Brain's write fence. Recheck revisions/blockers; retain IDs/digests and unknown outcomes. Identical retries return the original receipt; interrupted filesystem cleanup never reruns. Payload clear is not cancellation, index deletion or media erasure. Local operator only.`,
    input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: BrainContext, input, invocation) { requireStateOperator(invocation); if (ctx.controller.signal.aborted) throw new Error("brain_stopping");
      const procRevision = kind === "source" && !ctx.state.journal.existing(input) ? await sourceFence(ctx) : undefined;
      const receipt = ctx.state.clear(input, kind, procRevision); ctx.changes?.touch(kind === "source" ? "sources_changed" : "jobs_changed");
      if (kind === "runs") ctx.changes?.touch("sources_changed");
      if (kind === "artifacts") ctx.changes?.touch("index_changed"); return receipt; } })),
  operation({ name: "brain_state_receipt_get", description: "Read a durable Brain maintenance receipt, including partial/unknown cleanup and retained copies. Lost responses or restart never authorize repeated execution.",
    input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: read,
    async call(ctx: BrainContext, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.state.journal.receipt(requestId) }; } }),
];
