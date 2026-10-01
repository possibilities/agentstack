# 0157 — Device-local clear requests and receipts

## Status

Proposed for review. The human approved a contract draft (07·D2), not runtime, UI,
Access routes/signing identities or full-installation reset semantics.

## Direction

Clients own exact destination-scoped local clearing. A future Server may publish
signed destination/device/generation-bound clear requests through Access. Pairing
is not deletion consent; require local confirmation unless a separately approved
managed policy enumerates the scope. Native credentials remain outside WebViews.

Preserve unresolved Share admissions, maintenance/handoff recovery, permanent
request/digest/generation tombstones and receipt-delivery authority. Admit before
deletion, fence producers, report partial/unknown honestly and never replay on
restart. Only an authenticated exact-device receipt can establish that device's
reported completion; offline or silent devices remain pending/unobservable.

The [proposed contract](../device-state-clear-contract.md) inventories current
Canvas keys and Chrome/Android stores, defines scopes, signature/trust prerequisites,
receipt and credential-retirement sequencing, and names acceptance checks. The
independent Client host's installation, service, configuration and connections
remain a separate owner, not implicitly added to these scopes.

## Not delivered

No device clear control, signing-key enrollment, Access clear-request/receipt
transport, client generation migration or server-side device deletion is supplied.
No server factory reset is authorized by this ADR. External backups, other apps,
Server data and personal browser history remain independent copies.
