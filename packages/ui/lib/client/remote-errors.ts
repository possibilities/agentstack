import { ClientCallError } from "./channel";

export function remoteError(error: unknown): string {
  if (!(error instanceof ClientCallError)) return error instanceof Error ? error.message : "Action not confirmed. Inspect the retained request before any deliberate retry.";
  const messages: Record<string, string> = {
    approval_pending: "Approval is still pending. Approve in trusted-local Access on the target server, then deliberately choose Approved? Connect. Nothing polls approval here.",
    pairing_denied: "Access denied this pairing. Forget the local intent before a new deliberate connection decision.",
    pairing_expired_or_invalid: "The approval code expired or is no longer valid. Forget this local intent, then begin a new deliberate pairing.",
    server_destination_mismatch: "The advertised device origin does not match your exact origin. Destination refused; no pairing was sent.",
    server_connection_changed: "The server identity or advertised destinations changed. This saved destination was not replaced. Inspect and confirm a new connection separately; no relocation API exists.",
    server_identity_mismatch: "The server installation identity changed. A new inspected and confirmed connection decision is required.",
    ui_destination_mismatch: "The returned UI origin or installation identity did not match the selected platform. Navigation was refused.",
    credential_revoked: "Access refused this credential: the credential, client or grant may have been revoked. The local saved connection is not proof of a live grant. Ask trusted-local Access to inspect it; nothing re-pairs automatically.",
    credential_expired: "The native credential expired. A new deliberate enrollment is required; a saved connection does not prove current Access permission.",
    insufficient_scope: "The current Access grant does not permit this UI action. Permission is controlled in trusted-local Access, not by this Client.",
    grant_changed: "The Access grant changed. This handoff cannot establish the old permissions. Inspect Access before a new deliberate Open.",
    refresh_reused_repair_required: "Access's five-minute refresh retry window has ended. There is no pending-open reset API. Deliberately re-enroll, then forget the stranded local connection.",
    refresh_superseded: "The retained refresh generation is no longer current. There is no pending-open reset API. Deliberately re-enroll, then forget this local connection.",
    refresh_recovery_required: "An Open is already unresolved. Inspect the listed pendingOpen and resume with its exact UUID; do not create another refresh request.",
    ui_handoff_expired: "This navigation handoff expired. If no pendingOpen remains, acknowledge this inspected result and choose a new deliberate Open. Re-pairing is not needed for a consumed or expired handoff.",
    ui_not_configured: "This platform advertises no UI origin. A saved Access connection cannot open a platform UI that is not configured.",
    enrollment_expired_or_clock_skew: "The request or receipt expired, or the clocks disagree. Nothing renews automatically. Forget the expired local intent, then explicitly make a new request.",
    enrollment_authority_changed: "The sponsoring phone's Access authority changed before redemption. A fresh, explicitly approved enrollment may be needed.",
    enrollment_invalid: "Access refused this enrollment: it may have expired, been cancelled, or no longer match its approval. Inspect it in trusted-local Access.",
    enrollment_receipt_mismatch: "The receipt does not match this desktop's saved request. It was not accepted.",
    request_conflict: "The request ID is already bound to different input. The saved input stays frozen; inspect it rather than changing or replaying it.",
    revision_conflict: "The record changed since you reviewed it. The latest records were reread; review the current revision and confirm again. Nothing was silently retried.",
    client_session_required: error.message,
  };
  return messages[error.code] ?? "Action not confirmed. The exact request is retained. Inspect current connections before any deliberate identical retry; an unknown answer is not permission to dispatch automatically.";
}
