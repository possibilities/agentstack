# 100. A Content space for the Vault, collections and Artifacts

Status: accepted, 2026-09-28. Adds an eighth Canvas space to the benches of
[ADR 0088](0088-isolated-space-benches.md), following the Roles pattern of
[ADR 0082](0082-roles-space-for-instruction-fragments.md). Gives the `content` Package API of
[ADR 0077](0077-content-collections.md) its first UI and its first event. Leaves the Access
Content handoff of [ADR 0091](0091-shared-access-and-direct-tailnet-ingress.md) unchanged.

## Decision

**Content** (`/x/content`, key 8, a new green `content` accent) is where people read and edit Vault
Documents, organize Content items into collections, and manage published Artifacts. It has five
windows:

- **Documents** (`content-documents`) searches the Vault with `search` and shows its snippets;
  with no query it lists `list`'s newest documents. Tag chips from `tags` narrow either. A row
  opens in the Editor and Preview, copies its `/d/<slug>` path, or is removed with a required
  reason (`rm`). New document drafts a title, tags and body in the Editor before calling `new`.
- **Library** (`content-library`) shows All, Ungrouped and each collection with its item count,
  and a table of items (kind, name, size, revision, updated) paged with `nextOffset`; kind and
  name filter only the loaded page. Dropped or chosen files upload through resumable blob stages
  to `item_put`, one file at a time with visible progress. Dragging an item onto a collection or
  Ungrouped calls `item_move`. Collections are created, retitled and deleted here.
- **Editor** (`content-editor`) is the single editing surface, for Vault documents (`get`, then
  `document_update` fenced by `expectedDigest`) and `document`-kind items (`item_get`, then
  `item_put` with `id` and `expectedRevision`). Typing `[[` offers documents from `resolve`.
- **Preview** (`content-preview`) renders the selection. Markdown becomes React elements (raw
  HTML stays text, wikilinks open the named document, remote images are not loaded), images
  come through `item_get`/`item_read` as blobs, and other files show metadata and a text or hex
  peek of their first bytes. A document lists its outgoing, dangling and incoming links.
- **Artifacts** (`content-artifacts`) lists `artifacts_list`; a row expands to
  `artifacts_versions`, newest first. People copy the immutable citation (`version_url`) or the
  latest path (`url`), and tombstone or restore a name or one version.

`document`, `collection`, `item` and `artifact` are new node kinds with homes in Documents,
Library, Library and Artifacts. Their inspector views show the stored record, re-read after each
invalidation; documents and document items offer "Edit in Content". The palette finds loaded
documents, items and Artifacts, searches the Vault as the query is typed, and offers New
document, New collection and Upload. The space needs attention when its channel is closed or an
upload stalled or failed.

**Drafts follow Roles.** Bodies are page-local drafts per record; rows mark unsaved drafts and
leaving the page with any, or with an upload in flight, asks first. A draft remembers the saved
text it started from. When the saved text changes under an open draft the Editor offers Keep
mine or Use theirs. A save refused by a stale digest or revision re-reads once and retries only
if the body it would overwrite is still the one the draft started from.

**The event.** `content` publishes `content_changed`, an invalidation notice with no payload,
after every successful mutating operation: collection create, update and delete; item put, move
and delete; `document_update`, `new`, `add`, `rm`, `restore`; `artifacts_rm`,
`artifacts_restore`, `artifact_publish` and `gc`. Blob stages are private upload state and
publish nothing. Vault files edited directly are reconciled on the next content operation; when
that operation commits the edit it also publishes the notice, so direct edits are announced when
noticed, not when they happen. The UI re-reads its lists and open records on each notice and after
its own writes, since a lost acknowledgement may still have written. The topic is selected on
the WebSocket and MCP transports ([ADR 0096](0096-explicit-transport-exposure.md)), so Bots can
also watch it.

**Artifact publishing stays agent-only.** The space has no publish control. Agents publish
through `artifact_publish`; people cite, tombstone and restore.

**Remote viewing is not solved here.** The UIX server names Content's loopback origins from its
own environment (`AGENTSTACK_CONTENT_PORT`, `AGENTSTACK_CONTENT_ARTIFACT_PORT` and their older
wiki names, or the configured origins). A page served from a loopback host gets "Open" links to
`/d/`, `/c/` and `/a/` in a new tab. Artifacts never render inside the UIX: the Artifact origin
sends `frame-ancestors 'none'`, and item and Artifact bytes are never interpreted as HTML in the
UIX origin. A page served remotely shows "open locally" instead of a link, because a Content
handoff is minted by Access for a paired device credential and the UIX has no such credential.
Document text, images and file peeks still show everywhere, since they come through the Package
API.

## Consequences

- **Restore needs a name.** No operation lists removed documents or tombstoned Artifacts, and
  none is added. A removal offers Restore as an undo in its confirmation toast, and Documents and
  Artifacts each offer "Restore by name". Garbage-collected Artifact bytes cannot be restored.
- **Item deletion is permanent.** `item_delete` has no tombstone; the confirmation says the
  shared `/c/<id>` link stops working for everyone. Deleting a collection only ungroups its
  items, which keep their IDs and links.
- **Uploads can be ambiguous.** A lost `blob_stage_*` response is resolved with
  `blob_stage_status`, never a guessed offset, and a stall resumes from the server's acknowledged
  bytes under the same `clientKey`. `item_put` is not idempotent, so a lost response after staging
  is reported as possibly stored rather than retried.
- The Library's counts cost one `item_list` read per collection on each invalidation.
- `gc`, `commit`, `doctor`, `reindex`, `path`, `publish` and `artifact_publish` remain API-only.
- Loading the space into a running owner needs a build and an authorized owner restart
  ([ADR 0013](0013-owner-managed-ui-canvas.md)).
