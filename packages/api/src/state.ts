import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { operatorInvocation } from "./invocation.js";
import type { InvocationContext } from "./operation.js";

export const stateRevision = z.string().min(1).max(256);
export const stateSubject = z.strictObject({ kind: z.string(), id: z.string() });
export const stateLink = z.strictObject({ package: z.string(), operation: z.string(), arguments: z.record(z.string(), z.unknown()) });
export const stateEntry = z.strictObject({
  id: z.string(), ownerPackage: z.string(), subject: stateSubject.nullable(),
  kind: z.enum(["workspace", "conversation", "queue", "history", "configuration", "credentials", "cache", "runtime", "storage"]),
  authority: z.enum(["authoritative", "derived", "receipt"]), location: z.enum(["server", "client", "external"]),
  ownership: z.enum(["stack", "external", "shared", "unknown"]), revision: stateRevision.nullable(), observedAt: z.iso.datetime(),
  coverage: z.enum(["complete", "partial", "unavailable"]), items: z.number().int().nonnegative().nullable(), bytes: z.number().int().nonnegative().nullable(),
  sensitivity: z.enum(["ordinary", "content", "credential"]),
  relationships: z.array(z.strictObject({ relation: z.string(), package: z.string(), kind: z.string(), id: z.string() })),
  reads: z.array(stateLink), actions: z.array(stateLink.extend({ blockedBy: z.array(z.string()) })),
  retention: z.string(), regeneration: z.string(), issues: z.array(z.string()),
});
export type StateEntry = z.infer<typeof stateEntry>;
export const statePageInput = z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50), revision: stateRevision.optional() });
export const statePage = z.strictObject({ entries: z.array(stateEntry), revision: stateRevision, observedAt: z.iso.datetime(), nextOffset: z.number().int().nullable() });
export type StatePage = z.infer<typeof statePage>;
export const stateDependencies = z.strictObject({ revision: stateRevision, blockedBy: z.array(z.string()), retained: z.array(z.string()),
  relationships: z.array(z.strictObject({ relation: z.string(), package: z.string(), kind: z.string(), id: z.string() })) });
export type StateDependencies = z.infer<typeof stateDependencies>;
export const stateDependencyInput = z.strictObject({ botId: z.string().min(1).max(64), cwd: z.string().max(4096) });
export const stateOutcome = z.strictObject({ resource: z.string(), outcome: z.enum(["removed", "retained", "blocked", "unknown", "pending"]), detail: z.string() });
export type StateOutcome = z.infer<typeof stateOutcome>;
export const statePlan = z.strictObject({
  id: z.uuid(), ownerPackage: z.string(), subject: stateSubject.nullable(), action: z.string(), revision: stateRevision,
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), resources: z.array(z.string()), blockedBy: z.array(z.string()),
  retained: z.array(z.string()), regeneration: z.array(z.string()),
});
export type StatePlan = z.infer<typeof statePlan>;
export const stateApplyInput = z.strictObject({ planId: z.uuid(), expectedRevision: stateRevision, requestId: z.uuid() });
export type StateApplyInput = z.infer<typeof stateApplyInput>;
export const stateReceipt = z.strictObject({
  requestId: z.uuid(), planId: z.uuid(), ownerPackage: z.string(), subject: stateSubject.nullable(), action: z.string(),
  status: z.enum(["running", "completed", "partial", "blocked", "unknown"]), startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(),
  outcomes: z.array(stateOutcome), retained: z.array(z.string()), regeneration: z.array(z.string()),
});
export type StateReceipt = z.infer<typeof stateReceipt>;

export function requireStateOperator(invocation?: InvocationContext): void {
  if (!operatorInvocation(invocation)) throw new Error("state inspection and maintenance require local operator authority");
}
export function stateHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function pageState(entries: StateEntry[], input: z.infer<typeof statePageInput>): StatePage {
  const ordered = [...entries].sort((a, b) => a.id.localeCompare(b.id));
  const revision = stateHash(ordered.map(({ observedAt: _at, ...entry }) => entry));
  if (input.revision && input.revision !== revision) throw new Error("state revision changed; restart paging");
  return { entries: ordered.slice(input.offset, input.offset + input.limit), revision, observedAt: new Date().toISOString(),
    nextOffset: input.offset + input.limit < ordered.length ? input.offset + input.limit : null };
}

