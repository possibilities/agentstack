# 117. Rename the project identity to Stack

Status: accepted, 2026-09-28.

The project and GitHub repository are `stack`. The checkout and command are
`~/code/stack` and `stack`; workspace packages use `@stack/*`. Configuration
uses `STACK_*`, with default state at `~/.local/state/stack`. The browser
provider, HTTP identifiers, local storage, Chrome extension, and Android
application use Stack identity as well. This is an intentional identity break,
not a second product or a compatibility alias.

Preserve existing state rather than silently initializing a new store. Existing
browser controllers and Hypeman installations may contain absolute paths and
external resource names; those are historical runtime records, not a license
to rewrite opaque databases or rename live external resources. An old-path
filesystem alias may be retained during the local migration while those
resources drain. Fresh processes and integrations must use the new identity.

Earlier ADRs remain historical accounts of their accepted contracts; references
to the product in current operational instructions use Stack. This decision
extends [ADR 0115](0115-serve-and-ui-names.md) and does not supersede its
separation of the `serve` package from the `ui` package.
