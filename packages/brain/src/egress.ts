import { z } from "zod";
import { egressPolicy, publicEgress, EgressRefused, type EgressPolicy } from "@agentstack/scrape/network";
import type { ResearchStore } from "./store.js";

export const grantScope = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("job"), id: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("source"), id: z.number().int().positive(), version: z.number().int().positive() }),
]);
export const grantRecord = z.strictObject({ id: z.number().int().positive(), scope: grantScope, policy: egressPolicy,
  createdAt: z.string(), revokedAt: z.string().nullable() });
export const jobNetworkPolicy = z.strictObject({ scope: grantScope, grantId: z.number().int().positive().nullable(), policy: egressPolicy });
type GrantRow = { id: number; scope: string; policy: string; created_at: string; revoked_at: string | null };
const record = (row: GrantRow) => grantRecord.parse({ id: row.id, scope: JSON.parse(row.scope), policy: JSON.parse(row.policy), createdAt: row.created_at, revokedAt: row.revoked_at });

export class ResearchEgress {
  constructor(private readonly store: ResearchStore) {}
  private scope(value: z.infer<typeof grantScope>): string {
    const scope = grantScope.parse(value);
    if (scope.kind === "job") {
      const row = this.store.db.query("SELECT kind,egress_scope FROM jobs WHERE id=?").get(scope.id) as { kind: string; egress_scope: string } | null;
      if (!row || row.kind !== "url") throw new Error("egress_scope_requires_url_job");
      if (row.egress_scope !== JSON.stringify(scope)) throw new Error("egress_grant_requires_root_scope");
    } else {
      const row = this.store.db.query("SELECT definition_version FROM sources WHERE id=?").get(scope.id) as { definition_version: number } | null;
      if (!row || row.definition_version !== scope.version) throw new Error("egress_source_version_changed");
    }
    return JSON.stringify(scope);
  }
  create(scope: z.infer<typeof grantScope>, policy: EgressPolicy) {
    return this.store.db.transaction(() => {
      const key = this.scope(scope);
      const parsed = egressPolicy.parse(policy);
      if (!parsed.privateDestinations.length) throw new Error("egress_grant_requires_destinations");
      const existing = this.store.db.query("SELECT * FROM egress_grants WHERE scope=? AND revoked_at IS NULL").get(key) as GrantRow | null;
      if (existing) {
        if (existing.policy !== JSON.stringify(parsed)) throw new Error("egress_grant_conflict_revoke_first");
        return record(existing);
      }
      const inserted = this.store.db.query("INSERT INTO egress_grants(scope,policy,created_at) VALUES (?,?,?)").run(key, JSON.stringify(parsed), new Date().toISOString());
      return this.get(Number(inserted.lastInsertRowid));
    }).immediate();
  }
  get(id: number) {
    const row = this.store.db.query("SELECT * FROM egress_grants WHERE id=?").get(id) as GrantRow | null;
    if (!row) throw new Error("egress_grant_not_found");
    return record(row);
  }
  list() { return (this.store.db.query("SELECT * FROM egress_grants ORDER BY id DESC LIMIT 200").all() as GrantRow[]).map(record); }
  revoke(id: number) {
    this.get(id);
    this.store.db.query("UPDATE egress_grants SET revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(new Date().toISOString(), id);
    return this.get(id);
  }
  forJob(jobId: number) {
    const row = this.store.db.query("SELECT egress_scope FROM jobs WHERE id=?").get(jobId) as { egress_scope: string } | null;
    if (!row) throw new Error("job_not_found");
    const scope = grantScope.parse(JSON.parse(row.egress_scope));
    // A source edit invalidates its old grants, including previously queued children.
    const source = scope.kind === "source" ? this.store.db.query("SELECT definition_version FROM sources WHERE id=?").get(scope.id) as { definition_version: number } | null : null;
    const grant = scope.kind !== "source" || source?.definition_version === scope.version
      ? this.store.db.query("SELECT * FROM egress_grants WHERE scope=? AND revoked_at IS NULL").get(JSON.stringify(scope)) as GrantRow | null : null;
    return { scope, grantId: grant?.id ?? null, policy: grant ? egressPolicy.parse(JSON.parse(grant.policy)) : publicEgress };
  }
  capture(jobId: number, attemptId: number) {
    const captured = this.forJob(jobId);
    const identity = JSON.stringify(captured);
    this.store.db.query("INSERT INTO egress_attempts(attempt_id,scope,grant_id,policy) VALUES (?,?,?,?)")
      .run(attemptId, JSON.stringify(captured.scope), captured.grantId, JSON.stringify(captured.policy));
    const check = () => {
      const current = this.forJob(jobId);
      if (JSON.stringify(current) !== JSON.stringify(captured)) throw new EgressRefused(captured.grantId ? "egress_grant_revoked" : "egress_policy_changed");
    };
    return { ...captured, check, cache: {
      valid: () => {
        const row = this.store.db.query("SELECT policy_identity FROM egress_extractions WHERE job_id=?").get(jobId) as { policy_identity: string } | null;
        if (row) return row.policy_identity === identity;
        // Existing local artifacts remain readable without performing network I/O.
        // Once this policy-aware worker has attempted extraction, a missing stamp
        // is no longer legacy evidence (it may be an interrupted private extraction).
        return captured.grantId === null && !this.store.db.query("SELECT 1 FROM egress_attempts e JOIN attempts a ON a.id=e.attempt_id WHERE a.job_id=? AND a.id<>? LIMIT 1").get(jobId, attemptId);
      },
      invalidate: () => { this.store.db.query("DELETE FROM egress_extractions WHERE job_id=?").run(jobId); },
      remember: () => { check(); this.store.db.query("INSERT OR REPLACE INTO egress_extractions(job_id,policy_identity) VALUES (?,?)").run(jobId, identity); },
    } };
  }
}
