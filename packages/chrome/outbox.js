/**
 * Durable share outbox for the AgentStack Chrome client.
 *
 * A share the ingress never received is not a failed share: it is one that has
 * not been delivered yet. Entries live in `chrome.storage.local` — which
 * survives the MV3 service worker being torn down, a browser restart, and the
 * server being down for days — and are redelivered until the ingress admits
 * them or classifies them as unsendable.
 *
 * The outbox holds intent only. It is not a queue in the AgentStack sense: no
 * job exists until Admission creates one, so nothing here may be reported to
 * the user as saved. Redelivery is safe without a client idempotency key
 * because the ingress derives the key from the intent, so a share delivered
 * twice returns `duplicate` naming the same job.
 */

import { isRetryable } from "./shared.js";
import { updateStorage } from "./storage.js";

export const OUTBOX_KEY = "agentstack.chrome.share.outbox.v1";
export const OUTBOX_ALARM = "agentstack.chrome.share.outbox.flush";

/** Beyond this the oldest pending shares are dropped rather than grown without bound. */
export const OUTBOX_MAX_ENTRIES = 200;

/** A share nobody has been able to deliver for a week is abandoned, with notice. */
export const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Backoff between delivery attempts, in milliseconds. The first step is one
 * minute because `chrome.alarms` will not fire sooner than that; the last step
 * repeats for every further attempt.
 */
const BACKOFF_MS = [60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000];

export function backoffMs(attempts) {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index];
}

export async function readOutbox() {
  const stored = await chrome.storage.local.get({ [OUTBOX_KEY]: [] });
  const entries = stored[OUTBOX_KEY];
  return Array.isArray(entries) ? entries : [];
}

async function writeOutbox(entries) {
  await chrome.storage.local.set({ [OUTBOX_KEY]: entries });
}

export async function outboxCount() {
  return (await readOutbox()).length;
}

/**
 * Appends one share payload and returns {entry, dropped} — `dropped` naming any
 * entries evicted to stay under the cap. The newest share is always kept: it is
 * the one the user just asked for.
 */
export async function enqueue(payload, now = Date.now(), destination = null) {
  const entry = {
    id: crypto.randomUUID(),
    payload,
    destination,
    createdAt: now,
    attempts: 0,
    nextAttemptAt: now + backoffMs(1),
    lastCode: null,
    lastMessage: null,
  };
  return updateStorage(async () => {
    const entries = [...(await readOutbox()), entry];
    const overflow = Math.max(entries.length - OUTBOX_MAX_ENTRIES, 0);
    const dropped = entries.slice(0, overflow);
    const kept = entries.slice(overflow);
    await writeOutbox(kept);
    return { entry, dropped, pending: kept.length };
  });
}

export async function clearOutbox() {
  return (await discardOutbox()).length;
}

/** Returns the exact discarded snapshot so the history cannot miss a concurrent arrival. */
export async function discardOutbox() {
  return updateStorage(async () => {
    const entries = await readOutbox();
    await writeOutbox([]);
    return entries;
  });
}

function deferred(entry, now, result) {
  const attempts = entry.attempts + 1;
  return {
    ...entry,
    attempts,
    nextAttemptAt: now + backoffMs(attempts),
    lastCode: result?.code ?? null,
    lastMessage: result?.message ?? null,
  };
}

/**
 * Attempts delivery of every due entry through `send`, which must have
 * `postShare`'s shape.
 *
 * The first unreachable server ends the round: the remaining entries are
 * deferred unattempted rather than each paying its own connection timeout
 * against a host that is plainly down.
 *
 * Returns a summary; entries that were admitted are removed, retryable
 * failures are rescheduled, and permanent rejections are dropped and reported
 * so a payload the ingress will never accept cannot wedge the outbox.
 */
export async function flushOutbox(
  send,
  { now = Date.now(), force = false, destination = null } = {},
) {
  // Bind previously unconfigured shares before any network attempt. Token
  // rotation can repair authentication, but changing servers cannot reroute them.
  const entries = await updateStorage(async () => {
    const entries = (await readOutbox()).map((entry) =>
      entry.destination == null ? { ...entry, destination } : entry,
    );
    await writeOutbox(entries);
    return entries;
  });
  const summary = {
    attempted: 0,
    delivered: 0,
    duplicate: 0,
    // Which entries the ingress answered for, so the caller can record what
    // became of each rather than only how many.
    settled: [],
    dropped: [],
    pending: entries.length,
    offline: false,
    otherDestination: 0,
  };
  if (entries.length === 0) return summary;

  const kept = [];
  const processed = new Set();

  for (const entry of entries) {
    processed.add(entry.id);
    if (now - entry.createdAt > OUTBOX_MAX_AGE_MS) {
      summary.dropped.push({ entry, reason: "expired" });
      continue;
    }
    if (entry.destination !== destination) {
      summary.otherDestination += 1;
      kept.push(entry);
      continue;
    }
    if (summary.offline || (!force && entry.nextAttemptAt > now)) {
      kept.push(summary.offline ? deferred(entry, now, null) : entry);
      continue;
    }

    summary.attempted += 1;
    const result = await send(entry.payload);
    if (result.ok) {
      if (result.data?.status === "duplicate") summary.duplicate += 1;
      else summary.delivered += 1;
      summary.settled.push({ entry, result });
      continue;
    }
    if (!isRetryable(result)) {
      summary.dropped.push({ entry, reason: "rejected", result });
      continue;
    }
    if (result.status === 0) summary.offline = true;
    kept.push(deferred(entry, now, result));
  }

  // Re-read rather than overwrite: a share enqueued while this round was in
  // flight is in storage but not in `entries`, and must survive the commit.
  await updateStorage(async () => {
    const current = await readOutbox();
    const present = new Set(current.map((entry) => entry.id));
    const arrived = current.filter((entry) => !processed.has(entry.id));
    const remaining = [...kept.filter((entry) => present.has(entry.id)), ...arrived];
    await writeOutbox(remaining);
    summary.pending = remaining.length;
  });
  return summary;
}

/**
 * Points the retry alarm at the earliest due entry, or clears it when nothing
 * is pending. Chrome refuses alarms sooner than a minute out, so an entry
 * already due still waits that long.
 */
export async function scheduleFlush(now = Date.now(), destination = null) {
  const entries = (await readOutbox()).filter((entry) => entry.destination == null || entry.destination === destination);
  if (entries.length === 0) {
    await chrome.alarms.clear(OUTBOX_ALARM);
    return null;
  }
  const earliest = Math.min(...entries.map((entry) => entry.nextAttemptAt));
  const when = Math.max(earliest, now + 60_000);
  await chrome.alarms.create(OUTBOX_ALARM, { when });
  return when;
}
