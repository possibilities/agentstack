# 166. Source receiver setup: create, secret, hook plan, probe and redelivery

Status: accepted, 2026-10-02. Phase 3 of the Source space of [ADR 0164](0164-source-space.md),
after the watches of [ADR 0165](0165-source-watches.md), over the receivers, secrets, `gh` hook
operations and remote receipts of [ADR 0159](0159-github-webhook-ledger-and-watches.md). It adds
no window, node kind or operation: setup lives in the existing **Receivers** window and is the
local operator's work.

## Decision

**Five facts stay distinct.** Local configuration, public prerequisite, remote configuration,
request receipt and signed arrival are never one "Connected". The request-receipt fact now shows
the requests this browser recorded and the owner's receipt for each ("None recorded",
"Not confirmed", "Admitted by GitHub", "Refused", "Outcome unknown", "Never sent"). A request being
admitted by GitHub is not a signed arrival, and the wording says so wherever a receipt appears.

**Create.** A header action, **New receiver**, opens a dialog: label, target (repository,
organization, enterprise, App, Marketplace or Sponsors listing, each with its own fields), GitHub
host (default `github.com`) and an optional public HTTPS origin. The receiver UUID is shown and is
the idempotency key. "Review receiver" freezes one request, shows it in words and as the exact JSON,
and cautions that a non-github.com host or a non-repository/organization target is set up by hand
and that no origin means nothing can arrive yet. "Save receiver locally" first **records the exact
request in the browser**, then sends it; if the browser cannot record it, it is not sent. The result
is "Receiver saved locally", followed by what `github_setup_read` says. A lost answer is read back by
ID (`github_endpoint_get`): created, absent or a conflicting ID, and saving again sends the same ID and
definition. After a reload, a recorded creation whose receiver the owner does not hold is offered
back ("Check by its ID"); one the owner holds drops its record silently. Target and host are
immutable and the edit view says so.

**Edit.** Label, public origin and enablement are saved separately against the revision that was
shown (`expectedRevision`). A conflict is refused, the receiver is read again and the person is told,
never overwritten. Disabling asks first: new requests are rejected, GitHub does not redeliver on its
own, history and watches are kept and the hook at GitHub is not changed. Editing the origin states that
a hook already at GitHub keeps its URL until a new plan is applied.

**Secret.** "Reveal secret" calls `github_endpoint_secret_reveal` with `reveal: true` and shows the
value in a single element with a copy button. The value exists in that component's state only: never in
the store, the inspector, `localStorage`, a URL, a list or a log, and never in the recovery journal. It
is cleared on Hide, when the panel closes, when another receiver is shown, when the connection drops,
when the right to reveal is lost, when the secret version changes (rotated here or elsewhere) and after
two minutes; an answer that lands after any of those is dropped. **Rotate** opens a confirmation:
immediate revocation is the default; a grace period (seconds, minutes or hours, at most 24 hours) keeps
the old secret accepted. It says rotation does not change GitHub, so GitHub keeps signing with the old
secret until it is updated (reveal and install by hand, or apply a new plan for a github.com
repository/organization hook, which transfers the secret privately). Rotation is not idempotent, so an
unclear answer is read back (the secret version) and never repeated; a stale revision is refused.

**Automated setup (github.com repository or organization).** Every step is an explicit button and
reading changes nothing at GitHub. *Check gh sign-in* reads `github_auth_status` (login and a sanitized
error; the UI never signs in and provider text never reaches the page). Pickers in the create dialog page
`github_repositories` / `github_organizations` after that check; an admin flag is an observation, not a
guarantee. *Read hooks* lists the hooks (`github_hook_list`): the managed or URL-matching one first, the
rest "Not touched". A plan (`github_hook_plan`, events `*` by default or an explicit list) needs the
hooks read first, is then shown in a **bespoke plan review**: create or update, the exact hook ID, the
webhook URL, events, the changes at the existing hook (URL, events, active, content type, TLS), how many
other hooks stay untouched, the owner's consequences, a live expiry, and a warning (and a disabled Apply)
if the receiver changed or the plan expired. Changing the intent means discarding it and preparing a new
plan. Apply asks to confirm, then sends `github_hook_apply`.

**Recovery journal.** Apply, ping, push test and redelivery each get a request UUID that is **recorded
in the browser (per receiver) before the request is sent**; the arguments that are sent are rebuilt from
that record, so what was recorded is what goes out. Any failure to get an answer (an error, a closed
connection, a reload) is resolved by reading `github_remote_receipt_get` for that same request ID and
nothing else: a receipt settles the entry, no receipt means the owner never began it (so it never
reached GitHub), and an unreadable receipt leaves it "Not confirmed". Only a request the owner never
recorded may be sent again, and only under its own ID; an unknown or unconfirmed outcome is never sent
again and never replaced by a new request ID. The person can read a receipt, or forget an entry (the
owner keeps its receipt). The journal holds IDs, plan and hook IDs, intent text and statuses, never a
secret, and is bounded (unsettled entries are never trimmed).

**Probe.** Ping (and, for repository hooks, push test) is confirmed, then requested for the exact managed
hook. The **Request** row shows only the receipt; the **Arrival** row is the receiver's own observation
(`lastPingAt` for a ping, `lastDeliveryAt` for a push test) judged against when the request began, and
says that an arrival after the request fits it without proving it caused it.

**Delivery attempts.** `github_hook_deliveries` pages GitHub's attempts (newest first, with the provider's
opaque `nextCursor` passed back untouched). Each is matched to local arrivals of the same receiver by
delivery GUID, never by sequence, over a bounded recent window of local sequences (500, widened on
request): matched ones link to the delivery reader, others say "no local arrival in the part searched",
not "never arrived". **Redeliver** confirms the exact attempt (ID, event, GUID, status), says that a GUID
Stack already holds is a duplicate (no second sequence or watch entry) and that cleared payloads stay
cleared, then goes through the journal.

**Manual setup (App, enterprise, Marketplace, Sponsors, GHES).** No automated hook control exists for
these. The panel gives the settings page (an explicit "Open on GitHub" link, only when it is an https page
on the receiver's own host, otherwise text), the exact webhook URL with a copy button, the values to enter
(JSON, TLS verification on, active, events), the owner's ordered steps, a link to the event catalog, and
only then the deliberate secret reveal.

**Acknowledgement note (M7b follow-up).** The acknowledge confirmation now says that the cursor is shared
by everything that consumes the watch and that an independent consumer creates its own private watch.

## Remote boundary

Everything above is hidden remotely. The gateway fences `github_endpoint_create/update/secret_*`,
`github_auth_*`, `github_repositories`, `github_organizations`, `github_hook_*` and
`github_remote_receipt_get` (`localGithubOperation`) even with `ui:control`; no Access change was needed.
A remote viewer reads the five facts ("Request receipt: Local only") and nothing else about setup.

## Consequences

A person can set up, rotate and diagnose a receiver without a terminal, and cannot be told "connected"
when only part of the chain is known. A lost answer never causes a second request to GitHub, and the
secret never persists beyond the panel that showed it. The recovery journal is browser-local: another
browser does not see this browser's unconfirmed requests (it can still read any receipt by ID through the
API). Provider attempts correlate with a recent window of local arrivals rather than the whole ledger, since
the ledger cannot be searched by delivery GUID.
