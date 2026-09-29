# HUD Package API

Durable, shared work for Stack humans and Bots. The API lives in [`api.ts`](api.ts),
transport selections in [`api.yaml`](api.yaml), and design decisions in
[ADR 0132](../../docs/adr/0132-native-hud-work-collaboration.md).
State is `<STACK_STATE_DIR>/hud/work.sqlite`; the Server owns its lifecycle.

## Agent workflow

1. Reconcile `work_list` / `work_tree` before creating duplicate work. Use exact
   namespaced correlation when a workflow has a stable external ID.
2. Create the objective with `work_create`, or create its ordered nested breakdown
   atomically with `work_batch`. Use fresh UUIDs for item IDs and request IDs.
3. Set semantic state, `nextAction` and `attention` deliberately. Use links to name
   the accountable lead, contributors, source evidence and outputs.
4. Read `work_focus_get`, then `work_focus_set` with that **focus** revision. Bot
   calls default to their verified Chat; operator calls require an exact target.
5. Start Workers normally. Omit `workItemId` to inherit Chat focus, supply an ID to
   dispatch against a specific child, or supply null to opt out. A follow-up
   continues its previous work unless explicitly changed. Inspect each admitted
   turn's `workContext` rather than guessing from names or worktree paths.
6. Record progress, results, decisions and handoffs with `work_note_add`. Review
   the result and current scope, then update semantic state explicitly. Runtime
   completion does not complete the objective.

Every item edit requires the item's latest `expectedRevision`. Metadata and notes
advance it too. Focus has its own revision. A conflict requires a fresh read and
decision; don't merely increment the number. A lost response is retried with the
**same requestId and input**. A receipt contains resulting revisions; use read
operations for current records, because a duplicate receipt can describe an older
successful mutation.

### Example: atomic breakdown

Call `work_batch` on `hud`:

```json
{
  "requestId": "10000000-0000-4000-8000-000000000001",
  "changes": [
    {
      "action": "create",
      "id": "20000000-0000-4000-8000-000000000001",
      "title": "Ship a collaborative HUD",
      "objective": "Give the human and agents one truthful view of work and deployed resources",
      "state": "active",
      "nextAction": "Implement and verify the native API",
      "links": [{ "relation": "lead", "target": { "kind": "operator" } }]
    },
    {
      "action": "create",
      "id": "20000000-0000-4000-8000-000000000002",
      "parentId": "20000000-0000-4000-8000-000000000001",
      "title": "Implement the API",
      "objective": "Persist work, metadata and exact resource associations",
      "state": "active",
      "order": 10
    }
  ]
}
```

For the calling Bot Chat, select the child with `work_focus_set` after reading its
focus revision (zero if never set):

```json
{
  "requestId": "10000000-0000-4000-8000-000000000002",
  "expectedRevision": 0,
  "workItemId": "20000000-0000-4000-8000-000000000002"
}
```

An independent Worker dispatch against the child can instead supply that ID as
`worker_start.workItemId`, alongside the ordinary account/model/repo/task inputs.

### Metadata and cross-package references

`work_metadata_set` replaces one namespace's JSON object. For example,
`namespace: "implementation"`, `value: {"repository":"stack", "issue":132,
"branch":"hud-api", "reviewed":false}`. Query the exact issue using
`work_list({correlation:{namespace:"implementation",key:"issue",value:132}})`.
Unrelated namespaces survive. Namespace-level null removes the namespace;
null inside its object remains a value. Ordinary reads never return the metadata.

Typed links have `relation`, `target`, and optional `label`. Targets can be the
operator, root-bound Bot, Chat, Worker/turn, Work item, HTTP(S) URL or a Package API
locator such as `{kind:"resource",package:"content",resource:"artifact",
id:"hud-design",version:"<content hash>"}`. Resource names and version meanings
belong to that Package API. Locators do not launch anything or establish authority.

## Client read model

- `work_tree`: flat preorder rows with explicit parent and depth, counts and unmet
  dependencies. The first page returns `snapshot`; send it on later pages and
  restart when it changes. `total` and `nextOffset` distinguish complete from
  partial trees. The tree includes terminal work so ancestry is never fabricated.
- `work_list`: bounded creation-order pages for filtered lists and exact
  correlation. `nextCursor: null` ends pagination. Refresh earlier pages on change.
- `work_get`: public item detail. `work_metadata_get`: explicit coordination detail.
- `work_activity_list`: durable forward cursor with `hasMore`. Result and decision
  notes retain scope revision; update entries include public before/after fields.
- `work_resources`: declared links, bounded Chat focuses, captured Worker-turn
  associations and independent Worker observation availability/visibility.
  Compare association `scopeRevision` with the item's current value. A previous
  turn's terminal phase is history even when the Worker is now running another turn.
- Bot/Chat status, Worker transcript/diff, Content artifacts, account Usage and
  process Resource observations remain their existing owners' reads.

Subscribe **before** reading. `hud_changed` is global; `work_changed` accepts an
item ID scope and also invalidates derived ancestors/dependents. Resnapshot after
reconnecting. Resource views additionally follow `worker/workers_changed` and
the appropriate scoped Bots topics. A missing native source is unavailable, not
zero resources or stopped execution. HUD does not rebroadcast native activity as
semantic changes or automatically wake agents for their own runtime progress.

MCP is for verified Bots; Workers receive no HUD operations by default and retain
self-only Worker context reads. Local WebSocket clients can collaborate on Work.
Access remote clients currently receive selected reads, with mutation policy and
the future HUD Canvas space left to explicit UI integration.
