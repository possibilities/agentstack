# Device-local Stack data clearing — proposed contract

**Draft for review; not implemented.** The human approved preparing this contract
(07·D2), not new client/server routes, device runtime or UI. Server owner maintenance
does not delete device storage. This extends the [Share contract](brain-share-contract.md)
and [independent Client contract](client-bootstrap.md), without conflating their state.

## Authority and scope

Each client owns an explicit **Clear this device's Stack data** action. A local
operator can select a destination and scope; local clearing works offline. A future
Server may publish a signed clear request through Access; receipt delivery/read
state, timeout, dismissal and silence never prove consent or completion.

Requests are hints until the device validates authority and its configured policy.
Default: require local human confirmation of the exact destination/scopes. An
opt-in managed-device policy, if later approved, must enumerate allowable scopes;
pairing alone grants no remote destructive authority. Never erase another profile,
browser origin, application, destination, credential or unrelated OS keychain.

Scopes are independent positive selections, never implicit `all`:

| Proposed scope | Device-owned content | Boundary |
| --- | --- | --- |
| `share-outbox` | Exact destination's held Share bodies and retry payloads | Fence enqueue/flush; ambiguous admissions retain minimal destination/request/digest evidence and are never resent under new keys |
| `share-history` | Locally retained recent/captured-share content for that destination | Server Brain jobs/index and browser history remain independent |
| `ui-layout` | Origin-local Canvas layout/window/focus preferences | No Server mutation or credentials; exact maintained key allow-list below |
| `ui-drafts` | Explicitly enumerated local unsent draft stores | No broad localStorage/sessionStorage sweep; current draft editors mostly hold memory-only state |
| `connection` | Exact destination's device credential/connection material | Disconnect/revoke is separate server work. Keep a bounded receipt capability until acknowledgement; local forget may be offline and must say revocation unconfirmed |

The independent Client host's installation/releases/service/login/configuration,
native credentials, pending installation/open/refresh intents and platform state
are **not** covered by Canvas or Chrome/Android scopes. Their maintenance needs a
separate Client-owner contract. This proposal does not create it.

## Request and receipt (proposed wire version 1)

Future Access transport uses exact HTTPS origin, verified tailnet peer, existing
audience/operation restrictions and `X-Stack-Server-ID`. No executable callback,
URL-to-follow, pathname or arbitrary key list is accepted.

Request fields:

- `version: 1`, unique `requestId`, `serverId`, `dataGeneration`, exact `deviceId`,
  canonical destination `{deviceOrigin,serverId}`, exact client/profile namespace.
- Positive `scopes`, `expectedDeviceGeneration`, `issuedAt`, `expiresAt`, nonce,
  human-readable bounded reason, signing-key ID and Ed25519 signature.
- Canonical signed bytes cover **all** fields, including destination, device,
  generations, scopes and expiry. Verification uses a key pinned during trusted
  enrollment/rotation, never a key supplied by the request. This signing identity /
  key-rotation protocol is a prerequisite, not an existing Access capability.

Device receipt fields:

- Request ID and canonical request digest; pinned old Server/destination/device IDs;
  before/after device generations; exact scope outcomes and bounded removed counts.
- State `refused`, `blocked`, `completed`, `partial` or `unknown`, timestamps and
  content-safe detail codes. No bodies, URLs, tokens, cookie values or raw paths.
- Authentication under the exact device's Access principal or a pre-issued scoped
  one-use receipt capability, bound to the old destination/request digest. A client
  ID in JSON is not authentication. Old credential deletion must not remove the
  only means of reporting completion.

Future routes/Package API names and capability scopes remain a review decision;
no active API advertises the above today. Requests must be delivered only to their
exact admitted device. Per-device status remains offline/pending until that exact
authenticated device receipt arrives. Aggregate completion never hides a missing,
refused, partial or unknown device result.

## Execution, generation and replay

1. Validate pinned identity/signature, exact destination/device/profile, expiry,
   scope policy and expected device generation. Identity mismatch, new enrollment
   or redirected origin refuses; never retarget an old Share outbox.
2. Obtain explicit local consent; preview held/in-flight shares and independent
   copies. Fence producers, capture admissions, drain owned deliveries and persist
   request digest plus a device clearing fence **before** deletion.
