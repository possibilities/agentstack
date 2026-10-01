import type { CompletionReceipt } from "./types";

/** Shared reference and System vocabulary. Native acknowledgement never means consumption. */
export const completionReceiptLabels: Record<CompletionReceipt["state"], { label: string; description: string }> = {
  pending: { label: "Pending", description: "Watch retained; no terminal native acknowledgement. An attention update may already have been admitted." },
  error: { label: "Error", description: "Read, authorization or a definitely refused native attempt needs inspection; domain work may still exist." },
  observed: { label: "Observed", description: "The initial read was terminal. Inspect it now; no future wakeup was sent." },
  delivered: { label: "Delivered", description: "Codex acknowledged terminal input admission. Not consumption, turn completion, approval or Work completion." },
  unknown: { label: "Unknown", description: "Native admission is uncertain. Delivery is frozen; never automatically resend or rearm." },
  cancelled: { label: "Cancelled", description: "Watch removed or fenced. Does not cancel the domain operation or recall admitted input." },
};
