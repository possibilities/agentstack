# Agent trees and conversation observations

The `bots` and `workers` Package APIs provide the read models for a UI of delegated work. Discover their current schemas and transport addresses through `api.docs_snapshot`. The same typed operations are available on the declared socket, MCP, and WebSocket transports.

## Identity and ownership

- A Bot owns exactly its `mainThreadId` and threads with a proven parent chain to that root. Use `(botId, threadId)` as a Chat key. Other top-level Codex threads on the same app-server are outside the Bot's tree.
- A Worker is a separate ACP or Claude SDK conversation keyed by its durable Worker `id`. Its `botId` and originating `threadId` place it under the Chat that dispatched it. A local-operator Worker has no Bot-tree parent. Keep `sessionId` as native provider correlation, not as an AgentStack Worker ID. This field replaces the earlier ACP-only `acpSessionId`; existing saved ACP sessions retain their identity.
- A provider's task tool or child-session reference is evidence within a Worker conversation. It is not another managed Worker and does not imply that the backend exposes the child's full conversation or nested descendants.

## Bot subagent reads

| Operation | Use |
| --- | --- |
| `chat_tree({botId, limit?, offset?, maxThreads?, snapshot?})` | Flat, parent-linked rows ordered by depth and thread ID, ready to render as a nested tree. Includes historical, archived, unloaded, and live-before-rollout descendants. |
| `chat_tree_detail({botId, threadId, offset?, length?, revision?})` | Chunked JSON evidence for the selected thread: normalized row, raw native metadata, session metadata, initial context, starting input, spawn event, and exact spawn arguments when available. |

Tree rows include runtime status/active flags, model/effort/provider, configuration provenance, nickname/role/path, title/preview, working directory, timestamps, session and fork identities, and archive/project metadata. Model and effort describe configuration, not proof of which model executed every turn. Stopped rows have `status.type: "unknown"` and `loaded: null`.

For the first tree page, start at offset zero. Continue with `nextOffset` and the same returned `snapshot`; if it changed, restart paging rather than combine different trees. `limit` is at most 100 and rows have a 250 KB aggregate budget. Native discovery is bounded per archived, unarchived, and loaded sweep by `maxThreads` (default 2,000; maximum 10,000). Inspect `coverage`, including limit/read failures. Private history is scanned independently; an incomplete scan can omit nodes whose lineage cannot be proved.

Detail chunks count UTF-16 code units, default to 32,768, and allow at most 65,536. Concatenate `text` until `nextOffset` is null, carrying the first `revision` into subsequent calls, then parse the JSON document. Its evidence fields retain source, thread ID, rollout line or native item ID, and original value. `spawnArguments.value.arguments` retains the original correlated `spawn_agent` argument string. Full prompts stay out of tree rows.

Starting input skips inherited subagent history when the rollout's ordinal boundary is known. Native detail fallback examines at most 1,000 items per relevant thread. Missing spawn arguments and unresolved inherited-history prefixes are explicitly reported. For reverted/duplicate historical rollouts, latest modification time is a best-effort choice rather than Codex's authoritative current-history pointer; raw evidence is labelled accordingly.

## Worker conversation reads

| Operation | Use |
| --- | --- |
| `worker_list` / `worker_status({id})` | Inventory, origin, account/worktree, current phase, latest turn, and exact pending permissions. |
| `worker_detail({id})` | Latest retained session/runtime observations, capabilities, safe launch arguments, observed settings, freshness, capture statistics, and subagent visibility limits. |
| `worker_turn_list({id, afterId?, limit?})` | Admission-order turn history with submitted prompts, requested model/effort, separately observed settings, and dispatch evidence. |
| `worker_record_list({id, afterSeq?, limit?, turnId?})` | Immutable structured observations: content blocks, tool updates, plans, configuration/mode, session info, commands, usage, and vendor metadata. |
| `worker_record_read({id, seq, offset?, limit?})` | Complete retained JSON for an oversized record, in UTF-16 chunks of at most 16,000 code units. |
| `worker_tool_list({id, afterSeq?, limit?})` | Latest merged tool calls plus evidence-backed OpenCode task references. |

`worker_turn_list` retains the submitted task even if preparation fails. The submitted prompt is distinct from the actual dispatch prompt: `dispatchedPromptSeq` references a structured `session/prompt` record, including Role text when the runtime receives it inline. Null admission fields on older turns mean that those values were not retained. Private MCP connection arguments are excluded from runtime/session observations.

Status and lifecycle responses return a compact turn summary with `promptChars`, not the prompt body. This keeps outcome and permission wakeups readable even for long assignments; hydrate full prompts through turn history. Structured retention and the existing per-turn text transcript budget are independent, so reaching the structured cap does not disable later `worker_read` text capture.

