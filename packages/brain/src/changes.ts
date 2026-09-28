import { openReadonlyDatabase, type Database } from "./sqlite.js";

export type BrainTopic = "jobs_changed" | "sources_changed" | "index_changed";

/** Invalidation notices only: they carry no values, so a subscriber re-reads what it shows. */
export const brainTopics: Record<BrainTopic, string> = {
  jobs_changed: "The ingestion ledger, effective network policy or ingestion worker health changed. Re-read jobs_stats, jobs_list, inspected jobs_show records and brain_status.",
  sources_changed: "A Research source definition, pause state, Run or checkpoint changed. Re-read sources_list and sources_status.",
  index_changed: "Research documents were added, replaced, retagged or deleted. Re-read stats, tags and any search or document on screen.",
};

// Each fingerprint is a handful of primary-key maxima and counts, so it never reads document bodies.
// Lease heartbeats change no fingerprint and therefore publish nothing.
const fingerprints: Record<BrainTopic, string> = {
  jobs_changed: `SELECT json_array((SELECT max(id) FROM jobs), (SELECT max(id) FROM job_transitions), (SELECT max(id) FROM attempts),
    (SELECT max(id) FROM egress_grants), (SELECT count(*) FROM egress_grants WHERE revoked_at IS NOT NULL),
    (SELECT sum(definition_version) FROM sources)) AS value`,
  sources_changed: `SELECT json_array((SELECT count(*) FROM sources), (SELECT max(updated_at) FROM sources), (SELECT max(id) FROM runs),
    (SELECT max(updated_at) FROM runs), (SELECT max(id) FROM source_audit_events), (SELECT max(id) FROM source_checkpoints)) AS value`,
  index_changed: `SELECT json_array((SELECT max(id) FROM documents), (SELECT count(*) FROM documents), (SELECT max(id) FROM chunks), (SELECT count(*) FROM chunks)) AS value`,
};

export type BrainChanges = {
  /** Compare fingerprints now, even if no other connection has committed. */
  check(): void;
  /** Publish a topic a fingerprint cannot see, such as a retag that rewrites only FTS rows. */
  touch(topic: BrainTopic): void;
  stop(): void;
};

/**
 * Watch Brain's database for commits by any connection (the ingestion worker, share ingress,
 * operation invocations or an external CLI) and publish a topic when its fingerprint changes.
 * A separate read-only connection sees other connections' commits through `PRAGMA data_version`.
 */
export function watchBrainChanges(dbPath: string, publish: (topic: BrainTopic) => void,
  options: { intervalMs?: number; status?: () => string } = {}): BrainChanges {
  let db: Database | null = openReadonlyDatabase(dbPath);
  let version: number | null = null;
  const last = new Map<BrainTopic, string>();
  let status = options.status?.();
  const check = (force: boolean) => {
    if (!db) return;
    try {
      const nextStatus = options.status?.();
      const statusChanged = nextStatus !== status;
      status = nextStatus;
      const current = Number((db.query("PRAGMA data_version").get() as { data_version: number }).data_version);
      const changed = new Set<BrainTopic>(statusChanged ? ["jobs_changed"] : []);
      if (force || current !== version) {
        version = current;
        for (const [topic, sql] of Object.entries(fingerprints) as [BrainTopic, string][]) {
          const value = String((db.query(sql).get() as { value: string }).value);
          const previous = last.get(topic);
          last.set(topic, value);
          if (previous !== undefined && previous !== value) changed.add(topic);
        }
      }
      for (const topic of changed) publish(topic);
    } catch {
      // A busy or migrating database is compared again on the next tick.
    }
  };
  check(true);
  const timer = setInterval(() => check(false), options.intervalMs ?? 1_000);
  timer.unref();
  return {
    check: () => check(true),
    touch: (topic) => { if (db) publish(topic); },
    stop() { clearInterval(timer); db?.close(); db = null; },
  };
}
