# Review UI handoff

Date: 2026-09-28. Implementation baseline: `8819393` on `main`, pushed after proposal 4. This handoff covers the nine supplied API/general/UI reviews, the integrated UI work, and all four approved hardening proposals. It is a backlog and implementation contract; approval of the hardening proposals and this write-up does not approve the new UI described below.

Start with [the hardening review](hardening-review.md), [CONTEXT](../CONTEXT.md), and ADRs [0110](adr/0110-proc-durable-caller-authority.md), [0112](adr/0112-research-network-egress.md), [0113](adr/0113-authenticated-local-control.md) and [0114](adr/0114-explicit-worker-disclosure.md). The original reviews live outside the repository at `~/scratch/agentstack.review.{api,general,ui}.{1,2,3}.md`; this document records the actionable follow-up without requiring those files.

## Recommended order and approval boundaries

| Order | Work | Destination | Dependency / decision |
| --- | --- | --- | --- |
| 1 | Local session state, reconnect guidance and sign out | Existing global connection surface / System | Approve session UX; current-session logout already exists. Global revocation remains private-socket-only. |
| 2 | Research policy explanation, grant history, create/revoke | Brain Jobs and Sources | Approve UI and a narrow local-operator transport contract for socket-only grant operations. |
| 3 | Durable schedules, executions, runs and legacy reauthorization | System | Approve new windows/node kinds and Proc mutation controls; API is already available over WebSocket. |
| 4 | Authentication and Worker disclosure guidance in the reference | Existing API reference; contextual Roles/Workers help | Effective Worker selections already render. Approve the additional guidance/diagnostics, not a policy editor. |
| 5 | Keyboard move/resize, reset recovery and touch gestures | Existing benches/windows | Approve one coherent interaction design. |
| 6 | Outcome-aware errors, delivery budgets and partial availability | Existing operation/status surfaces | Backend/wire/product decisions first; proposals 5–7 in the hardening review remain open. |
| 7 | Measured performance, remaining accessibility and device-client polish | Existing surfaces | Reproduce/measure candidates before implementation; some review claims were speculative or superseded. |

Items 1–4 are the direct follow-up to shipped security/authority changes. Items 5–7 retain unresolved review recommendations. A read-only first increment is useful for Proc and research policy; any grant, reauthorization, cancellation or revocation control needs its own explicit scope in the implementation request.

## Already shipped: preserve, do not recreate

| Area | Current behavior |
| --- | --- |
| Role summaries and editing | Ordinary `role_snapshot` and mutation replies omit complete MCP definitions, including URLs/argv/env/headers. Native launch uses socket-only `role_launch_snapshot`. The existing operator editor reads `role_editor_snapshot` through its declared socket/WebSocket path. The existing Launch preview uses `role_launch_preview`. Full definitions are not embedded in ordinary SSR snapshots. |
| Discovery | Transport operation/event/route metadata is validated before rendering; fallback package enumeration is manifest-derived. Proposal 4 adds required MCP `workerOperations` validation and displays effective selection as a **catalog snapshot** in the existing reference. Invalid policy metadata must not silently become an empty selection. |
| Authentication | Private CLI bootstrap, authenticated UIX SSR and Inspector, local session cookies, fresh one-use WebSocket tickets, expiry/revocation fencing and signed remote Access handoff are implemented. The plain connection shell explains `agentstack open`. Local ticket failures already report a reconnect instruction. |
| Brain | Brain already has search/reading, admission, Jobs, Sources, dispositions, source sync/pause, audited reveal and document deletion. `jobs_show.network_policy` is typed and visible in generic record inspection; grant changes invalidate job policy reads. Dedicated grant management is missing. |
| Existing spaces | Access approval/grants are in System. Roles resource editors, Inbox, Signal, Content, Workers, Scrape, Browse and Brain were integrated and retained. Old reviews saying these are absent are superseded. |
| Existing accessibility | Resource selection uses a button separate from inspection/navigation. Bench shortcuts honor handled keys and interactive ARIA roles. Attention dots, keyboard-reachable row hints, touch-visible copy buttons, explicit chat-history loading and status announcements are fixed. |
| Existing cleanup | Activity grouping is linear; font variables are no longer self-referential; browser fixtures use current schemas/manifests. Shared forwarding budgets replace inconsistent gateway waits, including account removal. |

