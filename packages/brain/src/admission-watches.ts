import { z } from "zod";
import { OperationRejected, brainSubmitCompletionLink, brainSourcesCompletionLink, completionIdentityInput, requireCompletionCoordination, stateHash, type CompletionWatch, type InvocationContext } from "@stack/api";
import { ResearchCache } from "./db.js";
import { indexedDocumentForUrl, submissionUrlKey } from "./admission.js";
import { admitIngestRequest, parseIngestRequest } from "./dispatch.js";
import { shareJobStates } from "./jobs.js";
import { SourceRegistry, sourceRunStatus } from "./sources.js";
import { parseSourceSync } from "./sources-cli.js";
import { withBrainEnvironment } from "./paths.js";
import type { ResearchStore } from "./store.js";
import type { SourceSyncAdmission } from "./source-types.js";

const jobState = z.enum(["queued", "running", "retry_wait", "blocked", "failed", "completed", "excluded", "cancelled"]);
const admissionOutcome = z.enum(["queued", "duplicate", "would_queue", "not_due", "disabled", "paused", "unsupported"]);
const submissionSummary = z.union([
  z.strictObject({ kind: z.literal("already_indexed"), document_id: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("job"), job_id: z.number().int().positive(), state: jobState, failure_class: z.string().nullable(), document_id: z.number().nullable(), requires_attention: z.boolean(), scope: z.literal("exact_job") }),
]);
export const submissionCompletion = z.strictObject({ result: submissionSummary.nullable() });
const sourceItem = z.strictObject({ run_id: z.number().int().positive(), job_id: z.number().nullable(), outcome: z.enum(["success", "partial", "failed", "cancelled"]).nullable(),
  discovered: z.number(), admitted: z.number(), suppressed: z.number(), warnings: z.number(), checkpoint_committed: z.boolean() });
export const sourcesCompletion = z.strictObject({ result: z.strictObject({ scope: z.literal("discovery_and_admission"),
  admission_count: z.number().int(), run_count: z.number().int(), no_run_count: z.number().int(),
  admission_outcomes: z.partialRecord(admissionOutcome, z.number().int()), outcomes: z.record(z.string(), z.number().int()), runs: z.array(sourceItem).max(50), truncated: z.boolean(), nextOffset: z.number().int().nullable(),
  read: z.strictObject({ operation: z.literal("sources_sync_completion"), requestId: z.uuid(), offset: z.number().int().nullable() }) }).nullable() });
export const completionInput = z.strictObject({ requestId: z.uuid(), botId: z.string().min(1), threadId: z.string().min(1) });
export const sourcesCompletionInput = completionInput.extend({ offset: z.number().int().min(0).max(1000).default(0) });
export const brainCompletionIdentityInput = completionIdentityInput.extend({ operation: z.enum(["submit", "sources_sync"]) });
export const brainCompletionIdentityOutput = z.strictObject({ link: z.union([brainSubmitCompletionLink, brainSourcesCompletionLink]).nullable() });
const declaration = (topic: string, readOperation: string): CompletionWatch => ({ topic, readOperation, idArgument: "requestId", terminalField: "result", defaultWhen: [], initialValueField: "observation",
  readArguments: { requestId: { input: "requestId" }, botId: { invocation: "botId" }, threadId: { invocation: "threadId" } } });
export const brainWatches: Record<string, CompletionWatch> = { submit: declaration("jobs_changed", "submission_completion"), sources_sync: declaration("sources_changed", "sources_sync_completion") };

type Binding = { request_id: string; operation: string; bot_id: string; thread_id: string; input_digest: string; admission_json: string };
type Context = { env: NodeJS.ProcessEnv; store: ResearchStore; dbPath: string; controller: { signal: AbortSignal } };
type SafeSubmit = { version: 1; status: "already_indexed"; document_id: number } | { version: 1; status: "queued" | "duplicate"; job_id: number; intent_hash: string; state: z.infer<typeof jobState> };
type SafeSource = Omit<SourceSyncAdmission, "source_id">;
function binding(db: ResearchStore["db"], requestId: string): Binding | null {
  return db.query("SELECT request_id, operation, bot_id, thread_id, input_digest, admission_json FROM admission_bindings WHERE request_id=?").get(requestId) as Binding | null;
}

/** Only UUID, digest, numeric ledger links and safe admission facts are retained.
 * Domain admission and the binding commit in the same SQLite transaction. */
