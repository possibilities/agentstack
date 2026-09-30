import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { withStateInventory } from "@stack/api";
import { brainStateCategories } from "./src/state-categories.js";
import { operation, operatorInvocation, type PackageApi } from "@stack/api";
import { egressPolicy } from "@stack/scrape/network";
import { ResearchEgress, grantScope, grantRecord, jobNetworkPolicy } from "./src/egress.js";
import { ArtifactStore } from "./src/artifacts.js";
import { brainTopics, watchBrainChanges, type BrainChanges, type BrainTopic } from "./src/changes.js";
import { runParsed } from "./src/dispatch.js";
import { CliError } from "./src/errors.js";
import { captureOutput } from "./src/format.js";
import { agentTools, invocationFor } from "./src/mcp-tools.js";
import * as schemas from "./src/output-schemas.js";
import { assertDefaultDatabaseTargetSafe, brainStateRoot, withBrainEnvironment } from "./src/paths.js";
import { generateShareToken, SHARE_DEFAULT_HOST, SHARE_DEFAULT_PORT } from "./src/share.js";
import { clearIngressRegistration, probeShareIngress, withShareIngressToken, writeIngressRegistration } from "./src/share-liveness.js";
import { startShareServer, type RunningShareServer } from "./src/share-server.js";
import { shareRoutes } from "./src/share-server.js";
import { shareAdmit, shareStates } from "./src/share-server.js";
import { parseShareRequest } from "./src/share.js";
import { ResearchStore } from "./src/store.js";
import { runWorker, type WorkerOptions, type WorkerResult } from "./src/worker.js";

export interface BrainContext {
  env: NodeJS.ProcessEnv;
  stateRoot: string;
  dbPath: string;
  tokenPath: string;
  shareToken: string;
  registrationPath: string;
  artifacts: ArtifactStore;
  store: ResearchStore;
  server: RunningShareServer;
  controller: AbortController;
  worker: Promise<WorkerResult | null>;
  maintenance: ReturnType<typeof setInterval>;
  maintenanceTask: Promise<void> | null;
  calls: Set<Promise<unknown>>;
  workerState: "running" | "stopped" | "failed";
  health: string | null;
  /** Present while events are served; operation calls ask it to compare fingerprints at once. */
  changes?: BrainChanges;
  closing?: Promise<void>;
}

const outputs: Record<string, z.ZodType> = {
  stats: schemas.StatsDataSchema,
  search: schemas.SearchDataSchema,
  context: schemas.ContextDataSchema,
  get: z.union([schemas.DocumentDataSchema, schemas.ChunkDataSchema]).meta({ type: "object" }),
  tags: schemas.TagsDataSchema,
  submit: z.union([schemas.AdmissionResultSchema, schemas.AlreadyIndexedResultSchema]).meta({ type: "object" }),
  delete: z.object({ success: z.literal(true), deleted_document_id: z.number(), title: z.string().nullable(), source_uri: z.string(), purged_resources: z.number(), redacted_jobs: z.number(), removed_artifacts: z.array(z.string()) }),
  retag: schemas.RetagResultSchema,
  jobs_list: z.object({ jobs: z.array(schemas.SafeJobSchema) }),
  jobs_show: schemas.SafeJobRecordSchema.extend({ network_policy: jobNetworkPolicy }),
  jobs_run: schemas.SafeRunRecordSchema,
  jobs_stats: schemas.JobStatsSchema,
  jobs_retry: schemas.SafeJobSchema,
  jobs_cancel: z.object({ ok: z.boolean(), reason: z.string().optional(), job: schemas.SafeJobSchema }),
  jobs_exclude: schemas.SafeJobSchema,
  sources_list: z.object({ sources: z.array(schemas.SourceListItemSchema) }),
  sources_show: schemas.SourceDetailSchema,
  sources_status: z.object({ sources: z.array(schemas.SourceStatusSchema) }),
  sources_apply: z.object({ results: z.array(schemas.SourceApplyResultSchema) }),
  sources_sync: z.object({ results: z.union([z.array(schemas.SourceSyncAdmissionSchema), z.array(schemas.SourceSyncWaitResultSchema)]) }),
  sources_pause: z.object({ id: z.string(), paused: z.boolean(), enabled: z.boolean(), audit_action: z.literal("paused") }),
  sources_resume: z.object({ id: z.string(), paused: z.boolean(), enabled: z.boolean(), audit_action: z.literal("resumed") }),
  backup_create: schemas.BackupCreateResultSchema,
  backup_verify: schemas.BackupVerifyResultSchema,
  recovery_import: schemas.RecoveryImportReportSchema,
  recovery_online: schemas.RecoveryOnlineReportSchema.extend({ worker: schemas.WorkerResultSchema.omit({ worker_id: true }).optional() }),
  doctor: schemas.DoctorReportSchema.extend({ notification: z.object({ notified: z.boolean(),
    reason: z.enum(["unchanged", "increased", "cleared", "notify_unavailable"]),
    stranded: z.number().int().nonnegative(), previous: z.number().int().nonnegative().nullable(),
  }).optional() }),
};

