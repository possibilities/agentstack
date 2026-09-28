import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier) ? `${specifier}.ts` : specifier, context);
} });
const brain = await import("../lib/stack/brain.ts");

test("admission text never claims indexing that has not happened", () => {
  assert.equal(brain.admissionText({ version: 1, status: "queued", job_id: 4, idempotency_key: "k", intent_hash: "h", state: "queued" }), "Admitted as job 4");
  assert.equal(brain.admissionText({ version: 1, status: "duplicate", job_id: 4, idempotency_key: "k", intent_hash: "h", state: "running" }), "Duplicate of job 4");
  assert.equal(brain.admissionText({ version: 1, status: "already_indexed", document_id: 9, resource_key: "r" }), "Already indexed as document 9");
});

test("job dispositions mirror the ledger's legal transitions", () => {
  assert.deepEqual(brain.jobActions("failed"), ["retry", "cancel", "exclude"]);
  assert.deepEqual(brain.jobActions("running"), ["cancel"]);
  assert.deepEqual(brain.jobActions("queued"), ["cancel", "exclude"]);
  assert.deepEqual(brain.jobActions("excluded"), ["retry"]);
  assert.deepEqual(brain.jobActions("completed"), []);
});

test("merged state lists are newest first without duplicates, and tab counts come from stats", () => {
  const job = (id, updated_at) => ({ id, updated_at });
  assert.deepEqual(brain.mergeJobs([[job(1, "2026-01-02"), job(3, "2026-01-01")], [job(2, "2026-01-03"), job(1, "2026-01-02")]]).map((item) => item.id), [2, 1, 3]);
  const stats = { total: 10, by_state: { queued: 1, running: 1, retry_wait: 1, blocked: 1, failed: 2, completed: 3, excluded: 1, cancelled: 0 } };
  assert.equal(brain.viewCount(stats, "attention"), 4);
  assert.equal(brain.viewCount(stats, "active"), 2);
  assert.equal(brain.viewCount(stats, "done"), 4);
  assert.equal(brain.viewCount(stats, "all"), 10);
  assert.equal(brain.viewCount(null, "all"), null);
});

test("snippets split on Brain's match markers and context copies in rank order", () => {
  assert.deepEqual(brain.snippetParts("a ⟦quasar⟧ b ⟦x⟧"), [{ text: "a ", match: false }, { text: "quasar", match: true }, { text: " b ", match: false }, { text: "x", match: true }]);
  assert.deepEqual(brain.snippetParts("plain"), [{ text: "plain", match: false }]);
  assert.equal(brain.contextText([{ citation: "[1] A", content: " one \n" }, { citation: "[2] B", content: "two" }]), "[1] A\n\none\n\n---\n\n[2] B\n\ntwo");
});

test("a chunk is located by offsets only in an untruncated body, otherwise by its text", () => {
  assert.deepEqual(brain.chunkRange("0123456789", false, { start_char: 2, end_char: 5 }), [2, 5]);
  assert.deepEqual(brain.chunkRange("head … tail text here", true, { start_char: 900, end_char: 909, content: "tail text" }), [7, 16]);
  assert.equal(brain.chunkRange("head … tail", true, { start_char: 900, end_char: 909, content: "omitted middle" }), null);
  assert.equal(brain.chunkRange("head", true, { start_char: 0, end_char: 2 }), null);
});

test("only set filters are sent, labels stay page-local, and only http(s) sources open", () => {
  assert.deepEqual(brain.filterArgs({ tag: "audio", collection: " ", "date-from": " 2026-01-01 " }), { tag: "audio", "date-from": "2026-01-01" });
  assert.equal(brain.submissionLabel("https://www.example.com/a/b?c=1", "url", ""), "www.example.com/a/b");
  assert.equal(brain.submissionLabel("first line\nsecond", "text", ""), "first line");
  assert.equal(brain.submissionLabel("anything", "text", " Named "), "Named");
  assert.equal(brain.externalHref("javascript:alert(1)"), null);
  assert.equal(brain.externalHref("file:///etc/passwd"), null);
  assert.equal(brain.externalHref("https://example.com/x"), "https://example.com/x");
  assert.equal(brain.sourceHost("https://www.example.com/path"), "example.com");
});

test("status issues name a stopped worker and unhealthy ingress once, and remote sessions are read-only", () => {
  const status = { stateRoot: "/s", database: "/d", artifactStore: "/a", shareUrl: "u", shareTokenFile: null, worker: "running", health: null };
  assert.deepEqual(brain.statusIssues(status), []);
  assert.deepEqual(brain.statusIssues({ ...status, worker: "failed", health: "ingestion_worker_failed" }), ["Ingestion worker failed"]);
  assert.deepEqual(brain.statusIssues({ ...status, health: "share_ingress_unhealthy" }), ["Share ingress unhealthy"]);
  assert.equal(brain.brainLocalReason(null), null);
  assert.equal(brain.brainLocalReason({ scope: "control" }), "Available only on the local UIX");
});

test("a timeout is an unknown outcome and codes read as sentences", () => {
  assert.deepEqual(brain.brainCallError(new Error("brain/submit timed out")), { text: "Outcome unknown: brain/submit timed out", uncertain: true });
  assert.deepEqual(brain.brainCallError(new Error("idempotency_conflict\nkey reused")), { text: "idempotency_conflict: key reused", uncertain: false });
  assert.equal(brain.cadence(3600), "1h");
  assert.equal(brain.cadence(90), "90s");
  assert.equal(brain.formatBytes(2048), "2.0 KB");
});
