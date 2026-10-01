import { stateCategories } from "@stack/api";
export const githubStateCategories = stateCategories("github", [
  { id: "webhooks", kind: "storage", paths: ["github"], sensitivity: "credential", reads: ["github_status", "github_endpoint_list", "github_watch_list"], actions: ["github_history_plan"],
    retention: "Private SQLite owns receiver configuration/secrets, original signed payloads, summaries, watches, frozen matches, remote plans and request receipts. Payload admission stops at its configured byte/10,000-payload budget; nothing is silently evicted.",
    regeneration: "Exact payload plans clear bytes but retain delivery identity/digests, summaries, matches and retry evidence. Redelivery does not restore a cleared payload. GitHub and explicit new deliveries remain independent." },
]);