Workers-space operator views still inspect all operator-visible Workers. Self-only reads apply to an authenticated **Worker caller**, not to the human's UIX inventory. Worker `readOnlyHint` badges describe behavior, not disclosure authority.

## 1. Local session and connection UX

### What is missing

There is no dedicated local-session control. Existing package channel/error states do not provide a single clear session-level recovery path. `channel.ts` retries failed ticket acquisition with backoff, including authentication refusal. The System Inspector link opens a credential-free URL; an unauthenticated Inspector correctly presents its own CLI bootstrap instructions.

### Proposed increment

- Show whether this is a local browser session or a remote Access session. Distinguish authentication required from a temporary transport outage and from an individual resource read failure. Keep last-good data visibly stale; disable actions whose authority is unavailable.
- Give local users an explicit “Run `agentstack open` on this machine to reconnect” path. Inspector instructions use `agentstack open inspector`. An ordinary URL is not a reusable login link. Do not add secrets to status records, copy chips, URLs in discovery or logs.
- Add **Sign out of this local session** using the existing same-origin `POST /connect/local/logout` route with JSON `{}`. Clear protected client state and route to the connection shell after logout; retain the distinction between local UIX and Inspector audiences.
- Explain **Revoke all local access** separately: `agentstack revoke-local` rotates the operator credential and invalidates local browser sessions, bootstrap capabilities and tickets. It does not revoke remote Access grants or signed Bot/Worker identities. A browser button for this is a separate authorization-contract decision.
- Make bootstrap failures accessible (status/live announcement), including expired/consumed links and receiving a new fragment while the connection shell is already open. Do not replace the minimal CSP-protected shell with an application render that reads trusted-local state before authentication.
- Consider suspending automatic ticket retries after a confirmed authentication refusal until explicit recovery. Keep transient network retry behavior. Preserve drafts deliberately if reauthentication navigates away, without persisting credential-bearing editor data.

### API/transport facts

`owner_local_connect` and `owner_local_revoke` are private-socket-only and reject supplied invocation context. Browser UI must not reach them through an arbitrary server-side socket proxy. Current-session logout is already authenticated and origin-checked. There is no public session inventory, per-session management API, or authenticated session-status/expiry read; do not invent a countdown or list from the eight-hour default. Add a minimal non-secret read contract only if the approved design needs one.

Remote sessions use the independent Access flow. Do not offer local reauthentication, local credential reset, local Access approval or Inspector bootstrap remotely. Remote UIX must not load local socket snapshots during SSR.

### Files and acceptance

Start at `packages/api/src/local-browser.ts`, `packages/api/src/local-auth.ts`, `packages/owner/api.ts`, `packages/uix/lib/stack/channel.ts`, `packages/uix/components/canvas/provider.tsx`, `system-windows.tsx`, and `packages/uix/proxy.ts`.

Verify live expiry/revocation, owner-restart rotation, two local sessions with single-session logout, fresh ticket acquisition on reconnect, anonymous SSR refusal, no secret persistence/logging, accessible error announcements, and remote session behavior. Distinguish a failed sign-out request from confirmed logout. Global revocation must not be represented as remotely available.

## 2. Brain research policy and private-destination grants

### What is missing

The existing inspector shows `network_policy`, but Jobs/Sources have no focused policy explanation, grant history, grant editor or revoke control. Public-only refusals and fail-closed browser enforcement now need an understandable recovery workflow.

### Proposed increment

