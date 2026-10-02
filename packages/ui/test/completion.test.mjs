import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import test from "node:test";

// Load the pure stack modules directly without a Next build. Their
// bundler-style imports need extensions when loaded by Node.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.includes("/lib/stack/") && specifier.startsWith("./") && !extname(specifier)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { completionDelivery, completionDiagnostic, completionLinkStatusLabels, completionReceiptLabels, completionTargets,
  completionUncertainty, completionWatch, completionWatchLabels, occurrenceDeliveryLabel, occurrencePolicyLabel } = await import("../lib/stack/completion.ts");
const { continueCompletions, continueOccurrences, loadCompletions, loadOccurrences } = await import("../lib/stack/state.ts");

const receipt = (extra = {}) => ({ id: "00000000-0000-4000-8000-0000000000c1", botId: "alpha", threadId: "thread-1", pkg: "notify", operation: "notification_send",
  recordId: "00000000-0000-4000-8000-0000000000d1", state: "pending", lastDeliveredAt: null, lastDeliveryKind: null, lastError: null,
  nativeAdmissionUncertain: false, subscriptionPresent: true, ...extra });

test("completionDelivery words each receipt by what the native boundary actually acknowledged", () => {
  assert.deepEqual(completionDelivery(receipt()), [{ text: "No admission acknowledged", at: null }], "pending, no ack");
  assert.deepEqual(completionDelivery(receipt({ lastDeliveredAt: 100 })), [{ text: "Admission acknowledged", at: 100 }], "ack with no attempt kind");
  assert.deepEqual(completionDelivery(receipt({ lastDeliveredAt: 100, lastDeliveryKind: "update" })), [{ text: "Update admission acknowledged", at: 100 }], "pending + update ack");
  assert.deepEqual(completionDelivery(receipt({ state: "delivered", lastDeliveredAt: 200, lastDeliveryKind: "terminal" })), [{ text: "Terminal admission acknowledged", at: 200 }], "delivered terminal ack");
  assert.deepEqual(completionDelivery(receipt({ state: "observed", lastDeliveredAt: 300, lastDeliveryKind: "terminal" })),
    [{ text: "Admission acknowledged", at: 300 }, { text: "Last native attempt: terminal", at: null }], "observed: the ack is earlier than the terminal attempt");
  assert.deepEqual(completionDelivery(receipt({ state: "error", lastDeliveryKind: "terminal" })), [{ text: "Terminal admission attempted; none acknowledged", at: null }], "attempted but unacknowledged");
  assert.deepEqual(completionDelivery(receipt({ state: "error", lastDeliveredAt: 400, lastDeliveryKind: "terminal" })),
    [{ text: "Admission acknowledged", at: 400 }, { text: "Last native attempt: terminal", at: null }], "error with an earlier ack");
  assert.deepEqual(completionDelivery(receipt({ state: "unknown", lastDeliveryKind: "update", lastDeliveredAt: 500, nativeAdmissionUncertain: true })),
    [{ text: "Update admission outcome uncertain", at: null }, { text: "Earlier admission acknowledged", at: 500 }], "unknown: uncertain update, earlier ack kept");
  assert.deepEqual(completionDelivery(receipt({ state: "unknown", nativeAdmissionUncertain: true })), [{ text: "Native admission outcome uncertain", at: null }], "unknown with no attempt kind");
  assert.deepEqual(completionDelivery(receipt({ state: "cancelled", nativeAdmissionUncertain: true, lastDeliveryKind: "terminal" })),
    [{ text: "Terminal admission outcome uncertain", at: null }], "cancelled while uncertain");
  assert.deepEqual(completionDelivery(receipt({ state: "cancelled" })), [{ text: "No admission acknowledged", at: null }], "plain cancelled");
});

