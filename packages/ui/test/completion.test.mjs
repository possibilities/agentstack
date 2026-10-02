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

const { brainSourcesView, brainSubmissionView, browseReportText, completionDelivery, completionDiagnostic, completionLinkStatusLabels, completionReceiptLabels, completionTargets,
  completionUncertainty, completionWatch, completionWatchLabels, noBotWatch, occurrenceDeliveryLabel, occurrencePolicyLabel, procExitLabels, procExitParts,
  receiptQuery, workerEventFence, workerEventReceiptLabels, workerObservationPhaseLabels } = await import("../lib/stack/completion.ts");
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

test("receiptQuery builds exact-record arguments and omits empty values", () => {
  assert.deepEqual(receiptQuery("worker", "00000000-0000-4000-8000-0000000000d1"), { package: "worker", recordId: "00000000-0000-4000-8000-0000000000d1", limit: 100 });
  assert.deepEqual(receiptQuery("browse", "abc", { botId: "bot-1", threadId: "thread-1" }), { package: "browse", recordId: "abc", limit: 100, botId: "bot-1", threadId: "thread-1" });
  assert.deepEqual(receiptQuery("browse", "", { botId: "", threadId: undefined }), { package: "browse", limit: 100 }, "empty record and origin fields are omitted, never sent");
  assert.deepEqual(receiptQuery("proc", "run-1", {}), { package: "proc", recordId: "run-1", limit: 100 });
});

test("domain labels cover every state and never promise a subscribe or retry control", () => {
  assert.deepEqual(Object.keys(noBotWatch).sort(), ["brain", "browse", "proc", "worker"]);
  for (const text of Object.values(noBotWatch)) {
    assert.match(text, /no retained receipt/);
    assert.match(text, /operator UI admissions never create one, and this view cannot subscribe\.$/);
    assert.doesNotMatch(text, /retry|rearm/i);
  }
  assert.match(noBotWatch.browse, /watches its exact request by default/);
  assert.match(noBotWatch.brain, /subscribe:true/);

  const phases = ["queued", "running", "awaiting_input", "cancelling", "completed", "cancelled", "failed", "unknown"];
  assert.deepEqual(Object.keys(workerObservationPhaseLabels).sort(), phases.sort());
  assert.match(workerObservationPhaseLabels.unknown.description, /Outcome uncertain — not proven failure\. Inspect the transcript and records\./);

  assert.deepEqual(Object.keys(workerEventReceiptLabels).sort(), ["cancelled", "dispatched", "interrupting", "queued", "unknown"]);
  assert.equal(workerEventReceiptLabels.queued.description, "Durable inbox, no native turn dispatch yet");
  assert.equal(workerEventReceiptLabels.dispatched.description, "Recorded follow-up turn — inspect its outcome; not processing success");
  assert.match(workerEventFence, /fenced\. Recovery is the existing Worker lifecycle actions only; there is no event replay\./);

  assert.deepEqual(Object.keys(procExitLabels).sort(), ["cancelled", "exited", "failed", "unknown"]);
  assert.match(procExitLabels.unknown.description, /guardian or service was interrupted\. Not a proven failed process/);
  const exited = { id: "run-1", state: "exited", exitCode: 3, signal: null, error: null, startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:01:05Z" };
  assert.deepEqual(procExitParts(exited), ["code 3", "ran 1m 5s"]);
  assert.deepEqual(procExitParts({ ...exited, exitCode: null, signal: "SIGTERM", error: "guardian_failed", finishedAt: null }), ["signal SIGTERM", "guardian_failed"]);
});

test("browseReportText reports the human's outcome without claiming verified browser state", () => {
  assert.equal(browseReportText(null), "No human report yet.");
  assert.equal(browseReportText("completed"), "The human reported Completed. A report, not verified browser state; the Bot verifies with a fresh snapshot.");
  assert.equal(browseReportText("skipped"), "The human reported Skipped. A report, not verified browser state; the Bot verifies with a fresh snapshot.");
  assert.equal(browseReportText("cancelled"), "The human reported Cancelled. A report, not verified browser state; the Bot verifies with a fresh snapshot.");
});

test("brainSubmissionView words each settlement and never reads an unsettled result as success", () => {
  const unsettled = brainSubmissionView(null);
  assert.match(unsettled.label, /Not settled/);
  assert.doesNotMatch(unsettled.label, /indexed|completed|success/i);
  assert.equal(unsettled.tone, "muted");
  const indexed = brainSubmissionView({ kind: "already_indexed", document_id: 7 });
  assert.equal(indexed.label, "Already indexed · document #7 — an observed document identity, not a queued job");
  const done = brainSubmissionView({ kind: "job", job_id: 41, state: "completed", failure_class: null, document_id: 7, requires_attention: false, scope: "exact_job" });
  assert.equal(done.label, "Job #41 · Completed");
  assert.doesNotMatch(done.detail, /Needs attention/);
  const blocked = brainSubmissionView({ kind: "job", job_id: 2, state: "blocked", failure_class: "egress_denied", document_id: null, requires_attention: true, scope: "exact_job" });
  assert.equal(blocked.label, "Job #2 · Blocked · egress_denied");
  assert.equal(blocked.tone, "warning");
  assert.match(blocked.detail, /Needs attention — not successful indexing\./);
  for (const view of [unsettled, indexed, done, blocked]) assert.match(view.detail, /A retry does not rearm this watch\./);
});

test("brainSourcesView counts the settled Run set; null means at least one Run is still active", () => {
  const unsettled = brainSourcesView(null);
  assert.match(unsettled.label, /Not settled — at least one admitted Run is still active\. Never read as success\./);
  assert.deepEqual(unsettled.lines, []);
  const settled = brainSourcesView({ scope: "discovery_and_admission", admission_count: 3, run_count: 2, no_run_count: 1,
    admission_outcomes: { queued: 2, not_due: 1 }, outcomes: { success: 1, partial: 1 },
    runs: [], truncated: false, nextOffset: null, read: { operation: "sources_sync_completion", requestId: "00000000-0000-4000-8000-0000000000d1", offset: null } });
  assert.equal(settled.label, "Discovery and admission settled");
  assert.ok(settled.lines.includes("3 admissions · 2 Runs · 1 admission without a Run"));
  assert.ok(settled.lines.includes("2 admissions queued"));
  assert.ok(settled.lines.includes("1 Run success"));
  assert.ok(settled.lines.includes("Discovery and admission settled — not child extraction or indexing."));
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