- In existing Job details, summarize **Public only** or **Public plus explicitly granted destinations**, the root job/source scope, grant ID and exact source-definition version. Link to related records without automatically revealing submitted content.
- Explain policy outcomes using their actual codes: `network_policy:private_destination`, `network_policy:browser_egress_unverifiable`, `egress_grant_revoked`, `egress_policy_changed`. Keep permanent policy denial distinct from a transient fetch failure. A grant cannot repair an unverifiable browser provider.
- In Sources, show that a grant is bound to one definition version; editing a source does not carry old authority forward. Child jobs inherit their admitted root/source scope. Do not offer a per-child bypass.
- Add a local-operator grant list/detail and explicit create/revoke workflow. Show exact numeric IP addresses and TCP ports; no hostname wildcard, CIDR, “allow all private networks,” or signed-in-profile reuse. New grants require revoking an existing grant before changing destinations.
- Show revoked records as history. Revocation fences queued/active work, cache reuse and completion; it does not delete previously indexed research. Grant creation/revocation does not automatically retry failed jobs. Keep any subsequent job retry explicit.
- Preserve bounded history honestly: `egress_grant_list` returns the latest 200 records, not a complete paginated audit log. A broader history UI needs an API addition.

### Backend dependency: approve a local-only control path

`egress_grant_create({scope, policy})`, `egress_grant_revoke({id})`, and `egress_grant_list({})` are **socket-only**, absent from MCP/WebSocket. Scopes are `{kind: "job", id}` for a URL submission root or `{kind: "source", id, version}` for an exact source definition; policy contains `privateDestinations: [{address, port}]`.

Do not simply append them to generic WebSocket exposure: that would create a new surface with remote Access implications. First specify authenticated local-operator admission, remote denial and server-side enforcement through the shared gateway/operation model. If a narrow HTTP route is chosen instead, authenticate it explicitly and constrain its operations; no arbitrary socket-call bridge. UI hiding is not authorization. Until approved, use existing socket operations outside the UI and show only existing job-policy data.

### Data, placement and acceptance

Use Brain's existing Jobs/Sources destinations. A new grant node kind needs `NodeRef`, key parsing, `homeOf` and inspector registration in the normal data/navigation layers. Add grant types, bounded reads and invalidation handling; `jobs_changed` already covers grant changes and effective policy. Do not assume `sources_changed` alone refreshes grants.

Start at `packages/brain/src/egress.ts`, `packages/brain/src/changes.ts`, `packages/brain/api.{ts,yaml}`, `packages/uix/components/canvas/brain-ledger.tsx`, `brain-shared.tsx`, `inspector.tsx`, and `packages/uix/lib/stack/{brain,store,types}.ts`.

Verify source-version conflicts, non-root job rejection, IPv4/IPv6 destination validation, revoked grants, a denial followed by grant plus explicit retry, cache/completion fencing, stale reads and remote denial. Preserve audited `jobs_reveal`; ordinary list/policy views must not fetch captured text or full submitted intent. Keep research admission distinct from indexing completion. Live Hypeman netfilter enforcement still needs Linux verification; do not label it verified based on the macOS test suite.

## 3. Proc schedules, executions and runs

### What is missing

Proc is discoverable through API reference and package/channel metadata, but has no record inventory, node destinations, detail reads or dedicated controls. A generic inspector can render fields only after a record is made reachable; it is not a substitute for that wiring. Legacy schedules now require deliberate operator review and reauthorization.

### Recommended design

Put **Schedules** and **Runs** in System, with execution history linked from schedules. Proc processes are distinct from read-only ACP Worker conversations in Workers. Start with inspection, then add explicitly approved editing/reauthorization/run controls.

Schedules should show:

- ID, revision, enabled state, cadence/next due time, blocked reason and retry time.
- `createdBy`, `lastEditedBy`, and effective `authority` separately. `authority: null` means legacy/unattributed; editing is not authority promotion.
- Bot root/thread references where present. A stopped Bot is held; a removed Bot or changed sanctioned root is blocked. Preserve the exact backend reason alongside understandable wording.
- Protected system schedules, including Brain source sync, with unavailable edits explained. Source pause remains in Brain; do not present the protected scheduler as a user-disableable interval.