3. Remove only selected payloads. Preserve unresolved admission/recovery evidence,
   minimal permanent request/digest/generation tombstones and the receipt outbox.
   Physical SQLite/WAL/free-page/media/back-up erasure is not implied.
4. Commit generation advancement and truthful receipt atomically where possible.
   Interrupted non-atomic deletion becomes partial/unknown; keep the fence for
   local inspection. Never automatically re-execute after app/process restart.
5. Return identical receipts for identical IDs/digests. Changed payload conflicts;
   stale generations refuse. Receipt delivery retries are observation/transport
   only, not another clear. Producer admission must not resume into an old generation.
6. Store/send the receipt to the pinned old destination, then retire its temporary
   reporting capability only after acknowledgement. A Server identity reset may
   make delivery impossible: retain a local exportable content-safe receipt and
   report server acknowledgement unavailable, never claim acknowledged completion.

Unknown in-flight shares may already be admitted by Brain. Payload retirement is
not job cancellation, index deletion or permission to submit the content again.

## Current Canvas key inventory for a local-only follow-up

The future local action must show its exact origin and maintained allow-list.
Clear only existing keys selected by scope, across other tabs under a shared
generation fence so stale tabs cannot immediately rewrite them.

- Layout/preferences: `stack.uix.bench.v1`; `stack.uix.bench.v2.<space>` for
  `hud`, `fleet`, `accounts`, `lab`, `system`, `roles`, `inbox`, `signal`, `content`,
  `workers`, `scrape`, `browse`, `brain`, `proc`; `stack.uix.docks.v1`,
  `stack.uix.inspector.v1`, `stack.uix.chats.v1`, `stack.uix.workers.v1`,
  `stack.uix.proc.v1`, `stack.uix.browse-viewers.v1`, `stack.uix.roles.v1`,
  `stack.ui.hud.v1`, `stack.uix.signal.author.v1`.
- Recovery: `stack.state-flow.<key>` in localStorage and
  `stack.uix.browse.intent.<handoffId>` in sessionStorage. **Refuse clearing while
  any selected recovery record is pending, unknown, malformed or under human
  control.** Only an exact reconciled terminal receipt allows retiring that
  record. Preserve it if the owner is offline/unavailable. These are not ordinary
  drafts, and a prefix is not authorization for a storage-wide sweep.
- No durable generic editor-draft key is currently verified; enumerate new stores
  when implemented. Do not promise to clear a hypothetical persisted draft.

Evidence: `packages/ui/components/canvas/bench.tsx`, `dock.tsx`, `role-actions.tsx`,
`signal-windows.tsx`, `lib/stack/{chat-windows,worker-windows,proc-windows,browse-viewers,hud-view,browse,state}.ts`.
No UI action was added by this backend change.

## Current device stores (not new deletion capabilities)

- Chrome trusted extension storage: `stack.connection.v1`,
  `stack.chrome.share.config.v1`, `stack.chrome.share.outbox.v1`,
  `stack.chrome.share.history.v1`, `stack.chrome.share.history-removed.v1`.
  History-removal markers suppress racing writes and must not be discarded as
  ordinary bodies; generation migration/replay fences must replace their role.
  Connection credentials never cross an untrusted WebView/content script.
- Android app-private `stack.app.share.outbox.v1.json`,
  `stack.app.share.recent-links.v1.json`, encrypted preferences
  `stack.app.connection.v1`, and exact app-owned `stack.app.share.master.v1`
  Keystore material. Unknown/unreadable stores block automatic clearing. Do not
  delete a shared master key if any retained connection/receipt still depends on it.
- Device storage may hold entries for several old destinations. Preview and clear
  only the selected one; an unconfigured entry requires a separate explicit local
  selection. Server instructions cannot convert it to the current destination.

## Acceptance before future implementation

Verify destination/signature/scope/generation mismatch refusals, confirmation,
offline local clearing, in-flight/unknown admission preservation, exact sibling /
credential retention, identical receipt replay, crash recovery, pending receipt
delivery after credential retirement, cross-tab/process producer fencing and
truthful per-device aggregate status. Use fake destinations and disposable stores;
real device access needs a separate explicit grant. No emulator/VM is implied.
