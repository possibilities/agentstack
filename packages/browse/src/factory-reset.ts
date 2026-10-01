import { z } from "zod";
import { readInstallationFence, stateHash, type StateJournal, type StateOutcome } from "@stack/api";
import type { Backend } from "./backend.js";

export const browserResetSnapshot = z.strictObject({ provider: z.string().nullable(),
  claims: z.array(z.strictObject({ session: z.string(), lease: z.string(), profile: z.string(), persistent: z.boolean() })),
  resources: z.array(z.strictObject({ id: z.string(), name: z.string(), kind: z.enum(["instance", "volume"]), session: z.string(), lease: z.string(), role: z.string() })),
  blockedBy: z.array(z.string()), revision: z.string() });
export type BrowserResetSnapshot = z.infer<typeof browserResetSnapshot>;
export async function clearBrowserFactoryReset(backend: Backend, journal: StateJournal, env: NodeJS.ProcessEnv, requestId: string, snapshot: BrowserResetSnapshot, drain: () => Promise<void>) {
  const fence = readInstallationFence(env);
  if (!fence || fence.requestId !== requestId || fence.browserRevision !== snapshot.revision || snapshot.revision !== stateHash([snapshot.provider, snapshot.claims, snapshot.resources, snapshot.blockedBy])) throw new Error("No exact admitted installation reset scope");
  const existing = journal.receipt(requestId);
  if (existing) { if (existing.action !== "factory_reset" || existing.subject?.id !== snapshot.revision) throw new Error("Browser reset request conflicts with original scope"); return existing; }
  const plan = journal.plan({ subject: { kind: "installation", id: snapshot.revision }, action: "factory_reset", revision: snapshot.revision, resources: snapshot.resources.map(row => row.id), blockedBy: [],
    retained: ["Foreign/unattributed provider resources and external backups remain"], regeneration: ["No browser provisioning or restart by reset"] }, {});
  journal.begin({ planId: plan.id, expectedRevision: plan.revision, requestId }, plan);
  const outcomes: StateOutcome[] = [];
  try {
    await drain();
    await backend.factoryResetClear(snapshot, outcome => { outcomes.push(outcome); journal.finish(requestId, "running", outcomes); });
    return journal.finish(requestId, "completed", outcomes);
  } catch { return journal.finish(requestId, outcomes.length ? "partial" : "unknown", [...outcomes, ...snapshot.resources.filter(row => !outcomes.some(outcome => outcome.resource === row.id)).map(row => ({ resource: row.id, outcome: "unknown" as const, detail: "Exact provider effect not verified; inspection required, never redispatch this request" }))]); }
}
