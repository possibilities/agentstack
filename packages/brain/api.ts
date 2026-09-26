import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { ArtifactStore } from "./src/artifacts.js";
import { runParsed } from "./src/dispatch.js";
import { CliError } from "./src/errors.js";
import { captureOutput } from "./src/format.js";
import { agentTools, invocationFor } from "./src/mcp-tools.js";
import * as schemas from "./src/output-schemas.js";
import { assertDefaultDatabaseTargetSafe, brainStateRoot, withBrainEnvironment } from "./src/paths.js";
import { generateShareToken, readShareToken, writeShareToken, SHARE_DEFAULT_HOST, SHARE_DEFAULT_PORT } from "./src/share.js";
import { clearIngressRegistration, probeShareIngress, writeIngressRegistration } from "./src/share-liveness.js";
import { startShareServer, type RunningShareServer } from "./src/share-server.js";
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
  jobs_show: schemas.SafeJobRecordSchema,
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
  doctor: schemas.DoctorReportSchema,
};

async function invoke(ctx: BrainContext, command: string, commandArgv: string[]): Promise<unknown> {
  if (ctx.controller.signal.aborted) throw new Error("brain_stopping\nAgentStack Brain is stopping");
  const call = withBrainEnvironment(ctx.env, async () => {
    try {
      const text = await captureOutput(() => runParsed({
        command, commandArgv, globals: { dbPath: ctx.dbPath, format: "json", quiet: false },
        usesDefaultDb: false, showHelp: false, showVersion: false, showAgentHelp: false, showAgentTeaser: false,
      }));
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
    const result = await invoke(ctx, invocation.command, invocation.commandArgv);
    const field = resultFields[tool.name];
    return field ? { [field]: result } : result;
  },
  });
});

function sharePort(env: NodeJS.ProcessEnv): number {
  const value = env.AGENTSTACK_BRAIN_SHARE_PORT === undefined ? SHARE_DEFAULT_PORT : Number(env.AGENTSTACK_BRAIN_SHARE_PORT);
  if (env.AGENTSTACK_BRAIN_SHARE_PORT === "" || !Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error("AGENTSTACK_BRAIN_SHARE_PORT must be an integer from 0 to 65535");
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
    const host = env.AGENTSTACK_BRAIN_SHARE_HOST ?? SHARE_DEFAULT_HOST;
    if (!host.trim()) throw new Error("AGENTSTACK_BRAIN_SHARE_HOST must not be empty");
    assertDefaultDatabaseTargetSafe(dbPath);
    mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    chmodSync(stateRoot, 0o700);
    const store = new ResearchStore(dbPath);
    let server: RunningShareServer | undefined;
    try {
      const artifacts = new ArtifactStore(join(stateRoot, "artifacts"));
      if (!existsSync(tokenPath)) writeShareToken(tokenPath, generateShareToken());
      const token = readShareToken(tokenPath);
      chmodSync(tokenPath, 0o600);
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
    try {
      await Promise.allSettled([ctx.server.stop(), ctx.worker, ctx.maintenanceTask, ...ctx.calls]);
    } finally { clearIngressRegistration(ctx.registrationPath); ctx.store.close(); }
  })();
  return ctx.closing;
}

export const api: PackageApi<BrainContext> = {
  operations: [
    operation({
      name: "brain_status", description: "Read isolated Brain state paths, share ingress address, and ingestion worker health. The token is never returned by this read-only operation.",
      input: z.strictObject({}),
      output: z.object({ stateRoot: z.string(), database: z.string(), artifactStore: z.string(), shareUrl: z.string(), shareTokenFile: z.string(), worker: z.enum(["running", "stopped", "failed"]), health: z.string().nullable() }),
      annotations: { title: "Read Brain status", readOnlyHint: true },
      async call(ctx) { return { stateRoot: ctx.stateRoot, database: ctx.dbPath, artifactStore: join(ctx.stateRoot, "artifacts"), shareUrl: ctx.server.url, shareTokenFile: ctx.tokenPath, worker: ctx.workerState, health: ctx.health }; },
    }),
    operation({
      name: "jobs_reveal", description: "Reveal a job's submitted intent and captured text Artifacts, appending a sensitive-inspection audit record. Ordinary job inspection uses jobs_show and never returns this content.",
      input: z.strictObject({ "job-id": z.number().int().positive(), actor: z.string().default("operator"), "max-bytes": z.number().int().positive().default(5_000_000) }),
      output: schemas.RevealedJobSchema,
      annotations: { title: "Reveal ingestion job content", readOnlyHint: false, idempotentHint: false },
      async call(ctx, input) { return schemas.RevealedJobSchema.parse(await invoke(ctx, "jobs", ["show", String(input["job-id"]), "--reveal-content", `--actor=${input.actor}`, `--max-bytes=${input["max-bytes"]}`])); },
    }),
    operation({
      name: "share_token_reveal", description: "Explicitly reveal the private bearer token for configuring an AgentStack device client. This sensitive operation is excluded from read-only access.",
      input: z.strictObject({ reveal: z.literal(true) }), output: z.object({ token_file: z.string(), token: z.string() }),
      annotations: { title: "Reveal share token", readOnlyHint: false },
      async call(ctx) { return { token_file: ctx.tokenPath, token: ctx.shareToken }; },
    }),
    operation({
      name: "share_token_rotate", description: "Generate a fresh private bearer token and immediately replace the token accepted by the running share ingress. Existing device clients must be configured with the returned token.",
      input: z.strictObject({}), output: z.object({ token_file: z.string(), token: z.string() }),
      annotations: { title: "Rotate share token", readOnlyHint: false, idempotentHint: false },
      async call(ctx) {
        if (ctx.controller.signal.aborted) throw new Error("brain_stopping\nAgentStack Brain is stopping");
        const token = generateShareToken(); writeShareToken(ctx.tokenPath, token); ctx.shareToken = token;
        return { token_file: ctx.tokenPath, token };
      },
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
  createContext: createBrainContext,
  prepareCloseContext(ctx) { ctx.controller.abort(); },
  closeContext: closeBrainContext,
};
