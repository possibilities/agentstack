/**
 * The Chrome client's share history and how each entry reads in the popover.
 * Plain JavaScript for the same reason as the outbox test: the extension is,
 * and `tsconfig.json` includes only TypeScript.
 *
 * `chrome.storage.local` is the only surface stubbed — the history is storage
 * and derivation, with no browser behavior of its own.
 */

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const storage = new Map();

globalThis.chrome = {
  storage: {
    local: {
      async get(defaults) {
        const out = {};
        for (const [key, fallback] of Object.entries(defaults)) {
          out[key] = storage.has(key) ? storage.get(key) : fallback;
        }
        return out;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) {
          storage.set(key, value);
        }
      },
    },
  },
};

const {
  applyLedgerStates,
  clearHistory,
  HISTORY_MAX_ENTRIES,
  OUTCOME,
  pendingJobIds,
  readHistory,
  record,
  removeHistory,
} = await import("../history.js");
const { hostFor, labelFor, statusFor } = await import(
  "../status.js"
);

beforeEach(() => {
  storage.clear();
});

test("a held share becomes one row that delivery updates in place", async () => {
  await record({
    id: "entry-1",
    payload: { url: "https://example.com/post", title: "A post" },
    outcome: OUTCOME.HELD,
    message: "Cannot reach the ingress.",
  });
  let entries = await readHistory();
  assert.equal((entries).length, 1);
  assert.partialDeepStrictEqual(entries[0], {
    outcome: OUTCOME.HELD,
    url: "https://example.com/post",
    job: null,
  });
  const sharedAt = entries[0].sharedAt;

  // The same outbox entry delivered later is the same share, not a second one.
  await record({
    id: "entry-1",
    payload: { url: "https://example.com/post", title: "A post" },
    outcome: OUTCOME.SENT,
    job: 4321,
  });
  entries = await readHistory();
  assert.equal((entries).length, 1);
  assert.partialDeepStrictEqual(entries[0], { outcome: OUTCOME.SENT, job: 4321 });
  // Ordering follows when the user shared, not when delivery happened.
  assert.equal(entries[0].sharedAt, sharedAt);
});

test("history is newest first and bounded", async () => {
  for (let index = 0; index < HISTORY_MAX_ENTRIES + 5; index += 1) {
    await record({
      id: `entry-${index}`,
      payload: { url: `https://example.com/${index}` },
      outcome: OUTCOME.SENT,
      job: index,
    });
  }
  const entries = await readHistory();
  assert.equal((entries).length, HISTORY_MAX_ENTRIES);
  assert.equal(entries[0].job, HISTORY_MAX_ENTRIES + 4);
  assert.equal(await clearHistory(), HISTORY_MAX_ENTRIES);
  assert.deepEqual(await readHistory(), []);
});

test("a removed row stays gone when a held share is later delivered", async () => {
  await record({
    id: "held",
    payload: { url: "https://example.com/held" },
    outcome: OUTCOME.HELD,
  });

  assert.equal(await removeHistory("held"), true);
  assert.equal(await removeHistory("held"), false);
  assert.deepEqual(await readHistory(), []);

  assert.equal(await record({
      id: "held",
      payload: { url: "https://example.com/held" },
      outcome: OUTCOME.SENT,
      job: 42,
    }), null);
  assert.deepEqual(await readHistory(), []);
});

