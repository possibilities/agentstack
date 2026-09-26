# Context

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the names. `mcp` exposes operations over loopback HTTP through the running socket Package APIs and, under the owner, offers generated agent-facing event tools. `websocket` exposes operations and event subscriptions over a shared loopback listener, forwarding to those same socket Package APIs.

_Avoid_: protocol, binding

## Event

A named change notice a Package API publishes on an event-capable transport. Topics and descriptions are declared in TypeScript on the PackageApi (`events`); the socket transport delivers them to connections that call `events/subscribe`. A Package API can require a subscription scope (such as a bot ID), which filters notices without adding data to them. A notice carries only the topic name — never a payload or credentials — so callers snapshot state after (re)subscribing. The owner-managed MCP event tools turn notices into fresh read-only operation values for subscribed Bot threads.

_Avoid_: stream, feed, pubsub

## MCP event subscription

A durable, revisionless request by a verified Bot thread to watch one Package API topic and re-read one read-only operation after each invalidation. The owner records the request, reconnects and resnapshots after interruptions, coalesces unchanged values, and starts a Codex turn on that same sanctioned thread for a changed value. The initial value is returned to the subscribing tool call; event notices themselves carry no values.

## Codex account

An AgentStack-owned Codex sign-in credential with an immutable account ID managed by the `auth` Package API for Bots. It is independent of any Codex Worker account, even if both sign-ins use the same native ChatGPT identity; both inventories may automatically correlate matching identities in optional `linkedAccounts` metadata. Accounts can be enabled or disabled; `bot_start` requires an explicit enabled Bot account ID. An existing Bot changes account only through assignment, then the next start after a stop. A running Bot reports both its assignment and its launched identity. Removing either its assigned or launched Bot account deletes that Bot; removing a Worker account does not. Accounts never take a durable human-facing ordinal. A UI may present dense `codex-N` labels derived from the Bot account list. _Avoid_: active account, Codex home, capability profile

## Worker account

A stable account ID for an isolated, native ACP sign-in managed through `auth`. Codex, Grok and Devin appear in `worker_account_list`, with independent enablement and removal operations. A Codex Worker account uses its own OpenCode login; it does not require, share credentials with, or control a Codex Bot account. Older Worker profiles that share a UUID with a Bot account remain independent. Only a ready, enabled Worker account may have an owner-managed ACP process. _Avoid_: active worker account, credential copy

## ACP runtime

An owner-supervised stdio ACP process for one ready Worker account: OpenCode for Grok or Codex, Devin CLI for Devin. Its pipe is private to AgentStack and is not itself a Package API Transport. The `workers` Package API reports health and account-bound capabilities.

## Worker catalog

A no-turn observation of model and dependent effort choices actually offered by one account's ACP session, with native Devin model IDs as separately labelled evidence. Cached values retain source, observation time and stale/error state; they do not by themselves prove successful inference or spendable quota.

## Usage observation

A read-only, scope-and-account-ID-bound measurement of provider quota or billing, collected by the owner-managed `usage` Package API. Bot Codex and Worker Codex observations read their own credentials. Optional links correlate accounts by native identity without exposing it or making their lifecycles interdependent. It retains the last good value with an explicit observation time, freshness and sanitized failure code. It is evidence for a human or agent, not an eligibility verdict or a balancing recommendation; Grok Bot is the machine's separate CLI login rather than a Worker account.

_Avoid_: account score, capacity decision, balance action

## Resource observation

A cached, timestamped census of the owner's observed process ancestry with OS CPU and memory measurements, domain attribution, availability and sampling limits. The owner Package API exposes process self/subtree and overlapping component, Bot, account and ACP-runtime rollups plus bounded recent history. Shared process costs are not allocated to Worker sessions, chats or turns; these observations are independent of provider quota and billing Usage observations.

_Avoid_: per-chat cost, unique RAM, complete accounting

## Worker

An AgentStack-owned ACP session started by a Bot (or the local operator) under one enabled Worker account in an owned Git worktree. It retains its account, model/effort, Role revision, transcript and origin across turns. Closing a Worker retains the worktree and branch for review. _Avoid_: Bot, active account, disposable prompt