async function invoke(ctx: BrainContext, command: string, commandArgv: string[]): Promise<unknown> {
  if (ctx.controller.signal.aborted) throw new Error("brain_stopping\nStack Brain is stopping");
  const call = withBrainEnvironment(ctx.env, async () => {
    try {
      const text = await withShareIngressToken(ctx.shareToken, () => captureOutput(() => runParsed({
        command, commandArgv, globals: { dbPath: ctx.dbPath, format: "json", quiet: false },
        usesDefaultDb: false, showHelp: false, showVersion: false, showAgentHelp: false, showAgentTeaser: false,
      })));
      return JSON.parse(text).data;
    } catch (error) {
      if (error instanceof CliError) throw new Error([error.code, error.message, error.recovery].filter(Boolean).join("\n"));
      throw error;
    }
  }, ctx.controller.signal);
  ctx.calls.add(call);
  try { return await call; } finally { ctx.calls.delete(call); }
}

const internalOnly = new Set(["guide", "prompt", "help", "worker"]);
const resultFields: Record<string, string> = { jobs_list: "jobs", sources_list: "sources", sources_status: "sources", sources_apply: "results", sources_sync: "results" };
const commandOperations = agentTools(undefined, true).filter((tool) => !internalOnly.has(tool.name)).map((tool) => {
  const output = outputs[tool.name];
  if (!output) throw new Error(`unmapped Brain operation: ${tool.name}`);
  let input = tool.input;
  if (tool.name === "jobs_show") input = input.omit({ "reveal-content": true, actor: true, "max-bytes": true }).strict();
  if (tool.name.startsWith("recovery_")) input = input.omit({ "artifact-store": true }).strict();
  if (tool.name === "backup_create") input = input.omit({ "artifact-root": true }).strict();
  return operation({
  name: tool.name,
  description: tool.name === "jobs_show" ? "Inspect one ingestion job with bounded, sanitized failure diagnostics. Reads no Artifact bodies and appends no audit; use jobs_reveal for explicit sensitive inspection." : `${tool.leaf.summary}. ${tool.leaf.guidance ?? ""}`.slice(0, 400).trim(),
  input,
  output,
  annotations: { ...tool.annotations, title: tool.title.slice(0, 80),
    ...(tool.name === "jobs_show" ? { readOnlyHint: true, idempotentHint: true } : {}),
    ...(tool.name === "recovery_online" ? { openWorldHint: true } : {}),
  },
  async call(ctx: BrainContext, input: Record<string, unknown>) {
    const invocation = invocationFor(tool, input);
    let result: unknown;
    try { result = await invoke(ctx, invocation.command, invocation.commandArgv); } finally {
      // A mutation (or a failed one that may still have committed) is announced without waiting for the next tick.
      if (!tool.annotations.readOnlyHint) ctx.changes?.check();
    }
    // Retagging rewrites FTS rows in place, which no fingerprint sees.
    if (tool.name === "retag" && input["dry-run"] !== true) ctx.changes?.touch("index_changed");
    if (tool.name === "jobs_show") result = { ...(result as object), network_policy: new ResearchEgress(ctx.store).forJob(Number(input["job-id"])) };
    const field = resultFields[tool.name];
    return field ? { [field]: result } : result;
  },
  });
});

function sharePort(env: NodeJS.ProcessEnv): number {
  const value = env.STACK_BRAIN_SHARE_PORT === undefined ? SHARE_DEFAULT_PORT : Number(env.STACK_BRAIN_SHARE_PORT);
  if (env.STACK_BRAIN_SHARE_PORT === "" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("STACK_BRAIN_SHARE_PORT must be an integer from 0 to 65535");
  }
  return value;
}