Execution/run views should show:

- Captured action and authority at admission, not today's schedule definition. Legacy captured fields may be null.
- Execution outcomes `running`, `completed`, `failed`, `refused`, `unknown`; run states `starting`, `running`, `exited`, `failed`, `cancelled`, `unknown`.
- Exit code/signal, errors, related schedule/execution/run IDs, output retention/truncation, and observation timestamps. Unknown is not failure and must not trigger automatic replay.
- Cursor-based stdout/stderr, partial-line flags, `gap`, `nextAfter` and `done`. Bound retained UI output and deduplicate after reconnect. A coalesced notice is not an output line.

### Mutations and authority

`proc_schedule_reauthorize` takes the reviewed definition and exact revision. Present the action/input or executable/argv/env/cwd before authorizing a legacy schedule; do not turn it into a bulk “enable all” operation. Preserve unknown creator/history. It cannot promote a Bot schedule or replace protected system authority.

Create/update/remove/enable and direct-run start/cancel require explicit UI approval. Keep IDs/request keys stable across uncertain admission; use `expectedRevision` and re-read on conflict. Never silently overwrite a newer schedule or resubmit an uncertain run with a fresh request ID. Process launch uses an absolute executable and argv, not shell text. Environment and output may contain secrets: do not preload them into broad activity rows or add automatic copying.

The API already has MCP/WebSocket exposure, but Workers select no Proc operations and handlers reject Worker ownership. Decide remote UI policy explicitly: Access-selected transport availability is not permission to bypass operator-only/protected-record checks. The first new control increment should be local-only unless remote control is expressly requested and verified server-side.

### Data, files and acceptance

Use `proc_schedule_list/get`, `proc_execution_list/get`, `proc_run_list/get/read`; `proc_run_wait/join` are observations, not cancellation. Subscribe to `proc_schedules_changed`, `proc_runs_changed`, `proc_output_changed`, with appropriate schedule/run scope and list invalidations. Re-read after subscribe/reconnect; do not suppress interruption evidence.

Start at `packages/proc/api.ts`, `packages/proc/src/{schema,service,store,authority}.ts` and the UI's `lib/stack/{types,store,spaces,navigation}.ts`, `components/canvas/{spaces,inspector,system-windows}.tsx`. Add reachable node kinds for schedules, executions and runs; preserve independent System camera/window state.

Verify legacy migration/reauthorization conflicts, Bot ownership/root changes, held schedules, protected Brain sync, removed-schedule history, captured execution provenance, unknown outcomes, bounded/gapped output and reconnect without duplicate lines or execution. All mutation failures need visible status and inspect-before-retry guidance where outcome is uncertain.

## 4. API reference, Role and Worker policy explanation

The effective Worker selection is already displayed under MCP transports and validated against normal MCP exposure. Other transports report `workerOperations: []`. Discovery itself now has MCP operations `docs_list`, `docs_get`, `docs_snapshot`; a custom Role MCP server named `api` must be renamed before launch.

Additional useful work, if approved:

- Add authentication prerequisites to the existing transport instructions: native operator clients use `operatorHeaders(env)` and reload credentials after rotation; browser clients use a local session plus a fresh one-use ticket; native Bot/Worker URLs carry signed runtime identity. The JSON examples are illustrative message bodies, not anonymous executable requests. Never put actual credentials into generated examples.
- Clarify the Inspector link's independent bootstrap, and that discovery selection is a snapshot rather than a session-specific authorization promise. The gateway rechecks current Worker policy before calls and before releasing results; ownership guards can still refuse a selected operation.
- Explain in contextual Roles/Workers help that selected Brain/Content retrieval intentionally discloses shared corpus data, Worker records are self-only, and third-party Role MCP servers/OS tools are outside this policy. `readOnlyHint` is not a “safe to share” guarantee.
- If a future per-operation Worker badge or policy diagnostic is desired, derive it from effective discovery. Do not maintain a second frontend allowlist or offer an editable policy switch without a separate manifest-management design.