test("only unsettled jobs are asked about, and the ingress's word wins", async () => {
  await record({
    id: "a",
    payload: { url: "https://example.com/a" },
    outcome: OUTCOME.SENT,
    job: 1,
  });
  await record({
    id: "b",
    payload: { url: "https://example.com/b" },
    outcome: OUTCOME.SENT,
    job: 2,
  });
  await record({
    id: "c",
    payload: { url: "https://example.com/c" },
    outcome: OUTCOME.HELD,
  });

  // Held shares have no job identity yet; there is nothing to ask about.
  assert.deepEqual(pendingJobIds(await readHistory()).sort(), [1, 2]);

  await applyLedgerStates([
    { job_id: 1, state: "completed", failure_class: null, document_id: 970 },
    { job_id: 2, state: "running", failure_class: null, document_id: null },
  ]);
  const entries = await readHistory();
  const byJob = new Map(entries.map((entry) => [entry.job, entry]));
  assert.deepEqual(byJob.get(1).ledger, {
    state: "completed",
    failureClass: null,
    documentId: 970,
  });

  // A terminal job stops being asked about; one still moving does not.
  assert.deepEqual(pendingJobIds(entries), [2]);

  // An id the ingress does not report leaves its entry untouched.
  await applyLedgerStates([
    { job_id: 2, state: "completed", failure_class: null, document_id: 971 },
  ]);
  assert.equal((await readHistory()).find((e) => e.job === 1).ledger.documentId, 970);
});

test("the ledger outranks the client's memory of delivery", async () => {
  const sent = {
    id: "x",
    url: "https://example.com/x",
    title: "X",
    text: null,
    outcome: OUTCOME.SENT,
    job: 7,
    message: null,
    ledger: null,
  };
  assert.partialDeepStrictEqual(statusFor(sent), { label: "Sent", tone: "sent" });

  assert.partialDeepStrictEqual(statusFor({
      ...sent,
      ledger: { state: "completed", failureClass: null, documentId: 970 },
    }), { label: "Indexed", detail: "Document 970." });

  // A job in failed with a failure class is stranded — the ledger's word.
  assert.partialDeepStrictEqual(statusFor({
      ...sent,
      ledger: { state: "failed", failureClass: "permanent", documentId: null },
    }), { label: "Stranded", tone: "problem" });

  assert.partialDeepStrictEqual(statusFor({
      ...sent,
      ledger: { state: "running", failureClass: null, documentId: null },
    }), { label: "Indexing", tone: "working" });
});

test("a held share never reads as saved", async () => {
  const status = statusFor({
    id: "h",
    url: "https://example.com/h",
    title: null,
    text: null,
    outcome: OUTCOME.HELD,
    job: null,
    message: "Cannot reach AgentStack.",
    ledger: null,
  });
  assert.equal(status.label, "Held");
  assert.equal(status.detail, "Cannot reach AgentStack.");
  for (const word of ["saved", "queued", "accepted", "indexed"]) {
    assert.equal((`${status.label} ${status.detail}`.toLowerCase()).includes(word), false);
  }
});

test("an entry names itself by title, then URL, then text", () => {
  assert.equal(labelFor({ title: "A post", url: "https://example.com/p" }), "A post");
  assert.equal(labelFor({ title: null, url: "https://example.com/p" }), "https://example.com/p");
  assert.equal(labelFor({ title: null, url: null, text: "a note worth keeping" }), "a note worth keeping");
  assert.equal(hostFor({ url: "https://example.com/p" }), "example.com");
  assert.equal(hostFor({ url: null }), "text note");
});

test("job IDs are observed only at their bound destination", async () => {
  await record({ id: "a", payload: { text: "First" }, outcome: OUTCOME.SENT, job: 1, destination: "https://first.example" });
  await record({ id: "b", payload: { text: "Second" }, outcome: OUTCOME.SENT, job: 1, destination: "https://second.example" });
  assert.deepEqual(pendingJobIds(await readHistory(), "https://second.example"), [1]);
  await applyLedgerStates([{ job_id: 1, state: "completed", document_id: 10 }], Date.now(), "https://second.example");
  const entries = await readHistory();
  assert.equal(entries.find((e) => e.id === "a").ledger, null);
  assert.equal(entries.find((e) => e.id === "b").ledger.documentId, 10);
});

test("concurrent history updates do not lose shares and delivery retains chronological position", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => record({ id: `c${i}`, payload: { text: String(i) }, outcome: OUTCOME.HELD }, i)));
  assert.equal((await readHistory()).length, 10);
  await record({ id: "c0", payload: { text: "0" }, outcome: OUTCOME.SENT, job: 123 }, 20);
  assert.equal((await readHistory()).at(-1).id, "c0");
});