/** The provider seam is for hermetic tests; production always delegates to Agentscrape. */
export async function createBrainContext(env: NodeJS.ProcessEnv, workerOptions: Pick<WorkerOptions, "extract" | "sourceDiscovery" | "pollMs"> = {}): Promise<BrainContext> {
  return withBrainEnvironment(env, async () => {
    const stateRoot = brainStateRoot();
    const dbPath = join(stateRoot, "research.db");
    const tokenPath = join(stateRoot, "share-token");
    const registrationPath = join(stateRoot, "share-ingress.json");
    const port = sharePort(env);
    const host = env.STACK_BRAIN_SHARE_HOST ?? SHARE_DEFAULT_HOST;
    if (host !== "127.0.0.1") throw new Error("Brain backend must bind 127.0.0.1; configure remote clients through Access");
    assertDefaultDatabaseTargetSafe(dbPath);
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    const store = new ResearchStore(dbPath);
    let server: RunningShareServer | undefined;
    try {
      const artifacts = new ArtifactStore(join(stateRoot, "artifacts"));
      // Legacy shared tokens are never imported or accepted. This ephemeral
      // loopback-only token exists solely for the owner's liveness probe.
      const token = generateShareToken();
      let currentToken = token;
      server = await startShareServer({ store, artifactStore: artifacts, token: () => currentToken, port, host });
      writeIngressRegistration(registrationPath, { version: 1, url: server.url, host, port: server.port, pid: process.pid, started_at: new Date().toISOString() });
      const controller = new AbortController();
      const ctx: BrainContext = { env, stateRoot, dbPath, tokenPath, get shareToken() { return currentToken; }, set shareToken(value) { currentToken = value; }, registrationPath, artifacts, store, server, controller,
        worker: Promise.resolve(null), maintenance: undefined as never, maintenanceTask: null, calls: new Set(), workerState: "running", health: null };
      ctx.worker = withBrainEnvironment(env, () => runWorker(store, {
        ...workerOptions, artifactStore: artifacts, signal: controller.signal, installSignalHandlers: false, shutdownGraceMs: 0,
      }), controller.signal).then((result) => { ctx.workerState = "stopped"; return result; }, () => { ctx.workerState = "failed"; ctx.health = "ingestion_worker_failed"; return null; });
      ctx.maintenance = setInterval(() => {
        if (ctx.maintenanceTask || controller.signal.aborted) return;
        ctx.maintenanceTask = withBrainEnvironment(env, async () => {
          try {
            store.recoverExpiredLeases({ now: new Date() });
            const probe = await probeShareIngress(server!.url, ctx.shareToken, 5000, controller.signal);
            ctx.health = probe.ok ? (ctx.workerState === "failed" ? "ingestion_worker_failed" : null) : "share_ingress_unhealthy";
          } catch { if (!controller.signal.aborted) ctx.health = "ingestion_maintenance_failed"; }
        }, controller.signal).finally(() => { ctx.maintenanceTask = null; });
      }, 60_000);
      return ctx;
    } catch (error) {
      await server?.stop();
      if (server) clearIngressRegistration(registrationPath);
      store.close();
      throw error;
    }
  });
}

export async function closeBrainContext(ctx: BrainContext): Promise<void> {
  if (ctx.closing) return ctx.closing;
  ctx.closing = (async () => {
    ctx.controller.abort();
    clearInterval(ctx.maintenance);
    ctx.changes?.stop();
    try {
      await Promise.allSettled([ctx.server.stop(), ctx.worker, ctx.maintenanceTask, ...ctx.calls]);
    } finally { clearIngressRegistration(ctx.registrationPath); ctx.store.close(); }
  })();
  return ctx.closing;
}