export async function admitWatched(ctx: Context, operation: "submit" | "sources_sync", input: Record<string, unknown>, argv: string[], invocation?: InvocationContext) {
  const parse = () => operation === "submit" ? parseIngestRequest(argv, "submit") : parseSourceSync(argv.slice(1));
  let request: ReturnType<typeof parse>;
  try {
    request = parse();
    if (request.wait) throw new Error("watched admission cannot wait; omit wait and inspect the completion receipt");
    if ("limit" in request && request.limit > 1000) throw new Error("watched source synchronization accepts at most 1000 sources per admission");
    if (!invocation?.botId || !invocation.threadId || !input.requestId) throw new Error("watched admission requires a verified Bot Chat and requestId");
  } catch (error) { throw new OperationRejected(String(error), { cause: error }); }
  await requireCompletionCoordination(ctx.env, "brain", operation, brainWatches[operation]!, input, invocation);
  if (ctx.controller.signal.aborted) throw new OperationRejected("Brain is stopping; nothing admitted");
  const requestId = String(input.requestId), botId = invocation!.botId!, threadId = invocation!.threadId!;
  const { requestId: _id, subscribe: _subscribe, ...intent } = input;
  const inputDigest = stateHash(intent);
  const admit = ctx.store.db.transaction(() => {
    const prior = binding(ctx.store.db, requestId);
    if (prior) {
      if (prior.operation !== operation || prior.bot_id !== botId || prior.thread_id !== threadId || prior.input_digest !== inputDigest)
        throw new OperationRejected("Brain requestId conflicts with its operation, originating Chat or intent");
      return JSON.parse(prior.admission_json) as SafeSubmit | SafeSource[];
    }
    let safe: SafeSubmit | SafeSource[];
    if (operation === "submit") {
      const submit = request as ReturnType<typeof parseIngestRequest>;
      const indexed = !submit.force && ["auto", "url"].includes(submit.sourceType) ? indexedDocumentForUrl(ctx.store, submit.source) : null;
      if (indexed) safe = { version: 1, status: "already_indexed", document_id: indexed.document_id };
      else {
        const { idempotency_key: _key, ...admission } = admitIngestRequest(ctx.store, submit);
        safe = admission;
      }
    } else {
      const sync = request as ReturnType<typeof parseSourceSync>, registry = new SourceRegistry(ctx.store);
      const admissions = sync.namedSource === undefined ? registry.syncDueSources({ dryRun: sync.dryRun, limit: sync.limit })
        : [registry.syncSource({ sourceId: sync.namedSource, dueOnly: sync.due, dryRun: sync.dryRun })];
      safe = admissions.map(({ source_id: _source, ...admission }) => admission);
    }
    ctx.store.db.query("INSERT INTO admission_bindings(request_id,operation,bot_id,thread_id,input_digest,admission_json,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(requestId, operation, botId, threadId, inputDigest, JSON.stringify(safe), new Date().toISOString());
    return safe;
  });
  let safe: SafeSubmit | SafeSource[];
  try { safe = withBrainEnvironment(ctx.env, () => admit.immediate(), ctx.controller.signal); }
  catch (error) {
    // The transaction has rolled back both domain ledger changes and binding.
    // Tell Serve this is a definite admission refusal, not an uncertain send.
    throw error instanceof OperationRejected ? error : new OperationRejected(error instanceof Error ? error.message : String(error), { cause: error });
  }
  // Caller-facing admission keeps its existing fields. Locators/keys are rebuilt
  // only for this explicit response, never stored or emitted by completion reads.
  let result: object;
  if (Array.isArray(safe)) result = { results: safe.map(admission => ({ ...admission,
    source_id: (ctx.store.db.query("SELECT identifier FROM sources WHERE id=?").get(admission.source_database_id) as { identifier: string } | null)?.identifier ?? "removed",
  })) };
  else if (safe.status === "already_indexed") {
    const key = submissionUrlKey((request as ReturnType<typeof parseIngestRequest>).source)!;
    result = { ...safe, resource_key: `${key.type}:${key.value}` };
  } else {
    const job = ctx.store.db.query("SELECT idempotency_key,state FROM jobs WHERE id=?").get(safe.job_id) as { idempotency_key: string; state: string };
    result = { ...safe, state: job.state, idempotency_key: job.idempotency_key };
  }
  return { ...result, requestId, subscription: null, observation: null };
}

/** Structurally read-only, no content/audit reads, and bound to the exact Chat. */
export function readCompletion(dbPath: string, operation: "submit" | "sources_sync", input: z.infer<typeof completionInput> & { offset?: number }, invocation?: InvocationContext) {
  if (invocation && (invocation.workerId || invocation.transport !== "mcp" || invocation.botId !== input.botId || invocation.threadId !== input.threadId))
    throw new Error("Brain completion belongs to another Bot Chat");
  const cache = new ResearchCache(dbPath);
  try {
    const row = binding(cache.db, input.requestId);
    if (!row) return { result: null };
    if (row.operation !== operation || row.bot_id !== input.botId || row.thread_id !== input.threadId) throw new Error("Brain completion belongs to another admission or Chat");
    if (operation === "submit") {
      const admitted = JSON.parse(row.admission_json) as SafeSubmit;
      if (admitted.status === "already_indexed") return submissionCompletion.parse({ result: { kind: "already_indexed", document_id: admitted.document_id } });
      const job = shareJobStates(cache, [admitted.job_id])[0];
      if (!job || ["queued", "running", "retry_wait"].includes(job.state)) return { result: null };
      return submissionCompletion.parse({ result: { ...job, kind: "job", scope: "exact_job", requires_attention: job.state === "blocked" || job.state === "failed" } });
    }
    const admissions = JSON.parse(row.admission_json) as SafeSource[];
    const ids = [...new Set(admissions.flatMap(admission => admission.run_id === null ? [] : [admission.run_id]))];
    const runs = ids.map(id => sourceRunStatus(cache.db, id));
    if (runs.some(run => !run.terminal)) return { result: null };
    const outcomes: Record<string, number> = {};
    for (const run of runs) outcomes[run.outcome!] = (outcomes[run.outcome!] ?? 0) + 1;
    const admissionOutcomes: Partial<Record<SourceSyncAdmission["status"], number>> = {};
    for (const admission of admissions) admissionOutcomes[admission.status] = (admissionOutcomes[admission.status] ?? 0) + 1;
    const offset = input.offset ?? 0, nextOffset = offset + 50 < runs.length ? offset + 50 : null;
    return sourcesCompletion.parse({ result: { scope: "discovery_and_admission", admission_count: admissions.length, run_count: ids.length,
      no_run_count: admissions.filter(admission => admission.run_id === null).length, outcomes,
      admission_outcomes: admissionOutcomes,
      runs: runs.slice(offset, offset + 50).map(run => ({ run_id: run.run_id, job_id: run.job?.id ?? null, outcome: run.outcome,
        discovered: run.counts.discovered, admitted: run.counts.admitted, suppressed: run.counts.suppressed, warnings: run.warnings, checkpoint_committed: run.checkpoint_committed })),
      truncated: runs.length > 50, nextOffset, read: { operation: "sources_sync_completion", requestId: input.requestId, offset: nextOffset },
    } });
  } finally { cache.close(); }
}

/** Structurally read-only identity read for the local operator. A mismatched or
 * absent binding is null, never an error; the complete fixed Run set or nothing. */
export function readCompletionIdentity(dbPath: string, input: z.infer<typeof brainCompletionIdentityInput>) {
  const cache = new ResearchCache(dbPath);
  try {
    const row = binding(cache.db, input.requestId);
    if (!row || row.operation !== input.operation || row.bot_id !== input.botId || row.thread_id !== input.threadId) return { link: null };
    if (input.operation === "submit") {
      const admitted = JSON.parse(row.admission_json) as SafeSubmit;
      return { link: admitted.status === "already_indexed"
        ? { kind: "brain-submit" as const, requestId: input.requestId, jobId: null, documentId: admitted.document_id }
        : { kind: "brain-submit" as const, requestId: input.requestId, jobId: admitted.job_id, documentId: null } };
    }
    const admissions = JSON.parse(row.admission_json) as SafeSource[];
    const runIds = [...new Set(admissions.flatMap(admission => admission.run_id === null ? [] : [admission.run_id]))].sort((a, b) => a - b);
    if (runIds.length > 1000) throw new Error("Brain source Run set exceeds 1000 identities; unavailable");
    return { link: { kind: "brain-sources" as const, requestId: input.requestId, runIds } };
  } finally { cache.close(); }
}