Start at `packages/uix/lib/stack/{reference,catalog,types}.ts` and `components/canvas/{reference,system-windows}.tsx`. Preserve separate credential-safe snapshots and complete editor reads. Do not repair an editor refresh by copying full MCP definitions into the global SSR snapshot or ordinary mutation results.

Acceptance: catalog mismatch is a read error, not silent permissive/default exposure; denied packages show “none”; illustrative payloads remain secret-free; narrowed policy is enforced on existing native sessions even if their tool menu is stale. UIX operator visibility must not be filtered using Worker policy.

## 5. Remaining bench and accessibility design work

The original reviews contain repeated findings; the completed fixes above should not be reopened as missing features. Remaining candidates:

| Candidate | Proposed scope / evidence needed |
| --- | --- |
| Keyboard move/resize | `window.tsx` still has pointer-only resize grips. Define keyboard movement and sizing with focusable controls, size/position announcements and cancellation. Reuse the dock's keyboard principles, but choose semantics appropriate to two-dimensional sizing. Preserve snapping, zoom coordinates and minimum sizes. |
| Accidental layout reset | Decide undo/recovery or a deliberate reset interaction for the `T` shortcut. Avoid destroying a carefully arranged bench without recovery. Keep per-space persisted layouts independent. |
| Touchscreen pinch and help | Trackpad ctrl-wheel zoom exists; touchscreen two-pointer pinch is not implemented. Either approve pointer-pinch or narrow the help that currently says “Pinch.” Test native inner scrolling, pointer capture and zoom focus on touch hardware. |
| Navigation links | Inspector/package/activity destinations often use buttons. Convert actual navigations to real links via existing location helpers where this preserves `goTo` semantics, camera behavior and dock history. Actions that reveal/open local state may still be buttons. Test modified clicks and back/forward. |
| Process table semantics | Resource grid headers are hidden from AT. Give values column meaning through semantic structure or inline labels/units, without forcing an interactive grid model onto a read-only list. |
| Remaining announcements | Verify destructive-operation outcomes, expired local sessions, inspector results and offline recovery are announced without live-stream chatter. Decorative icon and hover-only timestamp audits should identify actual accessibility-tree problems before broad edits. |
| Date/locale formatting | Inline locale formatting exists across SSR/client views. Reproduce server/client timezone or locale mismatch; use consistent timestamp/duration conventions and hydration-safe formatting where needed. |
| Access pairing drafts | A review proposed revision-keyed pairing drafts. First establish whether pending advertised scopes can change: do not invent a revision field. If they can, reconcile drafts against authoritative scope changes; keep grant revision conflicts intact. |
| Small cleanup | Redundant initial navigation props, Access first-paint loading, manual theme choice and visible gesture help are low-priority design/cleanup candidates, not proven regressions. System-following theme remains the current contract. |

The `blockedDepths` array in resource-tree rendering is local to a render. Its mutation alone is not evidence of a concurrency bug; a pure visibility derivation may simplify a future refactor, but preserve behavior and do not claim a reproduced race.

## 6. Backend-dependent future UI contracts

These are **not** part of the four approved proposals:

- **Structured errors/outcomes:** agree stable code, message, outcome (`refused`, `failed`, `unknown`) and retry guidance across socket/MCP/WebSocket, discovery and UI state. Keep runtime output validation. Post-effect validation/timeout failure is not proof that no mutation occurred. Migrate `channel.ts`, operation hooks and existing string-based outcome classification together. Cancelling a wait must remain distinct from cancelling an admitted job/run/turn.
- **Declared latency:** shared timeout budgets now work, but operation-level latency metadata is a future contract change. Do not invent progress percentages or frontend timeouts that convert a still-running mutation into a definite failure.
- **Event delivery budgets:** choose coalescing, minimum intervals, per-Bot budget and suspended-state semantics before adding subscription controls/status. Direct feedback cycles are already fenced. `threads_changed` remains an invalidation, not proof that a sanctioned Bot thread changed.
- **Partial availability:** the current shared WebSocket handshake and required owner-child lifecycle are fail-closed. A per-package degraded mode needs explicit backend admission/retry/restart semantics; frontend error suppression cannot make an unchecked package safe to expose.
- **API naming cleanup:** new-operation style guidance can precede migration, but Brain/Content aliases or renames require coordinated types, store reads, actions, reference and fixtures. Do not rename APIs as incidental UI cleanup.