const packageApi: PackageApi<BrainContext, BrainTopic> = {
  http: [{ name: "share", kind: "json", authentication: "bearer",
    description: "Loopback-only internal share listener with ephemeral liveness credential. Devices pair through Access; legacy shared tokens are not accepted.", routes: shareRoutes }],
  operations: [
    operation({ name: "egress_grant_create", description: "Operator-only socket grant for one URL submission root or exact Research source definition version. Allows only explicit TCP IP/port destinations in addition to public egress. Children inherit the scope; existing sources receive no implicit grants. Revoke an existing grant before changing destinations.",
      input: z.strictObject({ scope: grantScope, policy: egressPolicy }), output: grantRecord,
      async call(ctx, input, invocation) {
        if (!operatorInvocation(invocation)) throw new Error("egress_grants_operator_only");
        const result = new ResearchEgress(ctx.store).create(input.scope, input.policy); ctx.changes?.touch("jobs_changed"); return result;
      } }),
    operation({ name: "egress_grant_revoke", description: "Operator-only socket revocation. Queued work rechecks current authority; active engine requests abort on policy invalidation and stale completions are fenced. Does not erase prior research or automatically retry failed jobs.",
      input: z.strictObject({ id: z.number().int().positive() }), output: grantRecord,
      async call(ctx, { id }, invocation) {
        if (!operatorInvocation(invocation)) throw new Error("egress_grants_operator_only");
        const result = new ResearchEgress(ctx.store).revoke(id); ctx.changes?.touch("jobs_changed"); return result;
      } }),
    operation({ name: "egress_grant_list", description: "Operator-only socket inspection of the latest 200 immutable private-destination grants and revocations. Grants are separately attributed operator policy, never submission fields.",
      input: z.strictObject({}), output: z.strictObject({ grants: z.array(grantRecord) }), annotations: { readOnlyHint: true },
      async call(ctx, _input, invocation) { if (!operatorInvocation(invocation)) throw new Error("egress_grants_operator_only"); return { grants: new ResearchEgress(ctx.store).list() }; } }),
    operation({ name: "share_receive", description: "Trusted same-user Access ingress admission. Remote clients cannot call the socket directly; Access records client-bound receipts after this deduplicating admission.",
      input: z.strictObject({ payload: z.unknown() }), output: shareAdmit.output,
      async call(ctx, input) {
        try { return await shareAdmit.call({ store: ctx.store, artifactStore: ctx.artifacts, token: ctx.shareToken }, shareAdmit.input.parse(parseShareRequest(input.payload))); }
        catch (error) { if (error instanceof CliError) throw new Error(error.code); throw error; }
      } }),
    operation({ name: "share_read_states", description: "Trusted same-user read of bounded ingestion states, available to the local UI for its own admissions. Remote clients use Access, which filters IDs through durable client admission receipts.",
      input: shareStates.input, output: shareStates.output, annotations: { readOnlyHint: true },
      async call(ctx, input) { return shareStates.call({ store: ctx.store, token: ctx.shareToken }, input); } }),
    operation({
      name: "brain_status", description: "Read isolated Brain state paths, share ingress address, and ingestion worker health. The token is never returned by this read-only operation.",
      input: z.strictObject({}),
      output: z.object({ stateRoot: z.string(), database: z.string(), artifactStore: z.string(), shareUrl: z.string(), shareTokenFile: z.null(), worker: z.enum(["running", "stopped", "failed"]), health: z.string().nullable() }),
      annotations: { title: "Read Brain status", readOnlyHint: true },
      async call(ctx) { return { stateRoot: ctx.stateRoot, database: ctx.dbPath, artifactStore: join(ctx.stateRoot, "artifacts"), shareUrl: ctx.server.url, shareTokenFile: null, worker: ctx.workerState, health: ctx.health }; },
    }),
    operation({
      name: "jobs_reveal", description: "Reveal a job's submitted intent and captured text Artifacts, appending a sensitive-inspection audit record. Ordinary job inspection uses jobs_show and never returns this content.",
      input: z.strictObject({ "job-id": z.number().int().positive(), actor: z.string().default("operator"), "max-bytes": z.number().int().positive().default(5_000_000) }),
      output: schemas.RevealedJobSchema,
      annotations: { title: "Reveal ingestion job content", readOnlyHint: false, idempotentHint: false },
      async call(ctx, input) { return schemas.RevealedJobSchema.parse(await invoke(ctx, "jobs", ["show", String(input["job-id"]), "--reveal-content", `--actor=${input.actor}`, `--max-bytes=${input["max-bytes"]}`])); },
    }),
    operation({
      name: "recovery_execute", description: "Execute one explicitly authorized recovery Run until no eligible work remains. The persisted authorization digest and exact allowed kinds fence the work; unrelated queue jobs remain outside this scope.",
      input: z.strictObject({ run: z.number().int().positive(), "authorization-digest": z.string().regex(/^[a-f0-9]{64}$/), "allowed-kind": z.array(z.string()).min(1) }),
      output: schemas.WorkerResultSchema,
      annotations: { title: "Execute authorized recovery Run", readOnlyHint: false, openWorldHint: true },
      async call(ctx, input) { return schemas.WorkerResultSchema.parse(await invoke(ctx, "worker", ["--once", `--run=${input.run}`, `--authorization-digest=${input["authorization-digest"]}`, "--shutdown-grace-ms=0", ...input["allowed-kind"].map((kind) => `--allowed-kind=${kind}`)])); },
    }),
    ...commandOperations,
  ],
  events: { topics: brainTopics,
    start(ctx, publish) {
      ctx.changes = watchBrainChanges(ctx.dbPath, publish, { status: () => `${ctx.workerState}:${ctx.health ?? ""}` });
      return () => { ctx.changes?.stop(); ctx.changes = undefined; };
    } },
  createContext: createBrainContext,
  prepareCloseContext(ctx) { ctx.controller.abort(); },
  closeContext: closeBrainContext,
};
export const api = withStateInventory("brain", brainStateCategories, packageApi);
