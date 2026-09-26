# 75. Interpret newly observed conversation text with a headless attention service

Status: accepted, 2026-09-26. Extends [ADR 0052](0052-private-experimental-inference.md),
[ADR 0055](0055-agent-tree-observability.md) and [ADR 0074](0074-lab-inference-over-websocket.md).

## Decision

The owner starts `attention` as a Package API child and drains it before `infer`
and its conversation sources. Socket and loopback WebSocket operations expose
configuration, lifecycle, semantic items, source messages, traces, feedback and
explicit evaluation replay. No attention UI or MCP spending surface is added.
Interpretations are observations, not instructions to execute actions or native
permission grants.

The revisioned inference defaults are `model: gpt-5.6-luna` (the live catalog's Luna),
`reasoningEffort: low`, and `accountId: null`. A null assignment tries enabled,
non-removing Codex Bot accounts in `account_list` order. Fallthrough is permitted
only after a definite refusal; an assigned account never silently substitutes
another. Every attempted account, model and effort is recorded. Discovery uses
`infer_models` so future controls can offer the actual account-bound choices.

First enable establishes durable source cursors, without classifying existing
messages. Forward means **newly appearing data**, not a minimum authored date:
newly imported old conversations and appended old-dated records are eligible.
Restart and pause preserve cursors and catch up. Bot reads admit only sanctioned
main-thread lineage and exclude inherited child history. Prefix-fenced rollout
cursors detect rewritten/replaced sources. Worker user/assistant text is retained
independently of tool/diagnostic budgets and contiguous chunks become explicitly
identified text units. Draft revisions can be superseded before inference.
Worker native child transcripts remain outside the coverage already exposed by
Workers; synthetic user-role prompts retain their agent origin.

Each message may contain multiple semantic items: acts, forms, scope, audience,
engagement, attention reason (including awareness without a requested response),
timing, conditions, uncertainty, evidence spans, relations and state transitions.
The LLM supplies semantic interpretation; deterministic validation verifies exact
quotes and known relationship targets. Responses do not automatically resolve
requests. Derived current state is distinct from historical model output.

## Inference and empirical improvement

`infer` retains durable dispatch records keyed by an optional caller request ID.
An identical completed invocation returns its result without another dispatch;
interrupted dispatch remains unknown. It captures exact input/request bodies,
text deltas, terminal metadata, reported model, usage and classified failures,
excluding authentication and raw reasoning. Bounded capacities become 32,000
instruction characters, 128,000 input characters and an 8,192-token post-response
threshold. Live verification established that this backend rejects
`max_output_tokens`; it is not sent. The threshold is checked against returned
usage when available and cannot cap provider generation or spend. HTTP rejection
bodies are bounded, credential-scrubbed trace evidence. Catalog
verification remains fresh per request; no Platform fallback is introduced.

Attention stores full source revisions, bounded context snapshots, prompts,
version identifiers, attempts, completions (including invalid JSON), semantic
outputs and state transitions under `<state>/attention`. Oversized values have
chunked reads. No successful/failed attempt is replaced by evaluation. Replay
uses the original frozen input/context with current model/effort and prompt,
keeps feedback separate from predictions, and never changes live attention.
Exports fence chunk reads by content revision. Feedback is attributed evidence,
not automatic ground truth or implicit model training.

## Consequences

Activation and account use are explicit API operations. Collection polls durable
sources independently of inference, so model latency does not prevent admission.
Processing is serial initially; backlog and source errors are visible. Definite
pre-dispatch refusals back off with separately traced attempts. Unknown provider
outcomes require explicit replay rather than silent duplicate spending.

Source text, traces and feedback are local durable records with no automatic
retention deletion. Initial context is bounded, and unknown lineage, missing
history or uncertain message boundaries are reported rather than invented.
The headless API is the delivery surface. Dedicated attention/default-choice UI
is deferred at the human's request.
