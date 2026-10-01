# 155. Correlate asynchronous admissions with exact completion and attention reads

Status: accepted, 2026-10-01. Extends [ADR 0154](0154-notification-send-and-watch.md),
[ADR 0039](0039-worker-wakeups-and-scoped-mcp.md) and
[ADR 0093](0093-enforced-browser-handoff.md), superseding the latter's requirement
to manually subscribe before requesting a handoff. Preserves
[ADR 0096](0096-explicit-transport-exposure.md),
[ADR 0120](0120-codex-native-input-admission.md),
[ADR 0132](0132-native-hud-work-collaboration.md) and
[ADR 0146](0146-server-independent-internal-mcp.md).

## Shared owner and declaration

Serve's existing durable MCP subscription owner coordinates all watched admissions.
There is no second delivery loop or post-admission subscription gap. The intent,
capacity reservation and private coordination capability precede domain mutation.
Domain owners verify the capability after awaited preparation and immediately
before synchronous admission. A failed check proves pre-mutation refusal.

The typed `completionWatch` can bind read arguments to bounded identifiers from
input or the verified invoking Bot/Chat, select an input-derived scope, default
on for Bot MCP calls, place an unlike initial read under `observation`, and name
a nonterminal `updateField`. Bindings never copy arbitrary input or derive identity
from an admission response. The complete declaration is retained and rechecked
against live exposure before reading or delivering. Legacy Notify watches retain
their prior declaration, defaults and recovery semantics.

Only verified sanctioned Bot Chats receive automatic native input. Explicit
`subscribe: true` without that destination fails before mutation; omitted controls
do not invent operator or external delivery authority. `subscribe: false` creates
no new watch and does not cancel an existing one. Removal is explicit.

Terminal initial reads are returned as `observed`, without a redundant wakeup.
Subsequent non-null terminal reads retire only after native admission acknowledgement.
Optional changed attention reads are acknowledged without retirement: the receipt
stays `pending` and records `lastDeliveryKind: update`. A terminal attempt records
`terminal`. Reconnect suppresses unchanged acknowledged attention facts. Both
kinds persist an `unknown` fence at the synchronous native-send boundary; ambiguous
attention freezes subsequent delivery too, including terminal delivery, and never
automatically replays. A definite refusal permits fresh-read recovery.

## Domain boundaries

- Browser handoff requests default on for verified Bot MCP calls. The exact
  `{botId, threadId, requestId}` completion read remains null while held and yields
  the durable human report only after return. MCP explicitly selects
  `browser_handoffs_changed`. The report is not browser verification, approval or
  a grant of human input; the Bot must take a fresh snapshot.
- Worker start/send default on for verified Bot MCP calls. Each admitted turn
  retains its exact originating Chat and request UUID. A request-scoped semantic
  event invalidates an exact turn observation, never latest-turn status. Permission
  and recovery facts remain observable alongside terminal results; transcript/token
  progress remains separately subscribed. Native completion never completes HUD Work.
- Direct Proc runs offer opt-in exit watches, using the existing request/run UUID
  and a compact terminal read. Output remains cursor-based and independent;
  recurring schedules do not gain one-shot defaults. Unknown exits remain unknown.
- Brain submit/source synchronization offer opt-in watches with separate request
  UUIDs, retaining existing content deduplication and numeric ledger identities.
  Binding and admission share one Brain SQLite transaction. Exact job completion
  does not mean transitive fanout indexed; source completion means discovery and
  admission settled, not all child extraction completed. Summaries exclude raw
  content, URLs and arbitrary idempotency keys and never invoke audited reveal.
  MCP explicitly selects only the required job/source invalidations.

## Exposure, UI and rollout

Operation, read and topic selections remain independent. Workers gain neither
Bot wakeup authority nor the new cross-resource reads. Installed stdio discovery
declares capability without opening domain contexts; watched mutations require
the live owner and never fall back to standalone execution.

Existing UI contracts and subscriptions are maintained with the API change. New
sender controls, completion-history views and cross-domain receipt presentation
remain separate explicit UI work. Build verification in an isolated checkout does
not activate these contracts in a running Server; live rebuild/restart remains
human-authorized.