test("completionWatch, completionUncertainty and completionDiagnostic carry only what the receipt proves", () => {
  assert.deepEqual(completionWatch(receipt()), completionWatchLabels.present);
  assert.deepEqual(completionWatch(receipt({ subscriptionPresent: false })), completionWatchLabels.retired);
  assert.equal(completionUncertainty(receipt()), null, "settled receipts have no uncertainty wording");
  assert.match(completionUncertainty(receipt({ state: "unknown", nativeAdmissionUncertain: true })), /never resends, rearms or approves/);
  assert.match(completionUncertainty(receipt({ state: "unknown" })), /Native admission is uncertain/, "state unknown implies uncertainty even without the flag");
  assert.match(completionUncertainty(receipt({ state: "cancelled", nativeAdmissionUncertain: true })), /Cancelled after an uncertain native admission/);
  assert.equal(completionUncertainty(receipt({ state: "cancelled" })), null);
  assert.match(completionUncertainty(receipt({ state: "delivered", lastDeliveredAt: 1, nativeAdmissionUncertain: true })), /Native admission is uncertain/, "any other uncertain receipt is defensive");
  assert.match(completionDiagnostic(receipt({ lastError: "diagnostic_withheld" })), /withheld from history/);
  assert.equal(completionDiagnostic(receipt({ lastError: "native_admission_unknown" })), null, "covered by the uncertainty wording");
  assert.equal(completionDiagnostic(receipt()), null);
});

test("completion link statuses and targets resolve to exact domain destinations", () => {
  assert.deepEqual(Object.keys(completionLinkStatusLabels).sort(), ["missing", "not_found", "resolved", "unavailable", "unsupported"]);

  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  assert.deepEqual(completionTargets({ kind: "notify", notificationId: id(1) }), [{ kind: "node", label: `Notification ${id(1).slice(0, 8)}`, ref: { kind: "notification", id: id(1) } }]);
  assert.deepEqual(completionTargets({ kind: "browse", requestId: id(2), handoffId: id(3) }), [{ kind: "node", label: `Browser handoff ${id(3).slice(0, 8)}`, ref: { kind: "browser-handoff", id: id(3) } }]);
  assert.deepEqual(completionTargets({ kind: "worker", requestId: id(4), workerId: id(5), turnId: id(6) }),
    [{ kind: "worker-turn", label: `Worker ${id(5).slice(0, 8)} · turn ${id(6).slice(0, 8)}`, workerId: id(5), turnId: id(6) }],
    "a Worker target names the exact turn the link resolved, never the latest");
  assert.deepEqual(completionTargets({ kind: "proc", runId: id(7) }), [{ kind: "node", label: `Proc run ${id(7).slice(0, 8)}`, ref: { kind: "proc-run", id: id(7) } }]);
  assert.deepEqual(completionTargets({ kind: "brain-submit", requestId: id(8), jobId: 41, documentId: 7 }),
    [{ kind: "node", label: "Brain job #41", ref: { kind: "ingestion-job", id: "41" } }, { kind: "node", label: "Document #7", ref: { kind: "research-document", id: "7" } }]);
  assert.deepEqual(completionTargets({ kind: "brain-submit", requestId: id(8), jobId: null, documentId: 7 }), [{ kind: "node", label: "Document #7", ref: { kind: "research-document", id: "7" } }]);
  assert.deepEqual(completionTargets({ kind: "brain-sources", requestId: id(9), runIds: [3, 5] }), [{ kind: "text", label: "Source Runs #3, #5" }]);
  assert.deepEqual(completionTargets({ kind: "brain-sources", requestId: id(9), runIds: [] }), [{ kind: "text", label: "No source Runs" }]);
});

test("occurrence delivery and policy wording", () => {
  const delivery = (extra) => ({ id: "00000000-0000-4000-8000-0000000000e1", eventId: "ev", error: null, ...extra });
  assert.deepEqual(occurrenceDeliveryLabel(delivery({ state: "pending", boundary: null })), { label: "Pending", description: "Source observation retained; runtime handoff not confirmed." });
  assert.deepEqual(occurrenceDeliveryLabel(delivery({ state: "admitted", boundary: "native_admission" })), { label: "Admitted · native", description: "Codex acknowledged start-or-steer input. Not consumption." });
  assert.deepEqual(occurrenceDeliveryLabel(delivery({ state: "admitted", boundary: "worker_inbox" })), { label: "Admitted · Worker inbox", description: "The Worker owner durably stored the input. Not native acknowledgement." });
  assert.deepEqual(occurrenceDeliveryLabel(delivery({ state: "admitted", boundary: null })), { label: "Admitted", description: "Admission boundary not recorded." });
  assert.deepEqual(occurrenceDeliveryLabel(delivery({ state: "unknown", boundary: null })), { label: "Unknown", description: "Input may have crossed a boundary. No automatic replay or later delivery." });

  const row = (target, policy) => ({ id: "00000000-0000-4000-8000-0000000000e2", target, pkg: "xcom", name: "posts", policy,
    cursor: null, truncated: false, revision: "r1", receiptCount: 0, receiptsTruncated: false });
  const bot = { kind: "bot", botId: "alpha", threadId: "t", instance: "i" };
  const worker = { kind: "worker", workerId: "w", sessionId: "s", instance: "i" };
  assert.equal(occurrencePolicyLabel(row(bot, "native")), "native · start-or-steer");
  assert.equal(occurrencePolicyLabel(row(worker, "native")), "native · follow-up when idle");
  assert.equal(occurrencePolicyLabel(row(worker, "interrupt")), "interrupt · cancels before follow-up");
});

