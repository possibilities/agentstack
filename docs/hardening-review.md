# Hardening review — 2026-09-28

## Scope and assessment

Reviewed the nine API/general/UI reviews supplied under `~/scratch`, then checked the relevant current source, transport contracts, launch consumers and test fixtures. The starting tree was `2735b8d` plus existing uncommitted Proc/owner work. Verification uses an isolated checkout containing that working tree, disposable state and fixture-only browser checks.

The owner → package socket → transport gateway architecture is worth keeping. Explicit exposure selections, payload-free invalidations, revision fencing, durable admission and honest `unknown` outcomes are sound foundations. The most valuable changes are at their joins: browser admission, credential-bearing reads, forwarding budgets, caller context and discovery consumers. A broad service decomposition or framework rewrite would add complexity without addressing those defects.

## Implemented

| Area | Change |
| --- | --- |
| Browser control | WebSocket allows the exact UIX origins by default, or one explicit development origin. It rejects caller-supplied invocation context. |
| Private HTTP data | UIX validates Host before rendering its operator snapshot. Shared loopback HTTP listeners reject rebound Hosts. Browser gates and the underlying CDP relay check Host and browser upgrade Origin. |
| Role credentials | Ordinary snapshots and all edit responses expose MCP server summaries. Socket-only `role_launch_snapshot` retains full definitions for native Worker launch. URLs and argv are omitted alongside headers/env, rather than assuming only named token fields can be secret. |
| Access attribution | Brain's Access-only `share_receive` and `share_read_states` are excluded from direct MCP/WebSocket exposure. |
| Event delivery | Every subscription read receives its Bot invocation context. Self-watches of live chat and queue topics are fenced alongside thread/history topics; cross-Bot cycles across these topics are refused, including on resume. |
| Response waits | One package-qualified timeout policy serves MCP, WebSocket, scheduled API calls and subscription reads. It fixes the stale `attention` key, extends WebSocket account removal, and sets internal Codex MCP waits beyond the gateway budget. A catalog check catches stale entries. |
| Brain health | In-process doctor uses the owned listener's ephemeral credential instead of looking for an intentionally absent token file. No token is persisted or put in process env. |
| HTTP correctness | Separate `Set-Cookie` headers survive normal and error responses. |
| UI resilience | Invalid transport discovery metadata fails the resource read before rendering. WebSocket fallback discovery derives package names from manifests instead of a stale list. |
| Existing UX | Resource chart selection is a real button separate from inspect/navigation controls. Attention dots have an accessible role; row tooltips are keyboard reachable; copy controls are visible on touch; chat scrollback has an explicit load control and status announcement. Bench shortcuts honor already-handled keys and ARIA controls. |
| UI simplicity | Activity grouping uses linear accumulation. Font tokens reference distinct Next font variables instead of themselves. |
| Verification | Browser fixtures use actual schemas, current transport fields, the `worker` package name and isolated manifests matching their sockets. Fleet/Roles checks can run in dev mode. UIX DNS-rebinding rejection is exercised in the bench check. |
| Dependencies | Scrape's pinned `markdown-it` and `yaml` are updated to patched versions. |
| Documentation | Security, account pairing/removal, onboarding and isolated bench descriptions now match current behavior. ADR 0106 records the contract changes. |

## Proposals needing a product/architecture decision

### 1. Proc's durable caller policy — approved and implemented

**Original finding:** Proc validated targets against the full socket catalog and dispatched without invocation context, so target guards treated Bot schedules as operator calls. Schedules retained no creator. ADR 0105 explicitly permitted that behavior.

**Approved contract:** schedules retain operator, Bot/root/thread or protected system authority, separately from creator/editor attribution. Operator edits cannot promote Bot schedules. Current Bot launch/thread and MCP exposure are checked before dispatch; targets receive explicit scheduled provenance and retain their guards. Stopped Bots hold occurrences with bounded retry. Changed roots and removed Bots block automatic dispatch. Legacy schedules and history are preserved, but unattributed schedules require explicit operator reauthorization. See [ADR 0110](adr/0110-proc-durable-caller-authority.md).

**Implemented:** schema-v2 transactional migration, server-assigned attribution and authority, schedule/execution/run ownership checks, current-exposure resolution, revision-fenced admission, captured execution action/authority, removal tombstones, restart-safe blocked state, and `proc_schedule_reauthorize`. This is coherent API authorization; same-user process execution remains outside an OS sandbox. Dedicated Proc/reauthorization UI is still a separate decision.

### 2. Brain/browser egress — approved and implemented

**Original finding:** Brain passed `allowPrivateNetwork: true` for browser extraction. Submitted URLs and discovered source items could reach private destinations. Removing that flag alone left browser egress unverifiable.

