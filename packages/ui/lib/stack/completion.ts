import { jobStateView } from "./brain";
import { shortId } from "./derive";
import { span } from "./workers";
import type { BrainSourcesObservation, BrainSubmissionObservation, BrowserHandoff, CompletionReceipt, NodeRef, OccurrenceSubscription, ProcRunObservation, ServeCompletionLink, ServeCompletionLinkStatus, ServeCompletionReceipt, ServeOccurrenceRow, WorkerEventReceipt, WorkerTurn } from "./types";

/** Shared reference and System vocabulary. Native acknowledgement never means consumption. */
export const completionReceiptLabels: Record<CompletionReceipt["state"], { label: string; description: string }> = {
  pending: { label: "Pending", description: "Watch retained; no terminal native acknowledgement. An attention update may already have been admitted." },
  error: { label: "Error", description: "Read, authorization or a definitely refused native attempt needs inspection; domain work may still exist." },
  observed: { label: "Observed", description: "The initial read was terminal. Inspect it now; no future wakeup was sent." },
  delivered: { label: "Delivered", description: "Codex acknowledged terminal input admission. Not consumption, turn completion, approval or Work completion." },
  unknown: { label: "Unknown", description: "Native admission is uncertain. Delivery is frozen; never automatically resend or rearm." },
  cancelled: { label: "Cancelled", description: "Watch removed or fenced. Does not cancel the domain operation or recall admitted input." },
};

export type DeliveryPart = { text: string; at: number | null };

/**
 * What the receipt says about native admission. `lastDeliveryKind` is written at attempt start, before the native
 * send; `lastDeliveredAt` is only the last acknowledgement. Acknowledged admission is never consumption.
 */
export function completionDelivery(r: ServeCompletionReceipt): DeliveryPart[] {
  const kind = r.lastDeliveryKind;
  const Kind = kind === "update" ? "Update" : kind === "terminal" ? "Terminal" : "Native";
  if (r.nativeAdmissionUncertain) {
    const parts: DeliveryPart[] = [{ text: `${Kind} admission outcome uncertain`, at: null }];
    if (r.lastDeliveredAt !== null) parts.push({ text: "Earlier admission acknowledged", at: r.lastDeliveredAt });
    return parts;
  }
  if (r.lastDeliveredAt !== null) {
    if (r.state === "delivered") return [{ text: "Terminal admission acknowledged", at: r.lastDeliveredAt }];
    if (r.state === "pending" && kind === "update") return [{ text: "Update admission acknowledged", at: r.lastDeliveredAt }];
    const parts: DeliveryPart[] = [{ text: "Admission acknowledged", at: r.lastDeliveredAt }];
    if (kind !== null) parts.push({ text: `Last native attempt: ${kind}`, at: null });
    return parts;
  }
  if (kind !== null) return [{ text: `${Kind} admission attempted; none acknowledged`, at: null }];
  return [{ text: "No admission acknowledged", at: null }];
}

export const completionWatchLabels = {
  present: { label: "Watch active", description: "The watch that created this receipt still exists." },
  retired: { label: "Watch retired", description: "The watch no longer exists; this retained receipt is history only." },
} as const;

/** "Retired" is the watch's absence, not a receipt state. */
export function completionWatch(r: ServeCompletionReceipt): (typeof completionWatchLabels)["present" | "retired"] {
  return completionWatchLabels[r.subscriptionPresent ? "present" : "retired"];
}

/** Null unless admission is uncertain; never offers a retry. */
export function completionUncertainty(r: ServeCompletionReceipt): string | null {
  const uncertain = "Native admission is uncertain. Delivery is frozen; inspect owner state. Stack never resends, rearms or approves it automatically.";
  if (r.state === "unknown") return uncertain;
  if (r.nativeAdmissionUncertain && r.state === "cancelled")
    return "Cancelled after an uncertain native admission. Input that may have been admitted cannot be recalled; inspect owner state.";
  if (r.nativeAdmissionUncertain) return uncertain;
  return null;
}

export function completionDiagnostic(r: ServeCompletionReceipt): string | null {
  if (r.lastError === "diagnostic_withheld")
    return "A diagnostic was recorded; its text is withheld from history. Inspect the owner state (or the active watch while it exists).";
  return null;
}

export const completionLinkStatusLabels: Record<ServeCompletionLinkStatus, { label: string; description: string }> = {
  resolved: { label: "Linked", description: "Resolved to the exact domain record for this admission." },
  missing: { label: "No domain record bound", description: "The owner answered, but no record is bound to this exact request." },
  unavailable: { label: "Owner unavailable", description: "The owner could not be asked or gave no usable answer. This is not proof that no record exists." },
  unsupported: { label: "Linking not supported", description: "This package and operation have no domain link." },
  not_found: { label: "Receipt not found", description: "This receipt is no longer retained." },
};