test("no visible label calls an acknowledged admission read, consumed, processed or completed", () => {
  const texts = [
    ...Object.values(completionReceiptLabels).map(({ label }) => label),
    ...Object.values(completionWatchLabels).map(({ label }) => label),
    ...Object.values(completionLinkStatusLabels).map(({ label }) => label),
    ...completionDelivery(receipt({ state: "delivered", lastDeliveredAt: 1, lastDeliveryKind: "terminal" })).map((part) => part.text),
    ...completionDelivery(receipt({ state: "unknown", nativeAdmissionUncertain: true })).map((part) => part.text),
    ...completionDelivery(receipt()).map((part) => part.text),
    ...["pending", "admitted", "unknown"].map((state) => occurrenceDeliveryLabel({ state, boundary: null }).label),
  ];
  for (const text of texts) assert.doesNotMatch(text, /\b(read|consumed|processed|completed)\b/i, text);
});

test("completion paging passes exact filters, appends pages and restarts on a changed observation", async () => {
  let revision = "c1";
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    if (args.revision && args.revision !== revision) throw new Error("completion observation changed; restart paging");
    return { completions: [{ id: `receipt-${args.offset}` }], revision, total: 3, nextOffset: args.offset === 0 ? 1 : null, truncated: true };
  };
  const first = await loadCompletions(call, { botId: "alpha", package: "", state: "unknown" });
  assert.deepEqual(calls[0], ["serve_completion_list", { botId: "alpha", state: "unknown", offset: 0, limit: 100 }], "empty filters are omitted rather than matched literally");
  const all = await continueCompletions(call, first);
  assert.deepEqual(calls[1][1], { botId: "alpha", state: "unknown", offset: 1, limit: 100, revision: "c1" });
  assert.deepEqual(all.completions.map((row) => row.id), ["receipt-0", "receipt-1"]);
  assert.equal(all.total, 3);
  assert.equal(all.truncated, true);
  assert.equal(all.restarted, false);
  assert.equal(await continueCompletions(call, all), all, "a complete history is not re-read");

  revision = "c2";
  const restarted = await continueCompletions(call, first);
  assert.equal(restarted.restarted, true);
  assert.deepEqual(restarted.completions.map((row) => row.id), ["receipt-0"]);
  assert.equal(calls.at(-1)[1].offset, 0, "a changed observation pages again from the first page");
});

test("occurrence paging passes exact filters and restarts on a changed inventory", async () => {
  let revision = "o1";
  const calls = [];
  const call = async (name, args) => {
    calls.push([name, args]);
    if (args.revision && args.revision !== revision) throw new Error("occurrence inventory changed; restart paging");
    return { subscriptions: [{ id: `occ-${args.offset}` }], revision, nextOffset: args.offset === 0 ? 1 : null };
  };
  const first = await loadOccurrences(call, { botId: "alpha", package: "xcom" });
  assert.deepEqual(calls[0], ["serve_occurrence_list", { botId: "alpha", package: "xcom", offset: 0, limit: 100 }]);
  const all = await continueOccurrences(call, first);
  assert.deepEqual(all.subscriptions.map((row) => row.id), ["occ-0", "occ-1"]);
  assert.equal(all.restarted, false);

  revision = "o2";
  const restarted = await continueOccurrences(call, first);
  assert.equal(restarted.restarted, true);
  assert.deepEqual(restarted.subscriptions.map((row) => row.id), ["occ-0"]);
  assert.equal(calls.at(-1)[1].offset, 0);
});