Structured records preserve content parts and tool IDs, raw input/output, locations, status, and provider metadata. Partial tool updates replace supplied fields and retain omitted fields; a completion without a title still updates the same tool. Page tool projections from the beginning after invalidation, because a previously listed tool may have changed. Immutable record sequences can be continued incrementally. Do not mix `worker_read` text sequence cursors with structured record cursors or tool first-observation cursors.

ACP supplies no native turn IDs. Live records are associated with the active admission window where possible; known late tool updates retain their original observed turn. Session observations outside a turn and `session/load` replay have no fabricated turn ID. `source: "replay"` identifies repeated provider history, not newly executed work.

Structured capture retains up to 20,000 records and 32,000,000 JSON UTF-16 characters per Worker. The API reports dropped-record counts and marks projections stale after loss. Inline record data is limited to 8,000 characters; larger records retain an immutable chunk-readable body. Record, tool, and turn pages are byte-bounded around 200 KB, with a single admitted turn allowed to exceed that page target. Raw reasoning is excluded.

OpenCode's ACP adapter exposes task arguments and output metadata containing session/model references, but does not enumerate a verified nested tree or forward complete child transcripts. A task can reuse an existing session, so its caller is not necessarily the session's original parent. Projected references therefore report `hierarchyVerified: false` and `childStatus: "unknown"`; `toolStatus` is the task tool's status. Devin currently has no supported child projection; available vendor metadata remains inspectable in structured records. Neither an empty task list nor successful tool completion proves that all child work has finished.

## Subscribe, snapshot, reconcile

Events contain only a topic name. Subscribe before taking the initial snapshot, re-read after notices, and snapshot again after reconnecting. A notice may coalesce several changes. Never append event notices to a transcript or interpret notice arrival as proof that a particular agent worked or completed.

Use Bot-scoped `chats_changed` for tree/history invalidation and `bots_changed` for process/root changes. An unrelated native thread may cause an invalidation; the subsequent sanctioned read establishes what actually changed. Live status belongs to the current verified runtime. A historical model or status observation must not be presented as a current runtime verdict.

Worker lifecycle attention remains on Worker-scoped `worker_changed` with `worker_status`. This is also the only Worker topic/read pairing accepted for originating-Bot MCP wakeups. UI progress subscriptions use socket or WebSocket invalidations and do not create inference turns. A Bot's MCP event tool refuses self-scoped or unscoped `threads_changed`/`chats_changed` subscriptions to avoid a turn feedback loop; that restriction does not apply to ordinary UI subscriptions.

For a Worker detail view, subscribe to both `worker_progress` and `worker_changed` with the Worker ID as scope. Snapshot `worker_detail`, `worker_status`, and the relevant pages after subscription/reconnection; re-read on notices. `worker_progress` is coalesced and covers structured conversation/session observations; `worker_changed` covers admission, completion, permissions, and recovery. Global `workers_changed` continues to refresh inventory consumers.

For example, on the discovered `bots` WebSocket:

```json
{"id":1,"method":"events/subscribe","params":{"topics":["bots_changed","chats_changed"],"scope":"bot-1"}}
{"id":2,"method":"tools/call","params":{"name":"chat_tree","arguments":{"botId":"bot-1","limit":50}}}
```

After the subscription acknowledgement, process the snapshot response and render children by `parentThreadId`. Join Workers from `worker_list` by the same Bot/thread pair; keep operator-origin Workers separate. On the discovered `workers` WebSocket, a selected Worker uses:

```json
{"id":1,"method":"events/subscribe","params":{"topics":["worker_progress","worker_changed"],"scope":"00000000-0000-4000-8000-000000000001"}}
{"id":2,"method":"tools/call","params":{"name":"worker_detail","arguments":{"id":"00000000-0000-4000-8000-000000000001"}}}
```

The UUID is illustrative; use a real Worker ID from inventory. These are Package API transport requests, not native Codex, ACP or Claude SDK requests.

## Detail and completeness

Page lists and transcripts; hydrate prompts and native detail only for the selected entity. Respect returned continuation positions and explicit omitted/truncated markers. A missing field means unobserved or unavailable, not a default model, zero cost, no children, or successful completion. Preserve provider-specific structured evidence alongside normalized labels rather than deriving parent relationships from display titles.

Bot raw rollout reads (`chat_records`, `chat_record_chunk`) remain available while stopped. Running native conversation reads (`chat_thread_read`, `chat_turns`, `chat_items`) retain Codex's shape. See [Bot chat API](chats.md) for transcript and main-thread interaction details, and [Operations](operations.md) for Worker admission, permissions, recovery, and account lifecycle.