## 7. Performance and device-client follow-up

**Measure before changing the store.** `useStack()` subscribes to whole-state updates; event logging and refresh each notify, hover context changes can rerender consumers, and `useNow()` creates per-consumer timers. Capture representative visible/hidden-space render counts and interaction latency under resource sampling and event bursts. Only then choose selectors, event batching or a shared clock. Preserve invalidation/reconnect evidence, hidden-bench isolation and snapshot consistency. The quadratic activity accumulation is already fixed.

**Chrome:** verify popup/options at 200% zoom and narrow widths, including long labels/URLs and the current `white-space: nowrap` button rule. Check fast status announcements, connection failure copy and “Forget locally” wording: remote approval persists. Keep destination-bound outboxes and admission-versus-indexing terminology.

**Android:** review hardcoded settings strings for resource extraction, large-font/narrow button rows, and durable discoverability of admission/queued/failed share outcomes currently accompanied by a short Toast. The existing outbox and recent-link notifications are the starting point, not a new parallel queue. Any new notification workflow needs explicit UX approval. Keep current autofill restrictions, minimum targets, destination-bound retries and local-forget versus remote-revoke semantics.

Sources: `packages/chrome/{theme.css,popup.js,options.js}`, `packages/android/app/src/main/java/dev/agentstack/app/SettingsActivity.kt`, `share/ShareActivity.kt`, their layouts/resources, and [the share contract](brain-share-contract.md). Device clients authenticate through Access, not the local UIX bootstrap. Use fixture stores/settings; never import the user's research store, tokens or client settings for tests.

## Implementation and verification checklist

1. Agree each increment's UI, mutations and local/remote authority. Do not add a new Canvas space where an existing destination fits. Record any changed transport/lifecycle contract in an ADR.
2. Keep `api.yaml`, typed operations/descriptions/exports and discovery tests aligned. New fields on reachable records already render generically; add specialized views only when requested.
3. Update `packages/uix/lib/stack/types.ts`, store reads/subscriptions and affected inspectors/cards together. Register every approved new node kind in `lib/stack/spaces.ts`, key parsing/navigation and the existing window registry. Keep bodies independent of bench geometry.
4. Test loading, empty, stale, refused, conflict, disconnected and unknown-outcome states. Use revision fences and idempotent keys; never auto-replay an uncertain mutation. Check keyboard, touch/zoom, light/dark, reduced motion, focus restoration and hidden-space isolation for changed interactions.
5. Run `pnpm --filter @agentstack/uix typecheck`, relevant unit/browser checks, and full `pnpm test` for cross-package authority/wire changes. Browser fixtures must include real schemas and `workerOperations` on MCP discovery, authenticated admission and isolated manifests matching live fixture sockets.
6. Build in a separate checkout or use `pnpm --filter @agentstack/uix dev`. An in-place `.next` rebuild under the live owner and an owner restart require authorization. Use disposable `AGENTSTACK_STATE_DIR`; never replace a live socket to make a test pass.
7. Commit each completed increment on `main`, retain/deconflict concurrent work and push normally. Source landing is separate from deployment.

Baseline evidence for proposal 4: **40/40 Turbo tasks, 960 tests passed, 7 skipped, zero failures/cancellations**, plus UIX typecheck and real owner/Next/Inspector lifecycle assertions for rendered Worker policy. Earlier local/remote real-browser authentication checks passed as recorded in the hardening review. The seven skips include six credential/runtime-gated cases and Linux-only netfilter enforcement. This documentation adds no deployment or new verification claim.
