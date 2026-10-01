import { stateCategories } from "@stack/api";
export const serverStateCategories = stateCategories("serve", [
  { id: "subscriptions", kind: "queue", paths: ["event-subscriptions.sqlite"], reads: ["serve_subscription_list", "serve_subscription_get"], actions: ["serve_subscription_remove"],
    retention: "Durable subscriptions survive restart and rebind only to the sanctioned Bot lineage. One-shot completion receipts retain observed, admitted, cancelled and unknown outcomes for ID retries. Cancellation cannot recall admitted input.", regeneration: "Explicit Bot subscription admission or an operation-declared completion watch. Unknown native admissions are never automatically replayed." },
  { id: "local-authority", kind: "credentials", paths: ["local-auth", "mcp-bot-identity.key"], sensitivity: "credential", reads: ["serve_status"], actions: ["serve_local_revoke"],
    retention: "Local sessions and signing material are server-owned. Revoking local authority leaves remote Access and signed Bot/Worker authority independent.", regeneration: "Server restart rotates local authority; native clients reload their operator credential." },
  { id: "observations", kind: "cache", paths: [], authority: "derived", sensitivity: "ordinary", reads: ["serve_resources", "serve_resource_history", "serve_codex_tools"],
    retention: "Process observations and diagnostics are bounded in-memory state, lost on restart.", regeneration: "Sampler cycles and explicit Codex checks." },
  { id: "settings", kind: "configuration", paths: ["serve/settings.json"], sensitivity: "ordinary", reads: ["serve_settings_read"], actions: ["serve_settings_update"],
    retention: "Revisioned global Server settings survive restart. Developer mode defaults off; disabling retains the release cache and aborts/fences checks. No settings reset operation is provided.", regeneration: "Explicit local-operator update at the observed revision." },
  { id: "harness-releases", kind: "cache", paths: ["serve/harness-releases.json"], authority: "derived", sensitivity: "ordinary", reads: ["serve_harness_releases"],
    retention: "Four fixed upstream channels retain the last good and previous different release, timestamps and sanitized outcomes across restart and disable. Reads require developer mode; no cache deletion operation is provided.",
    regeneration: "Enabled server-owned six-hour checks or an explicit enabled check. Restarted observations are stale until verified again; failures retain last good values." },
  { id: "client-local", kind: "configuration", paths: [], location: "client", ownership: "external", reads: [],
    retention: "Canvas layout/windows/drafts, pairing intents, Chrome/Android outboxes and history belong to each device. The server cannot clear browser storage.", regeneration: "Mounted client stores can rewrite cleared keys; outboxes stay bound to their original server destination." },
]);
