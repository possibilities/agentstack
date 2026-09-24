import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { WorkerSupervisor } from "./src/supervisor.js";

const id = z.uuid();
const model = z.strictObject({ id: z.string(), name: z.string(), efforts: z.array(z.string()), effortConfigId: z.string().nullable() });
const catalogSchema = z.strictObject({ accountId: id, provider: z.enum(["codex", "grok", "devin"]), observedAt: z.string(),
  source: z.string(), runtimeVersion: z.string(), models: z.array(model), nativeModelIds: z.array(z.string()), stale: z.boolean(), error: z.string().nullable() });

export type WorkersContext = { supervisor: WorkerSupervisor };
export const workerCatalog = operation({
  name: "worker_catalog", description: "Read model and effort choices observed through this account's native ACP session. Refresh on demand; stale results are labelled and never authorize dispatch.",
  input: z.strictObject({ accountId: id, refresh: z.boolean().optional() }), output: catalogSchema,
  annotations: { title: "Account-bound worker catalog", readOnlyHint: true },
  async call(ctx: WorkersContext, { accountId, refresh }) { return ctx.supervisor.catalog(accountId, refresh ?? false); },
});
export const workerRuntimeList = operation({
  name: "worker_runtime_list", description: "Read owned per-account ACP process health without exposing credentials or the ACP pipes.",
  input: z.strictObject({}), output: z.strictObject({ runtimes: z.array(z.strictObject({ id, provider: z.enum(["codex", "grok", "devin"]),
    state: z.enum(["running", "stopped", "error"]), pid: z.number().int().nullable(), error: z.string().nullable() })) }),
  annotations: { title: "List ACP runtimes", readOnlyHint: true },
  async call(ctx: WorkersContext) { return { runtimes: ctx.supervisor.runtimeList() }; },
});
export const workerAccountDrain = operation({
  name: "worker_account_drain", description: "Internal operator lifecycle: stop one exact ACP process before disabling or removing its account.",
  input: z.strictObject({ id }), output: z.strictObject({ id }), annotations: { title: "Drain ACP account", idempotentHint: true },
  async call(ctx: WorkersContext, { id }, invocation) {
    if (invocation?.botId) throw new Error("account lifecycle is operator-only");
    await ctx.supervisor.drain(id);
    return { id };
  },
});

export const topics = { workers_changed: "ACP account process or catalog state changed. Refresh worker_runtime_list or worker_catalog." } as const;
export const api: PackageApi<WorkersContext, keyof typeof topics> = {
  operations: [workerCatalog, workerRuntimeList, workerAccountDrain],
  events: { topics, start(ctx, publish) { ctx.supervisor.onChange = () => publish("workers_changed"); return () => { ctx.supervisor.onChange = undefined; }; } },
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const supervisor = new WorkerSupervisor(dir, env);
    supervisor.start();
    return { supervisor };
  },
  async closeContext(ctx) { await ctx.supervisor.close(); },
};
