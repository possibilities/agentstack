/**
 * The Chrome share client's outbox. Plain JavaScript because the extension is:
 * `tsconfig.json` includes only TypeScript, so this file is run by `node --test`
 * without being pulled into the typecheck program.
 *
 * `chrome.*` is stubbed to the two surfaces the outbox touches — `storage.local`
 * and `alarms` — so the delivery policy is exercised without a browser.
 */

import { beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

const storage = new Map();
const alarms = new Map();

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
  alarms: {
    async create(name, info) {
      alarms.set(name, info);
    },
    async clear(name) {
      alarms.delete(name);
    },
  },
};

const {
  backoffMs,
  clearOutbox,
  enqueue,
  flushOutbox,
  OUTBOX_ALARM,
  OUTBOX_MAX_AGE_MS,
  OUTBOX_MAX_ENTRIES,
  readOutbox,
  scheduleFlush,
} = await import("../outbox.js");

const NOW = 1_760_000_000_000;

const unreachable = {
  ok: false,
  status: 0,
  code: "unreachable",
  message: "Cannot reach the server.",
};
const rejected = {
  ok: false,
  status: 400,
  code: "bad_source",
  message: "not a usable http(s) locator",
};
const queued = { ok: true, status: 200, data: { status: "queued", job_id: 7 } };
const duplicate = {
  ok: true,
  status: 200,
  data: { status: "duplicate", job_id: 7 },
};

function sender(...results) {
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    return results[Math.min(calls.length - 1, results.length - 1)];
  };
  send.calls = calls;
  return send;
}

beforeEach(async () => {
  storage.clear();
  alarms.clear();
});

describe("enqueue", () => {
  test("holds a payload with its first retry a backoff step away", async () => {
    const { entry, pending } = await enqueue(
      { url: "https://example.com" },
      NOW,
    );
    assert.equal(pending, 1);
    assert.equal(entry.attempts, 0);
    assert.equal(entry.nextAttemptAt, NOW + backoffMs(1));
    assert.equal((await readOutbox())[0].payload.url, "https://example.com");
  });

  test("evicts the oldest share rather than growing without bound", async () => {
    for (let index = 0; index <= OUTBOX_MAX_ENTRIES; index += 1) {
      await enqueue({ url: `https://example.com/${index}` }, NOW + index);
    }
    const entries = await readOutbox();
    assert.equal((entries).length, OUTBOX_MAX_ENTRIES);
    assert.equal(entries[0].payload.url, "https://example.com/1");
    assert.equal(entries.at(-1).payload.url, `https://example.com/${OUTBOX_MAX_ENTRIES}`);
  });
});

describe("flushOutbox", () => {
  test("is inert when nothing is held", async () => {
    const send = sender(queued);
    const summary = await flushOutbox(send, { now: NOW });
    assert.equal((send.calls).length, 0);
    assert.partialDeepStrictEqual(summary, { attempted: 0, delivered: 0, pending: 0 });
  });

  test("removes an entry the ingress admits", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const summary = await flushOutbox(sender(queued), {
      now: NOW,
      force: true,
    });
    assert.partialDeepStrictEqual(summary, { attempted: 1, delivered: 1, pending: 0 });
    assert.equal((await readOutbox()).length, 0);
  });

  test("counts a duplicate as delivered, because the job already exists", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const summary = await flushOutbox(sender(duplicate), {
      now: NOW,
      force: true,
    });
    assert.partialDeepStrictEqual(summary, { duplicate: 1, delivered: 0, pending: 0 });
  });

  test("respects the backoff schedule unless forced", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const early = sender(queued);
    const skipped = await flushOutbox(early, { now: NOW + 1000 });
    assert.equal((early.calls).length, 0);
    assert.equal(skipped.pending, 1);

    const late = sender(queued);
    await flushOutbox(late, { now: NOW + backoffMs(1) + 1 });
    assert.equal((late.calls).length, 1);
  });

  test("reschedules a retryable failure with a longer backoff each time", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    await flushOutbox(sender(unreachable), { now: NOW, force: true });
    let held = (await readOutbox())[0];
    assert.equal(held.attempts, 1);
    assert.equal(held.nextAttemptAt, NOW + backoffMs(1));
    assert.equal(held.lastCode, "unreachable");

    await flushOutbox(sender(unreachable), { now: NOW + 1, force: true });
    held = (await readOutbox())[0];
    assert.equal(held.attempts, 2);
    assert.equal(held.nextAttemptAt, NOW + 1 + backoffMs(2));
  });

  test("drops a payload the ingress will never accept", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const summary = await flushOutbox(sender(rejected), {
      now: NOW,
      force: true,
    });
    assert.equal((summary.dropped).length, 1);
    assert.partialDeepStrictEqual(summary.dropped[0], { reason: "rejected" });
    assert.equal((await readOutbox()).length, 0);
  });

  test("stops the round at the first unreachable server", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    await enqueue({ url: "https://example.com/b" }, NOW);
    await enqueue({ url: "https://example.com/c" }, NOW);
    const send = sender(unreachable);
    const summary = await flushOutbox(send, { now: NOW, force: true });

    assert.equal((send.calls).length, 1);
    assert.partialDeepStrictEqual(summary, { attempted: 1, offline: true, pending: 3 });
    // Every held share backs off, so the next round is one wake, not three.
    for (const entry of await readOutbox()) assert.equal(entry.attempts, 1);
  });

  test("abandons a share no server ever accepted", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const send = sender(queued);
    const summary = await flushOutbox(send, {
      now: NOW + OUTBOX_MAX_AGE_MS + 1,
      force: true,
    });
    assert.equal((send.calls).length, 0);
    assert.partialDeepStrictEqual(summary.dropped[0], { reason: "expired" });
    assert.equal((await readOutbox()).length, 0);
  });

  test("keeps a share enqueued while the round was in flight", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const send = async () => {
      await enqueue({ url: "https://example.com/late" }, NOW);
      return queued;
    };
    const summary = await flushOutbox(send, { now: NOW, force: true });
    assert.equal(summary.delivered, 1);
    const remaining = await readOutbox();
    assert.equal((remaining).length, 1);
    assert.equal(remaining[0].payload.url, "https://example.com/late");
  });
});