**Implemented:** public-only execution contexts; socket-only operator grants for exact TCP IP/port endpoints bound to a submission root or source definition version; schema-v13 grant, attempt and cache evidence; scope-preserving child admission; active revocation and completion fencing; pinned HTTP extraction and redirects; and disposable Browse guests with IPv4/IPv6 OUTPUT filtering before Chrome starts. Research never borrows unrestricted profiles. An incapable provider fails closed. Existing job inspection exposes effective policy and policy denials remain permanent, inspectable ingestion outcomes. See [ADR 0112](adr/0112-research-network-egress.md).

**UI follow-up:** dedicated private-grant and revocation controls are not yet present; the existing inspector shows effective job policy. New controls require a separate request.

### 3. Authenticate ordinary loopback clients

**Verified:** anonymous MCP and Origin-less WebSocket clients retain operator authority. Other OS users can reach TCP loopback even though they cannot read private sockets. Signed Bot/Worker URLs are correlation and stale-instance fences, not mandatory credentials for all clients.

**Recommended sketch:** add a private per-owner operator credential, require either that or an existing signed runtime identity on MCP, and bootstrap the UI's WebSocket session through the same-origin UIX server with a short-lived token. Integrate Inspector and native tooling before disabling anonymous admission. This prevents accidental cross-user/cross-app access; mutually hostile same-UID agents still require OS-level isolation.

### 4. Explicit Worker-visible read policy

`readOnlyHint` still determines the Worker tool set. It means no requested mutation, not “safe to place in another provider's context.” Role connection definitions are now excluded, but sign-in URLs/codes, Proc specifications/output and cross-Bot transcripts warrant an explicit audience decision. Prefer a positive Worker operation selection resolved beside MCP exposure, plus package-level data ownership checks. Avoid abusing read-only annotations to hide genuinely read-only operations.

### 5. Errors, cancellation and declared latency

Keep output validation. On a post-effect contract failure, dropping validation or returning unvalidated output would make the API less trustworthy. Introduce a structured error envelope with a stable code, outcome (`refused`, `failed`, `unknown`) and retry guidance; carry it through socket/MCP/WebSocket and UI mutation state together. Distinguish observation cancellation from cancelling an admitted mutation. Move the now-centralized timeout policy into operation metadata when the wire/discovery contract is next versioned.

### 6. Delivery budgets and availability

Direct Bot feedback cycles are fenced, but high-rate external topics and indirect workflows can still cause excessive turns. Add a minimum delivery interval, coalesced pending snapshot and per-Bot budget with an explicit suspended state. Decide desired freshness/cost behavior before picking arbitrary limits.

One unavailable socket still refuses a new shared WebSocket connection; one failed required owner child still shuts down the stack. Both are documented fail-closed choices. If partial availability is desired, introduce explicit per-package unavailable state, admission/retry semantics and child restart classes together. Catching and ignoring failed metadata reads would weaken exposure validation.

### 7. Larger API and UX cleanup

- Brain/Content retain CLI-shaped names and fields. Introduce a style guide for new operations first; migrate existing contracts with deliberate aliases/versioning and UI changes rather than a sweeping rename.
- Measure store-notification/render cost before adding selectors everywhere. Whole-state subscription is a scaling concern, not a demonstrated performance failure in this pass.
- Window move/resize keyboard parity, accidental layout reset and touchscreen pinch need one coherent bench interaction design. Avoid adding several independent shortcut systems.
- Proc remains API-only. A System schedules/runs window with cursor-based output would make its durable state inspectable. Role MCP/skill/project management is now provided by the merged Roles UI.

## Review suggestions intentionally rejected or narrowed

- Do not disable runtime output validation for mutations.
- Do not globally flip Brain's private-network flag without an enforceable browser path.
- Do not claim manifest selection isolates unsandboxed same-user agents.
- Do not suppress all reconnect snapshots without deciding whether the consumer needs interruption evidence; the existing reconnect semantics are deliberate.
- Do not remove `shadcn` as “unused”: `packages/uix/app/globals.css` imports its CSS. Moving build-only dependencies can be a separate packaging cleanup.
- Do not delete stale-looking untracked directories or the pre-existing Proc work as housekeeping.

## Verification

- Full `pnpm test`: **38/38 Turbo tasks successful; 848 tests passed, 6 skipped, zero failures or cancellations**, including installer tests. Skips are the existing credential/runtime-gated Bot/Worker integration cases.
- `pnpm --filter @agentstack/uix typecheck`: passed.
- `pnpm audit --json`: zero advisories across all severities.
- Production-build bench browser check: passed, including Host rejection, desktop/mobile navigation, isolation, focus, dock behavior, persistence and API reference rendering; no uncaught page errors.
- Access browser check: passed, including approval/revocation, revision conflicts, stale/error states, light/dark/narrow rendering and no external requests.
- Auth, Roles and Fleet production-build browser checks: passed. Coverage includes sign-in copy/submit/retry/cancel, Role editing and conflicts, Bot lifecycle, model catalogs, inference admission/unknown outcomes, resumable uploads and light/dark/mobile rendering. All five rendered checks are green.
- `git diff --check`: clean.