export type CompletionTarget =
  | { kind: "node"; label: string; ref: NodeRef }
  | { kind: "worker-turn"; label: string; workerId: string; turnId: string }
  | { kind: "text"; label: string };

/** Exact domain destinations for a resolved link. A Worker target names its exact turn, never the latest. */
export function completionTargets(link: ServeCompletionLink): CompletionTarget[] {
  switch (link.kind) {
    case "notify":
      return [{ kind: "node", label: `Notification ${shortId(link.notificationId)}`, ref: { kind: "notification", id: link.notificationId } }];
    case "browse":
      return [{ kind: "node", label: `Browser handoff ${shortId(link.handoffId)}`, ref: { kind: "browser-handoff", id: link.handoffId } }];
    case "worker":
      return [{ kind: "worker-turn", label: `Worker ${shortId(link.workerId)} · turn ${shortId(link.turnId)}`, workerId: link.workerId, turnId: link.turnId }];
    case "proc":
      return [{ kind: "node", label: `Proc run ${shortId(link.runId)}`, ref: { kind: "proc-run", id: link.runId } }];
    case "brain-submit": {
      const targets: CompletionTarget[] = [];
      if (link.jobId !== null) targets.push({ kind: "node", label: `Brain job #${link.jobId}`, ref: { kind: "ingestion-job", id: String(link.jobId) } });
      if (link.documentId !== null) targets.push({ kind: "node", label: `Document #${link.documentId}`, ref: { kind: "research-document", id: String(link.documentId) } });
      return targets;
    }
    case "brain-sources":
      return [{ kind: "text", label: link.runIds.length ? `Source Runs ${link.runIds.map((n) => `#${n}`).join(", ")}` : "No source Runs" }];
  }
}

export function occurrenceDeliveryLabel(d: OccurrenceSubscription["deliveries"][number]): { label: string; description: string } {
  if (d.state === "pending") return { label: "Pending", description: "Source observation retained; runtime handoff not confirmed." };
  if (d.state === "admitted") {
    if (d.boundary === "native_admission") return { label: "Admitted · native", description: "Codex acknowledged start-or-steer input. Not consumption." };
    if (d.boundary === "worker_inbox") return { label: "Admitted · Worker inbox", description: "The Worker owner durably stored the input. Not native acknowledgement." };
    return { label: "Admitted", description: "Admission boundary not recorded." };
  }
  return { label: "Unknown", description: "Input may have crossed a boundary. No automatic replay or later delivery." };
}

export function occurrencePolicyLabel(row: ServeOccurrenceRow): string {
  if (row.policy === "interrupt") return "interrupt · cancels before follow-up";
  return row.target.kind === "bot" ? "native · start-or-steer" : "native · follow-up when idle";
}

type ObservationTone = "success" | "warning" | "destructive" | "muted" | "info";

/** `serve_completion_list` arguments for one exact domain record, omitting empty values. */
export function receiptQuery(pkg: string, recordId: string, origin?: { botId?: string; threadId?: string }): Record<string, unknown> {
  return { ...(pkg ? { package: pkg } : {}), ...(recordId ? { recordId } : {}), limit: 100,
    ...(origin?.botId ? { botId: origin.botId } : {}), ...(origin?.threadId ? { threadId: origin.threadId } : {}) };
}

const noBotWatchNote = "Bot MCP watches are separate: operator UI admissions never create one, and this view cannot subscribe.";

/** Why an exact record shows no retained receipt; the operator view never offers one. */
export const noBotWatch: Record<"browse" | "worker" | "proc" | "brain", string> = {
  browse: `A Bot's MCP request watches its exact request by default; this one has no retained receipt. ${noBotWatchNote}`,
  worker: `A Bot's MCP request watches its exact request by default; this one has no retained receipt. ${noBotWatchNote}`,
  proc: `A Bot opts in with subscribe:true; this admission has no retained receipt. ${noBotWatchNote}`,
  brain: `A Bot opts in with subscribe:true; this admission has no retained receipt. ${noBotWatchNote}`,
};

/** One `worker_turn_observation` phase as the owner reports it. Unknown is never a proven failure. */
export const workerObservationPhaseLabels: Record<WorkerTurn["phase"], { label: string; description: string }> = {
  queued: { label: "Queued", description: "Admitted; waiting for dispatch." },
  running: { label: "Running", description: "The turn is in progress." },
  awaiting_input: { label: "Awaiting input", description: "Waiting on a permission or question; only the originating Bot answers it." },
  cancelling: { label: "Cancelling", description: "Cancellation was requested; waiting for the turn's outcome." },
  completed: { label: "Completed", description: "The turn ended." },
  cancelled: { label: "Cancelled", description: "The turn was cancelled." },
  failed: { label: "Failed", description: "The turn failed." },
  unknown: { label: "Unknown", description: "Outcome uncertain — not proven failure. Inspect the transcript and records." },
};

/** `worker_event_list` receipt states. A dispatched turn records an admission, never its outcome. */
export const workerEventReceiptLabels: Record<WorkerEventReceipt["state"], { label: string; description: string }> = {
  queued: { label: "Queued", description: "Durable inbox, no native turn dispatch yet" },
  interrupting: { label: "Interrupting", description: "Explicit cancellation attempt, waiting for the active turn's outcome" },
  dispatched: { label: "Dispatched", description: "Recorded follow-up turn — inspect its outcome; not processing success" },
  unknown: { label: "Unknown", description: "Native event turn or interruption uncertain; automatic event input is fenced" },
  cancelled: { label: "Cancelled", description: "Queued input was not dispatched before lifecycle end" },
};

/** Shown when any event receipt is unknown: no UI control retries or replays event input. */
export const workerEventFence = "Automatic event input to this Worker is fenced. Recovery is the existing Worker lifecycle actions only; there is no event replay.";

/** `proc_run_completion` terminal states; an unknown exit is not a proven failure. */
export const procExitLabels: Record<"exited" | "failed" | "cancelled" | "unknown", { label: string; description: string }> = {
  exited: { label: "Exited", description: "The process ended on its own." },
  failed: { label: "Failed", description: "The process or its guardian failed." },
  cancelled: { label: "Cancelled", description: "The run was stopped." },
  unknown: { label: "Unknown", description: "The guardian or service was interrupted. Not a proven failed process, and it does not establish that the workspace is free." },
};

/** The observation's compact exit facts: code/signal/error plus its recorded duration. Never argv or output. */
export function procExitParts(result: NonNullable<ProcRunObservation["result"]>): string[] {
  const parts: string[] = [];
  if (result.exitCode !== null) parts.push(`code ${result.exitCode}`);
  if (result.signal !== null) parts.push(`signal ${result.signal}`);
  if (result.error) parts.push(result.error);
  const duration = result.finishedAt ? Date.parse(result.finishedAt) - Date.parse(result.startedAt) : null;
  if (duration !== null && Number.isFinite(duration)) parts.push(`ran ${span(duration)}`);
  return parts;
}

/** A resolved handoff's human report; an unresolved or absent result has no report. */
export function browseReportText(outcome: BrowserHandoff["outcome"] | null): string {
  const word = outcome === "completed" ? "Completed" : outcome === "skipped" ? "Skipped" : outcome === "cancelled" ? "Cancelled" : null;
  if (word === null) return "No human report yet.";
  return `The human reported ${word}. A report, not verified browser state; the Bot verifies with a fresh snapshot.`;
}

/** One submit admission's settlement; an unsettled result is never read as indexed. */
export function brainSubmissionView(result: BrainSubmissionObservation["result"]): { label: string; tone: ObservationTone; detail: string } {
  const scope = "Exact job only; transitive fanout isn't included. A retry does not rearm this watch.";
  if (!result) return { label: "Not settled — queued, running or waiting to retry (or not admitted yet)", tone: "muted", detail: scope };
  if (result.kind === "already_indexed")
    return { label: `Already indexed · document #${result.document_id} — an observed document identity, not a queued job`, tone: "success", detail: scope };
  const state = jobStateView[result.state];
  return {
    label: `Job #${result.job_id} · ${state.label}${result.failure_class ? ` · ${result.failure_class}` : ""}`,
    tone: result.requires_attention ? "warning" : state.tone,
    detail: `${result.requires_attention ? "Needs attention — not successful indexing. " : ""}${scope}`,
  };
}

/** One source-sync admission's settled Run set; null means at least one Run is still active. */
export function brainSourcesView(result: BrainSourcesObservation["result"]): { label: string; tone: ObservationTone; lines: string[] } {
  if (!result) return { label: "Not settled — at least one admitted Run is still active. Never read as success.", tone: "muted", lines: [] };
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const lines = [
    `${plural(result.admission_count, "admission")} · ${plural(result.run_count, "Run")}${result.no_run_count ? ` · ${plural(result.no_run_count, "admission")} without a Run` : ""}`,
    ...Object.entries(result.admission_outcomes).map(([status, count]) => `${plural(count, "admission")} ${status}`),
    ...Object.entries(result.outcomes).map(([outcome, count]) => `${plural(count, "Run")} ${outcome}`),
    "Discovery and admission settled — not child extraction or indexing.",
  ];
  return { label: "Discovery and admission settled", tone: "info", lines };
}
