import type { Endpoint } from "./schema.js";

export function setupRead(endpoint: Endpoint, port: number) {
  const target = endpoint.target;
  const origin = `https://${endpoint.githubHost}`;
  const settingsUrl = target.kind === "repository" ? `${origin}/${target.repository}/settings/hooks`
    : target.kind === "organization" ? `${origin}/organizations/${target.organization}/settings/hooks`
    : target.kind === "enterprise" ? `${origin}/enterprises/${target.enterprise}/settings/hooks`
    : target.kind === "marketplace" ? `${origin}/marketplace/manage`
    : target.kind === "sponsors_listing" ? `${origin}/sponsors/accounts` : `${origin}/settings/apps`;
  const blockers = [...!endpoint.enabled ? ["receiver_disabled"] : [], ...!endpoint.webhookUrl ? ["public_https_origin_unset"] : []];
  return { endpoint, ingress: { host: "127.0.0.1" as const, port, path: endpoint.path, localUrl: `http://127.0.0.1:${port}${endpoint.path}` },
    settingsUrl, automatedHookManagement: endpoint.githubHost.toLowerCase() === "github.com" && (target.kind === "repository" || target.kind === "organization"), blockers,
    deliveryEvidence: endpoint.lastDeliveryAt ? "signed_delivery_observed" as const : "not_observed" as const,
    steps: [
      { id: "publish", state: endpoint.webhookUrl ? "configured" : "required", title: "Publish the webhook path on a public HTTPS origin",
        detail: "GitHub's cloud cannot reach a private tailnet address. Use an explicitly configured reverse proxy or Tailscale Funnel for only /github/webhooks/* to the loopback intake. Never publish Stack control, MCP, WebSocket or UI listeners. The API does not create a tunnel or change network policy." },
      { id: "configure", state: endpoint.managedHookId ? "configured" : "required", title: "Configure the GitHub webhook",
        detail: "Use the exact webhookUrl, JSON content type, TLS verification, active=true and a unique receiver secret. Select all events for repository/organization hooks, or the events your App permissions and installation grant. The event catalog provides per-action permission guidance; not every event is available to every hook type." },
      { id: "secret", state: "available", title: "Install the receiver secret on GitHub",
        detail: "Automatic hook application supplies it privately via gh stdin. Manual setup uses github_endpoint_secret_reveal with reveal=true under local operator authority. Ordinary records and reads never expose the secret." },
      { id: "verify", state: endpoint.lastPingAt ? "observed" : "required", title: "Send a ping and inspect signed arrival",
        detail: "Configuration success is not reachability. Inspect lastPingAt, lastDeliveryAt, lastFailure and the delivery ledger; use a managed-hook ping or GitHub's delivery UI. A local receipt proves only that Stack received that signed request, not that every selected event is available." },
      { id: "watch", state: "available", title: "Create a watch and attach a Stack subscription",
        detail: "Create github_watch_create with event/action/repository filters or JSON Pointer predicates. Subscribe topic github_watches_changed, scope watch:<id>, readOperation github_watch_read, readArguments {id}. Read every page, process the entries, then explicitly acknowledge their cursor." },
    ],
    limitations: ["GitHub does not automatically redeliver failures; inspect and request redelivery explicitly", "GitHub caps webhook payloads at 25 MB and may omit events exceeding that size; Stack cannot reconstruct omitted payloads",
      "No guaranteed ordering across GitHub deliveries; sequence is Stack arrival order, not provider causality", "Signature authenticates body bytes, not delivery/event headers; treat routing metadata as observed data, never authority",
      "App/enterprise/Marketplace/Sponsors setup is manual; this API does not mint App credentials, install Apps, sign in, or automatically modify remote permissions", "gh automation targets github.com; GHES intake and versioned event catalogs are supported with manual setup"] };
}