## Merge integration — 2026-09-28

The local Proc/hardening commits (`77c1b8a`, `f055f59`) are combined with the eleven published commits through `000ac52`, preserving both histories. Published Inbox, Signal, Content, Workers and Scrape spaces, Role resource management, remote UIX and Worker diff/list work are retained. ADRs 0105–0107 resolve the decision-number collisions and document the integrated Role read and gateway contracts.

- Combined `pnpm test`: **38/38 Turbo tasks successful; 897 tests passed, 6 existing runtime/credential-gated tests skipped, zero failures or cancellations**, including installer tests.
- UIX typecheck passed; dependency audit found zero advisories.
- Roles and API tests passed again after clarifying the complete Role size descriptions.
- All ten production browser checks passed: Bench, Access, Auth, Roles, Fleet, Inbox, Content, Workers, Scrape and remote UIX. The Roles check exercises real transport selection, retained MCP definition editing, safe ordinary reads and omission of definitions from SSR HTML; the remote gateway test also rejects forged invocation context.
- `git diff --check` is clean. Builds and lifecycle/browser checks ran in an isolated checkout with disposable fixture state.

## Proc authority verification — 2026-09-28

Proposal 1 is implemented on the combined tree through `2b29daa`, retaining the Browse and Brain UI merges.

- Full `pnpm test`: **38/38 Turbo tasks successful; 931 tests passed, 6 existing runtime/credential-gated tests skipped, zero failures or cancellations**, including installer tests.
- All 21 Proc tests passed, covering caller attribution, cross-Bot isolation, live exposure withdrawal, stopped/restarted Bots, replaced roots, revision-fenced dispatch races, captured execution authority, process output ownership, legacy migration/reauthorization and shutdown outcomes.
- API socket/discovery, Auth operator-only, Worker ownership and Browser ownership regression tests passed.
- `pnpm --filter @agentstack/uix typecheck` passed. Proc remains represented by the schema-driven API reference; it has no dedicated store reads, subscriptions or record views to migrate.
- Builds and lifecycle checks ran in an isolated checkout with disposable state. `git diff --check` is clean.

## Research egress verification — 2026-09-28

Proposal 2 is implemented on the combined tree through `8ea23b1`, preserving the concurrent Xcom and Accounts work. The Xcom ADR is renumbered to 0111 to resolve its collision with the published Proc decision; research egress is ADR 0112.

- Final `pnpm test`: **40/40 Turbo tasks successful; 950 tests passed, 7 skipped, zero failures or cancellations**, including installer tests.
- Skips are six existing credential/runtime-gated cases and the new real-netfilter test, which requires an isolated Linux network namespace. Live Hypeman enforcement was not exercised on this Mac; portable tests cover fail-closed startup, provider receipts, fresh CDP attachment and refusal to use an unrestricted/pinned session.
- Real local HTTP fixtures verify public-only refusal, exact IP/port grants, redirects, static extraction, source discovery/inheritance, revocation, queued recovery and lease/cache fencing. Discovery tests verify grants and research acquisition remain socket-only.
- One earlier full run had an intermittent concurrent-admission child exit. The assertion now preserves child diagnostics; ten focused reruns and the final full run passed. No root cause is claimed.
- `pnpm --filter @agentstack/uix typecheck` and `git diff --check` passed. Effective policy is visible through existing job inspection; dedicated grant controls remain a separate UI decision.
- Builds and lifecycle tests used an isolated checkout and disposable state. The running owner's build and runtime were not changed.

## Deployment

Source changes are not deployment. The running owner has not been restarted and its checkout's `dist`/`.next` have not been rebuilt by this review. Apply a coordinated rebuild and authorized owner restart to use the matching Role/Worker contracts and browser policies. Development browser clients on another port must configure `AGENTSTACK_WEBSOCKET_ORIGIN` explicitly.

Proc authority also requires a coordinated owner rebuild/restart because its scheduled invocation envelope extends the shared socket contract. On that restart, existing unattributed schedules are disabled pending explicit operator reauthorization; the recognized protected Brain source trigger is preserved.

Research egress requires the matching Brain/Scrape/Browse packages. Its additive schema-v13 migration creates no grants. Existing private sources need explicit operator grants, and browser-only/authenticated sources need a capable isolated provider; existing signed-in profiles are not reused. A provider lacking working guest IPv4/IPv6 netfilter fails closed. Live Hypeman enforcement has not been exercised by the macOS verification environment.