## Worker turn

One `session/prompt` request on an existing Worker. Admission returns durable Worker and turn IDs before completion; status and transcript reads establish the outcome. A lost response is `unknown`, never a reason to resubmit the turn automatically. A subsequent turn can request corrections in the same ACP session after it is idle or explicitly loaded for recovery.

## Worker MCP invocation context

Transport-supplied Worker ID and exact ACP runtime instance from a private signed MCP URL. The owner checks both against the durable Worker and live account process before admitting tools; the URL exposes read-only Package API operations and cannot subscribe a Bot thread. It is a same-user correlation and stale-runtime fence, not an OS sandbox. _Avoid_: Bot identity, operator authority

## Main thread

The single Codex thread ID retained by a Bot. A fresh Bot has no main thread until the first persistent root thread created by a connected UI has a durable turn; later Bot launches resume that ID. Only this root and its descendants belong to AgentStack's view of the Bot. Other Codex top-level threads on the same socket are ignored.

## Chat

A Codex app-server thread in an AgentStack-owned Bot's sanctioned main-thread lineage. Historical search and raw records belong to the Bot's history, while live turns, items and interactions come from its owned app-server. Other top-level threads and ACP Worker sessions are not chats. _Avoid_: session, Worker thread

## Bot subagent

A Codex child thread whose parent chain reaches a Bot's sanctioned main thread. Subagents can themselves have children; a thread's identity and parentage do not establish that it is currently loaded or working. ACP task or child-session evidence belongs to its Worker and is not a Bot subagent. _Avoid_: Worker, arbitrary thread on the Bot socket

## Bot

A Codex app-server process with, after its first turn, a durable main thread. By default it is numbered `bot-N` with a private workspace and copies the current Bot defaults: Sol at medium reasoning effort, unrestricted sandbox, and no approval prompts. The Bots Package API can change defaults for future Bots; `bot_start` requires an explicit enabled Codex account and can override a Bot's ID, working directory, saved settings, and launch arguments. Legacy unbound Bots require assignment before a turn. Bots restart on AgentStack startup with their saved account and settings and resume their main thread when one exists.

## Role

The single AgentStack-owned configuration shared by every new Bot launch: ordered developer-instruction fragments, enabled skills, internal owner MCP connections, and additional enabled MCP servers. Each Bot receives a private launch snapshot through codexnk's required `--capabilities` directory. Edits affect later launches, not a running process. _Avoid_: capability profile, system-prompt flag, live prompt file

## Trusted project

An explicit, revisioned Role entry for a canonical project root. Only a Bot launched inside an enabled root receives its `[projects]` trust decision in the private runtime config. That permits the selected project's Codex config, including project MCP servers; it does not import the operator's home configuration.

## Category

An ordered group of instruction fragments in the Role. Its title and description help humans manage content but do not render into the prompt. Disabling it suppresses all its fragments.

## Fragment

A durable, ordered developer-instruction body with a stable ID and human-only title and description. Only enabled fragments in enabled categories enter `SYSTEM_APPEND.md`.

## Role skill

A named, enabled or disabled skill record containing Markdown instructions and optional supporting files. AgentStack stores the bytes in the Role and writes only enabled skills to a Bot's private launch snapshot. Codex also discovers project skills, while the three-axis launch excludes home-level skills. Role skill selection does not suppress project, bundled, or explicitly added skill roots.

## Role MCP server

An additional named, enabled or disabled HTTP or stdio MCP definition in the Role. Enabled definitions join the owner's internal Package API connections only in the Bot's private launch configuration. They do not change ambient Codex configuration or running Bots.

## MCP invocation context

Transport-supplied information about one Package API operation invoked through MCP. A private per-launch URL proves a live Bot ID and instance; Codex supplies a thread ID in the tool call's `_meta`. Package API handlers can read that context as an optional third argument without changing their public input schema. The thread ID is a claim until checked against the Bot's sanctioned main-thread lineage.

## Voice call

