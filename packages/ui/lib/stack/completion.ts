import { shortId } from "./derive";
import type { CompletionReceipt, NodeRef, OccurrenceSubscription, ServeCompletionLink, ServeCompletionLinkStatus, ServeCompletionReceipt, ServeOccurrenceRow } from "./types";

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
