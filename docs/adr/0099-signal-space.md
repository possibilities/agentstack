# 99. A Signal space for conversation attention

Status: accepted, 2026-09-28. Adds a seventh Canvas space to the open bench of
[ADR 0058](0058-open-bench-and-global-tools.md) and gives the headless `signal`
Package API ([ADR 0075](0075-headless-conversation-attention.md),
[ADR 0094](0094-package-addresses-signal-browse-worker.md)) its first UI. It
supersedes ADR 0075's deferral of dedicated attention and default-choice UI;
the rest of ADR 0075 stands.

## Decision

**Signal** (`/x/signal`, key 7) shows what conversations ask of the human and
lets them judge whether that interpretation can be trusted. Its windows run in
the order they are used:

- **Signal** (`signal`): the processing switch, health (baselines, last scan,
  last interpretation, unreadable sources), the job backlog by state, and the
  revisioned inference defaults. Enabling asks first, because it starts spending
  Codex allowance; the first enable says existing messages are not interpreted.
  Model and effort choices come from `attention_models` for the effective
  account, or infer's cached catalog for another chosen account; saves send
  `expectedRevision` and a conflict reloads the latest defaults.
- **Attention** (`attention`): current items that ask something (review,
  response or action), sorted by urgency, then a stated deadline, then newest,
  filtered by state, audience (default: human) and Bot. Awareness and other
  quiet items sit in a collapsed "For your information" section. Inferred
  interpretations render muted so a guess never reads like an explicit ask.
  **Nothing here marks an item done**: state follows the conversation, so the
  resolving control is *Open chat*, shown only for a Bot's sanctioned main
  thread. *Feedback* records attributed evidence and says it resolves nothing.
- **Messages** (`attention-messages`): captured revisions, newest first, with
  provisional and superseded revisions marked.
- **Runs** (`attention-runs`): every attempt, newest first. Expanding one shows
  its trace (interpretation, target, context, prompt, raw completion, the
  correlated `infer` request, events and feedback). A replay shows a *Compare*
  tab that pairs original and replay items by exact evidence. An unknown
  outcome carries "Needs decision: replay?" until a replay of it exists.
  *Replay* confirms, names the current model and effort and that it spends
  allowance (or waits while processing is paused), and a retry reuses its
  request ID.
- **Changes** (`attention-changes`): the durable change log, hiding source-read
  polling by default.

`signal`, `attention-item`, `attention-message` and `attention-run` are new node
kinds whose destinations are these windows. A message or run inspection reads
its immutable record by ID, so it resolves even before any list has loaded it:
a message shows its full text with each item's evidence highlighted, its items,
runs and feedback; a run shows its trace. Item links resolve from records the
views have read. The space flags a closed channel, an unreadable source and a
failed last interpretation; a deliberate pause is not flagged.

## API changes

- `attention_status.changeSeq` is the newest event that can change attention
  records, excluding `source_read`/`source_read_failed`. Signal publishes
  `signal_changed` after every source scan (about once a second while enabled),
  so clients re-read status on each notice and list views only when
  `changeSeq` moves. The UI keeps these notices out of the activity log.
- The list operations accept `order: "desc"` with `before` for newest-first
  paging. `attention_list` also filters by `botId`, `messageId` and several
  `states`; `attention_message_list` by `botId`; `attention_run_list` by
  `messageId`; `attention_changes` by `kinds` or `excludeKinds`.
- Run entries name their `messageId`, whether they are a `replay`, the run they
  replayed (`replayOf`) and the `promptVersion`.
- `attention_feedback_list` pages recorded feedback, optionally for one message
  or run.
- The WebSocket forwarding timeout for `attention_models` is keyed under the
  `signal` address; ADR 0094 left it under the retired `attention` name.

## Consequences

Nothing in the space executes a request an item describes. Answering remains a
conversation act, feedback remains evidence, and replay remains evaluation. Its
two spending controls, enabling and replay, both confirm first. Items for other
audiences and Worker transcripts stay visible through the filters but have no
chat destination.