/** Owner-local consequence previews and at-most-once admission. Never redispatch an interrupted mutation. */
export class StateJournal {
  private readonly db: DatabaseSync;
  private readonly ownsDatabase: boolean;
  constructor(path: string | DatabaseSync, readonly ownerPackage: string) {
    this.ownsDatabase = typeof path === "string";
    if (typeof path === "string") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (!lstatSync(path).isFile()) throw new Error("state journal must be a regular file");
      chmodSync(path, 0o600);
      this.db = new DatabaseSync(path);
    } else this.db = path;
    // Embedded owners choose their own SQLite mode. In particular, attached
    // Auth/Secrets databases rely on rollback journals for cross-file commits.
    if (this.ownsDatabase) this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state_plans(id TEXT PRIMARY KEY, expires INTEGER NOT NULL, plan TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS state_receipts(id TEXT PRIMARY KEY, digest TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS state_receipt_plan ON state_receipts(json_extract(receipt,'$.planId'));`);
    for (const { id, receipt } of this.db.prepare("SELECT id,receipt FROM state_receipts").all() as { id: string; receipt: string }[]) {
      const value = stateReceipt.parse(JSON.parse(receipt));
      if (value.status === "running") this.finish(id, "unknown", [...value.outcomes,
        { resource: value.planId, outcome: "unknown", detail: "Owner restarted during cleanup. Inspect the exact resources; this request will not execute again." }]);
    }
  }
  close(): void { if (this.ownsDatabase) this.db.close(); }
  plan(input: Omit<StatePlan, "id" | "ownerPackage" | "createdAt" | "expiresAt">, payload: unknown): StatePlan {
    this.db.prepare("DELETE FROM state_plans WHERE expires < ?").run(Date.now());
    const count = this.db.prepare("SELECT count(*) AS n FROM state_plans").get() as { n: number };
    if (count.n >= 1000) throw new Error("too many unexpired state plans; reuse a plan or wait for expiry");
    const value = statePlan.parse({ ...input, id: randomUUID(), ownerPackage: this.ownerPackage,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    const serialized = JSON.stringify(payload);
    if (serialized.length > 2_000_000) throw new Error("state selection exceeds the plan budget; select a smaller scope");
    this.db.prepare("INSERT INTO state_plans VALUES(?,?,?,?)").run(value.id, Date.parse(value.expiresAt), JSON.stringify(value), serialized);
    return value;
  }
  getPlan(id: string): { plan: StatePlan; payload: unknown } {
    const row = this.db.prepare("SELECT plan,payload FROM state_plans WHERE id=?").get(id) as { plan: string; payload: string } | undefined;
    if (!row) throw new Error("state plan missing or consumed; read its receipt or prepare a new plan");
    const plan = statePlan.parse(JSON.parse(row.plan));
    if (Date.parse(plan.expiresAt) < Date.now()) throw new Error("state plan expired; prepare a new plan");
    return { plan, payload: JSON.parse(row.payload) };
  }
  receipt(requestId: string): StateReceipt | null {
    const row = this.db.prepare("SELECT receipt FROM state_receipts WHERE id=?").get(requestId) as { receipt: string } | undefined;
    return row ? stateReceipt.parse(JSON.parse(row.receipt)) : null;
  }
  existing(input: StateApplyInput): StateReceipt | null {
    const row = this.db.prepare("SELECT digest,receipt FROM state_receipts WHERE id=?").get(input.requestId) as { digest: string; receipt: string } | undefined;
    if (!row) return null;
    if (row.digest !== stateHash(input)) throw new Error("state request ID already used for another plan or revision");
    return stateReceipt.parse(JSON.parse(row.receipt));
  }
  begin(input: StateApplyInput, plan: StatePlan): StateReceipt {
    if (plan.id !== input.planId || plan.revision !== input.expectedRevision) throw new Error("state plan revision mismatch");
    const receipt: StateReceipt = { requestId: input.requestId, planId: plan.id, ownerPackage: this.ownerPackage, subject: plan.subject,
      action: plan.action, status: "running", startedAt: new Date().toISOString(), completedAt: null, outcomes: [], retained: plan.retained, regeneration: plan.regeneration };
    this.db.prepare("INSERT INTO state_receipts VALUES(?,?,?)").run(input.requestId, stateHash(input), JSON.stringify(receipt));
    return receipt;
  }
  finish(requestId: string, status: StateReceipt["status"], outcomes: StateOutcome[]): StateReceipt {
    const old = this.receipt(requestId);
    if (!old) throw new Error("unknown state request");
    const receipt = stateReceipt.parse({ ...old, status, outcomes, completedAt: status === "running" ? null : new Date().toISOString() });
    const transaction = !this.db.isTransaction;
    if (transaction) this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE state_receipts SET receipt=? WHERE id=?").run(JSON.stringify(receipt), requestId);
      if (status !== "running") this.db.prepare("DELETE FROM state_plans WHERE id=?").run(old.planId);
      if (transaction) this.db.exec("COMMIT");
    } catch (error) { if (transaction) this.db.exec("ROLLBACK"); throw error; }
    return receipt;
  }

  /** For synchronous owner mutations sharing this exact database: effects and receipt commit together. */
  atomic(input: StateApplyInput, verify: (plan: StatePlan, payload: unknown) => void, apply: (payload: unknown) => StateOutcome[]): StateReceipt {
    const existing = this.existing(input); if (existing) return existing;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const { plan, payload } = this.getPlan(input.planId);
      verify(plan, payload);
      if (plan.blockedBy.length) throw new Error(plan.blockedBy.join("; "));
      this.begin(input, plan);
      const receipt = this.finish(input.requestId, "completed", apply(payload));
      this.db.exec("COMMIT");
      return receipt;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