One ephemeral, full-duplex WebRTC audio session into a running Bot's existing main thread. The Bots Package API relays an SDP offer and answer, tracks the exact call ID, and stops only native realtime on hang-up; it never creates a thread or ends a turn. The browser owns microphone capture and speaker playback. A caller can submit speakable text only on the exact connected call; native acknowledgement does not establish audible or verbatim delivery.

_Avoid_: voice agent, voice thread

## Vault

The `wiki` Package API's directory of plain-text documents. Files are authoritative; its SQLite Index is derived and reconciles on reads. This vault is under AgentStack state, separate from the original agentwiki vault. _Avoid_: notebook, workspace

## Artifact

A named static file or directory held by `wiki` with an immutable content-hash Version and a mutable latest pointer. Its manifest and bytes live in AgentStack state, and a stub Document in the Vault makes it searchable and linkable. _Avoid_: attachment, upload

## Artifact origin

The second loopback HTTP origin owned by the `wiki` Package API. It serves only static Artifact bytes and has no access to the document origin; the separate origin and CSP isolate Artifact scripts from the Vault. _Avoid_: sandbox

## Canvas space

A named physical region of related windows on UIX's shared open bench, addressed as `/x/<space>`. Fleet is the initial space; spaces have independent local window arrangements and deterministic centered bench positions. Navigating to a space moves the shared camera. System and API reference are global docks rather than spaces.

_Avoid_: page, tab, workspace (a Bot's working directory)

## Open bench

UIX's continuous canvas containing all Canvas spaces under one camera. Record relationships do not determine space placement. System, API reference and record inspection are global tools attached to the viewport; their destinations need not name a canvas card.

_Avoid_: independent canvases, space tabs

## Brain

The `brain` Package API's isolated research index and durable ingestion system. Its database, research artifacts and device-share credentials live under AgentStack state. It collects material for retrieval; the Wiki Vault holds authored documents.

_Avoid_: external research service, Wiki Vault

## Admission

The synchronous boundary that validates ingestion intent and durably creates or identifies an ingestion job. Accepted admission proves that the job exists, not that extraction or indexing has completed.

_Avoid_: indexing completion, successful extraction

## Ingestion job

One durable intent to ingest or reconcile an item in Brain. Execution appends attempts; retry does not replace the job or erase prior outcomes. Expiring claims fence late completion.

_Avoid_: Worker turn, task, source

## Ingestion worker

Brain's owned execution loop that leases ingestion jobs, delegates URL extraction to Agentscrape, and commits fenced outcomes. It is distinct from an account-bound ACP Worker.

_Avoid_: Worker, Bot, source

## Research resource

One logical collected item with a stable identity independent of its locator, captured bytes or current searchable representation. Conservative aliases and provider identities support reconciliation without equating all matching content.

_Avoid_: artifact digest, document ID

## Research document

The current searchable representation of a Research resource in Brain's SQLite index. It is not a plain-text document in the Wiki Vault.

_Avoid_: Vault document, research artifact

## Research artifact

Immutable captured or derived bytes in Brain's content-addressed store, referenced by typed SQLite records. A content digest identifies bytes, not a Research resource; this is separate from a named, published Wiki Artifact.

_Avoid_: Wiki Artifact, resource identity

## Research source

A versioned recurring producer or discovery definition, such as a feed or account timeline. Synchronization creates a durable run grouping observations and child jobs; cadence and checkpoints are policy and evidence, not an independent scheduling service.

_Avoid_: ingress, individual URL job, attempt

## Share ingress

Brain's authenticated inbound HTTP listener for AgentStack device clients. It resolves each share into the same Admission boundary and owns no separate queue or index. Network reachability alone is not authorization.

_Avoid_: public API, research extractor

## Share outbox

A device client's bounded durable hold of intent the Share ingress has not acknowledged. It retries delivery using the original destination identity; a held entry is not an ingestion job or proof of saving.

_Avoid_: ingestion queue, saved item

## Share history

A client's bounded record of shares and their last observed outcomes. It echoes server admission and job state rather than deciding whether indexing succeeded; unlike the Share outbox, it does not hold delivery intent.

_Avoid_: ingestion ledger, queue