describe("scheduleFlush", () => {
  test("aims the alarm at the earliest due entry, never sooner than a minute", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    const when = await scheduleFlush(NOW);
    assert.equal(when, NOW + backoffMs(1));
    assert.deepEqual(alarms.get(OUTBOX_ALARM), { when });

    // An entry already overdue still cannot wake Chrome sooner than 60s.
    const later = NOW + 10 * backoffMs(1);
    assert.equal(await scheduleFlush(later), later + 60_000);
  });

  test("clears the alarm once nothing is held", async () => {
    await enqueue({ url: "https://example.com/a" }, NOW);
    await scheduleFlush(NOW);
    assert.equal(await clearOutbox(), 1);
    assert.equal(await scheduleFlush(NOW), null);
    assert.equal(alarms.has(OUTBOX_ALARM), false);
  });
});

test("held payloads cannot move to another configured server", async () => {
  await enqueue({ url: "https://example.com/private" }, NOW, "https://first.example");
  const wrong = sender(queued);
  const summary = await flushOutbox(wrong, { now: NOW, force: true, destination: "https://second.example" });
  assert.equal(wrong.calls.length, 0);
  assert.equal(summary.otherDestination, 1);
  assert.equal(summary.pending, 1);
  const original = sender(queued);
  await flushOutbox(original, { now: NOW, force: true, destination: "https://first.example" });
  assert.equal(original.calls.length, 1);
  assert.equal((await readOutbox()).length, 0);
});

test("an unconfigured share binds before its first ambiguous attempt", async () => {
  await enqueue({ text: "Keep this note" }, NOW);
  await flushOutbox(async () => {
    assert.equal((await readOutbox())[0].destination, "https://first.example");
    return unreachable;
  }, { now: NOW, force: true, destination: "https://first.example" });
  const next = sender(queued);
  await flushOutbox(next, { now: NOW, force: true, destination: "https://second.example" });
  assert.equal(next.calls.length, 0);
});

test("concurrent holds survive and a discarded in-flight entry stays discarded", async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => enqueue({ text: `Note ${i}` }, NOW)));
  assert.equal((await readOutbox()).length, 20);
  await clearOutbox();
  await enqueue({ text: "Discard while sending" }, NOW);
  await flushOutbox(async () => {
    await clearOutbox();
    await enqueue({ text: "Keep later arrival" }, NOW);
    return unreachable;
  }, { now: NOW, force: true });
  assert.deepEqual((await readOutbox()).map((e) => e.payload.text), ["Keep later arrival"]);
});

test("a mixed round preserves accepted, rejected, and held outcomes", async () => {
  for (const text of ["admitted", "rejected", "held"]) await enqueue({ text }, NOW);
  const summary = await flushOutbox(sender(queued, rejected, unreachable), { now: NOW, force: true });
  assert.partialDeepStrictEqual(summary, { attempted: 3, delivered: 1, pending: 1 });
  assert.equal(summary.dropped.length, 1);
  assert.equal(summary.settled.length, 1);
  assert.equal((await readOutbox())[0].payload.text, "held");
});
