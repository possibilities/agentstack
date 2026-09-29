# 114. Select Worker-visible reads explicitly

Status: accepted, 2026-09-28. Implements hardening proposal 4. Extends ADR 0096's shared exposure resolver and ADR 0113's authenticated runtime admission.

## Decision

`readOnlyHint` describes mutation behavior; it does not authorize disclosure to a Worker model/provider. An MCP manifest may declare `workerOperations`, a positive list of operation names or `[]`. Omission means `[]`; `all`, exclusions and wildcards are invalid. Every shipped MCP manifest declares its selection explicitly. Unknown names, duplicates and selected operations without `readOnlyHint: true` fail validation. The hint is an additional consistency check, never a way to expand the selection.

The shared resolver intersects this list with ordinary MCP operation exposure. A valid named operation removed from ordinary MCP exposure becomes unavailable to Workers too. Worker event selections are always empty; generated Bot event tools remain unavailable. Socket and WebSocket operator authority and ordinary Bot MCP exposure retain their policies.

Startup and discovery validate built declarations without creating contexts. MCP validates authoritative live socket metadata without importing Package APIs. Worker tools/list resolves current policy; tools/call checks current selection before forwarding and again before returning a result, and rechecks live runtime identity. Removing a selection or transport, making policy invalid, or replacing the runtime fences future reads and withholds an in-flight result. Data already delivered to a provider cannot be recalled. Native sessions need no relaunch to enforce narrower policy, although a native client may need to refresh its displayed tool list.

Initial Worker selections:

- `api`: `docs_list`, `docs_get`, `docs_snapshot`. Discovery gains an explicit MCP transport for these credential-free schemas and selections.
- `roles`: `role_snapshot`, `role_preview`; complete launch/editor definitions and launch configuration remain excluded.
- `brain`: `stats`, `search`, `context`, `get`, `tags`. These explicitly disclose the shared indexed research corpus, not ingestion intent, job captures, source configuration or network grants.
- `content`: document retrieval/search/link metadata, Artifact metadata/version reads, collection/item retrieval and bounded item bytes. Shared Content is intentionally readable; upload state and maintenance/mutation operations are excluded.
- `worker`: list/status, transcript, detail, turns, structured records/chunks, tools and diff. A Worker sees only itself, never siblings on the same account or owned by the same Bot.
- All other MCP Package APIs select `[]`, including auth, Bots, Browse, notifications, owner resources, Proc, Scrape, usage and Xcom. Sign-in URLs/codes, cross-Bot conversations, notifications and Proc specifications/output are therefore unavailable to Worker MCP calls.

Worker record handlers independently verify the exact Worker ID, durable runtime instance, currently connected account runtime and live Worker phase. The inventory is filtered to that one Worker. Reads do not grant lifecycle/mutation authority; the existing Bot/operator ownership path remains separate. Historical inspection by operators remains available. Shared Brain/Content/Role reads deliberately have shared rather than per-Worker ownership; user-authored content can contain sensitive text and must be treated accordingly.

Discovery publishes each transport's effective `workerOperations` (`[]` outside MCP). UIX validates MCP discovery metadata and its existing API reference displays the selection, separate from read-only badges. It adds no policy editor or new workbench. Worker launch still passes configured Role MCP servers through as before; this policy governs AgentStack Package APIs, not third-party MCP servers, OS tools or unrestricted same-user filesystem/socket access.

## Migration and verification

There is no permissive fallback for older manifests. Matching API, Worker and UIX builds must deploy together through an authorized owner restart; ordinary status endpoints carry no new credential material. A custom Role server named `api` now conflicts with the discovery Package API and must be renamed before the next native launch. The owner continues to advertise credential-free MCP endpoints.

Tests cover default-deny selection, invalid names/duplicates/wildcards/mutations, intersection with MCP, live policy withdrawal and in-flight result fencing, sensitive read exclusion, Worker self/sibling/cross-Bot isolation, stale runtimes and unchanged operator inspection. This is a disclosure boundary on authenticated Package API calls, not an OS sandbox.
