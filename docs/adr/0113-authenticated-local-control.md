# 113. Authenticate ordinary loopback control clients

Status: accepted, 2026-09-28. Implements hardening proposal 3. Extends the shared MCP/WebSocket gateways and owner-managed UI/Inspector; preserves ADR 0101's independent remote Access policy.

The subsequent [ADR 0114](0114-explicit-worker-disclosure.md) replaces the Worker read-only-hint selection described below with explicit positive disclosure selections.

## Decision

TCP reachability is not operator authority. MCP requires either the private operator bearer credential or a signed Bot/Worker launch identity whose instance is still live. Authentication precedes socket metadata reads and is rechecked before calls and returning operation results. Bot thread and downstream ownership checks remain independent. Worker selection still uses `readOnlyHint`, pending the separate audience-policy decision. Private Unix sockets retain their same-user authority.

`<state>/local-auth/authority.sqlite3` is a mode-0600 database in a mode-0700 directory. It holds the operator secret and digests of bounded, expiring browser capabilities. Consumption is transactional across owner children. Unsafe permissions fail closed. The owner rotates authority after successfully claiming its socket and before starting gateways. A duplicate owner start cannot revoke the live owner. Socket-only `owner_local_revoke` rotates the credential and deletes all local capabilities. Standalone gateways share authority through the same private state directory.

`agentstack open` and `agentstack open inspector` ask socket-only `owner_local_connect` for a 60-second, single-use, exact-origin/audience-bound fragment capability, then invoke the OS browser opener without printing it. The public `/connect/local` shell contains no operator state. It erases the fragment before exchanging it by same-origin JSON POST for an eight-hour, host-only, HttpOnly, SameSite=Strict cookie. Session tokens never enter JSON. Local control uses HTTP loopback; cookies are not an isolation boundary against hostile local HTTP servers on the same hostname, and same-user programs can already read private authority. Do not forward these listeners or use them as a shared-host service.

UIX authenticates page, RSC and asset requests before trusted-local server rendering. The local page obtains a 30-second single-use WebSocket ticket by same-origin POST, passed as an `agentstack-local.<ticket>` subprotocol, never a URL query. The gateway binds it to the browser Origin and parent session. Each reconnect obtains a fresh ticket. Native Origin-less WebSocket clients use the operator bearer header. Revocation is checked before messages, operation results and event delivery; idle local connections close within 250ms and sessions close at expiry. Exact Host/Origin checks remain mandatory.

Access retains its remote cookie, refresh, scope and provenance policy. Its private Next handoff adds a short-lived HMAC assertion bound to HTTP method, path/query, remote origin and scope headers. Next rejects forged remote markers. Remote server renders still perform no trusted-local socket snapshot, and remote WebSockets still enter through Access.

Inspector 2.7 embeds its API token in HTML. An owner-scoped preloader gates every HTTP response before the pinned dependency's router, including HTML and static assets, using a separate Inspector browser session; upgrades are refused. The dependency's API token stays enabled. Its boolean omission switch must be empty, since the string `"false"` is truthy. Private generated MCP configuration includes operator bearer headers and refreshes them after rotation. Open a new authenticated Inspector session and reconnect its server after revocation. Credentials never enter ordinary discovery, owner status or startup logs.

## Consequences

Existing anonymous TCP clients must migrate. Native operator tooling imports `operatorHeaders(env)` from `@agentstack/api` and reloads it after restart or `agentstack revoke-local`; Bot/Worker launch URLs already supply independent credentials. Local browsers require the CLI again after eight hours, restart or revocation. A development UI origin must exactly match the owner's `AGENTSTACK_WEBSOCKET_ORIGIN`; `agentstack open uix <configured-origin>` bootstraps it using the same state directory.

UIX build scheduling explicitly depends on its workspace dependencies. Otherwise Turbo can reuse a Next bundle containing older shared authentication code while rebuilding the API package. Verification uses a separate checkout and disposable state; deployment requires an authorized coordinated rebuild/restart.

Socket-only bootstrap/revocation operations appear in the schema-driven API reference. Dedicated local-session controls are not part of this change.
