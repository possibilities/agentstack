/**
 * Share history for the AgentStack Chrome client.
 *
 * The Share outbox holds only what has *not* been delivered: the moment the
 * ingress admits a share its entry is gone, so nothing in this extension could
 * answer "what did I send, and what became of it". This is that record — the
 * last few shares and the last thing known about each, in
 * `chrome.storage.local` so it survives the MV3 service worker.
 *
 * It is client state, like the outbox, and equally not the ledger. `held` here
 * is never *saved*: nothing exists in AgentStack until Admission answers, and
 * everything past that point is echoed from the ingress rather than decided
 * here. An entry's `job` is the identity Admission returned; `ledger` is
 * whatever the ingress last said became of that job.
 */

import { updateStorage } from "./storage.js";

export const HISTORY_KEY = "agentstack.chrome.share.history.v1";
const REMOVED_HISTORY_KEY = "agentstack.chrome.share.history-removed.v1";

/** The popover shows a reading run, not an archive. */
export const HISTORY_MAX_ENTRIES = 20;

/** Enough removals to cover every share the outbox can hold. */
const REMOVED_HISTORY_MAX_ENTRIES = 200;

async function readHistoryState() {
  const stored = await chrome.storage.local.get({
    [HISTORY_KEY]: [],
    [REMOVED_HISTORY_KEY]: [],
  });
  return {
    entries: Array.isArray(stored[HISTORY_KEY]) ? stored[HISTORY_KEY] : [],
    removed: Array.isArray(stored[REMOVED_HISTORY_KEY])
      ? stored[REMOVED_HISTORY_KEY]
      : [],
  };
}

export async function readHistory() {
  return (await readHistoryState()).entries;
}

async function writeHistory(entries) {
  await chrome.storage.local.set({
    [HISTORY_KEY]: entries.slice(0, HISTORY_MAX_ENTRIES),
  });
}

/** What the popover shows about a share, independent of any icon or wording. */
export const OUTCOME = {
  HELD: "held",
  SENT: "sent",
  DUPLICATE: "duplicate",
  INDEXED: "already_indexed",
  REJECTED: "rejected",
  ABANDONED: "abandoned",
  DISCARDED: "discarded",
};

function describe(payload) {
  return {
    url: payload?.url ?? null,
    title: payload?.title ?? null,
    text: payload?.url ? null : (payload?.text ?? null),
  };
}

/**
 * Records an outcome for one share, keyed by the outbox entry id when the
 * share was ever held so a later delivery updates that same row rather than
 * appending a second one for the same link.
 */
export async function record(
  { id, payload, outcome, job, message, destination },
  now = Date.now(),
) {
  return updateStorage(async () => {
    const { entries, removed } = await readHistoryState();
    const key = id ?? crypto.randomUUID();
    if (removed.includes(key)) return null;
    const existing = entries.find((entry) => entry.id === key);
    const updated = {
      id: key,
      ...describe(payload),
      outcome,
      job: job ?? existing?.job ?? null,
      destination: destination ?? existing?.destination ?? null,
      message: message ?? null,
      // First seen keeps a held share in place while it retries; the popover
      // orders by when the user shared, not by when delivery happened.
      sharedAt: existing?.sharedAt ?? now,
      updatedAt: now,
      ledger: existing?.ledger ?? null,
    };
    const rest = entries.filter((entry) => entry.id !== key);
    await writeHistory([updated, ...rest].sort((a, b) => b.sharedAt - a.sharedAt));
    return updated;
  });
}

/**
 * Folds ingress-reported job states into the history. The ingress is the only
 * authority here: an entry whose job it does not report keeps what it had.
 */
export async function applyLedgerStates(states, now = Date.now(), destination = null) {
  return updateStorage(async () => {
    if (states.length === 0) return await readHistory();
    const byJob = new Map(states.map((state) => [state.job_id, state]));
    const entries = await readHistory();
    let changed = false;
    const merged = entries.map((entry) => {
      if (entry.destination !== destination) return entry;
      const state = entry.job === null ? undefined : byJob.get(entry.job);
      if (state === undefined) return entry;
      const ledger = {
        state: state.state,
        failureClass: state.failure_class ?? null,
        documentId: state.document_id ?? null,
      };
      if (JSON.stringify(entry.ledger) === JSON.stringify(ledger)) return entry;
      changed = true;
      return { ...entry, ledger, updatedAt: now };
    });
    if (changed) await writeHistory(merged);
    return merged;
  });
}

/** Job ids worth asking the ingress about: everything not already terminal. */
export function pendingJobIds(entries, destination = null) {
  const terminal = new Set(["completed", "failed", "excluded", "cancelled"]);
  return entries
    .filter((entry) => entry.destination === destination && entry.job !== null && !terminal.has(entry.ledger?.state))
    .map((entry) => entry.job);
}

export async function clearHistory() {
  return updateStorage(async () => {
    const { entries, removed } = await readHistoryState();
    await chrome.storage.local.set({
      [HISTORY_KEY]: [],
      [REMOVED_HISTORY_KEY]: removedIds(
        entries.map((entry) => entry.id),
        removed,
      ),
    });
    return entries.length;
  });
}

/** Removes one local row without cancelling delivery or deleting a Resource. */
export async function removeHistory(id) {
  return updateStorage(async () => {
    const { entries, removed } = await readHistoryState();
    if (!entries.some((entry) => entry.id === id)) return false;
    await chrome.storage.local.set({
      [HISTORY_KEY]: entries.filter((entry) => entry.id !== id),
      [REMOVED_HISTORY_KEY]: removedIds([id], removed),
    });
    return true;
  });
}

function removedIds(newIds, existing) {
  return [...new Set([...newIds, ...existing])].slice(
    0,
    REMOVED_HISTORY_MAX_ENTRIES,
  );
}
