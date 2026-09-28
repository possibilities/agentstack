# Context

## Notification

A durable AgentStack-owned message with a stable ID. It is open or dismissed; dismissal happens once and records its outcome (closed, opened, action, replied or replaced), so answering or clicking through is what acknowledges it. A group replaces the open notification with the same key. Its actions, reply prompt and open URL are data; presentation is separate from storage and nothing executes. _Avoid_: operating-system notification, acknowledgment as a separate state, callback

## Package API

Typed operations a workspace package exports so agentstack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## Access client

A durable phone, extension, browser or future cloud consumer identity owned by the `access` Package API. A tailnet client pairs through an expiring request approved on trusted local control. Its human approval code is distinct from its high-entropy redemption secret. One client may receive Brain and Content scopes. _Avoid_: Brain token, Bot, Worker, Tailscale node identity

## Access grant

An explicit set of scopes or selected operations for one Access client and one network policy. Tailnet device grants and public-cloud grants are distinct; a device credential never authorizes public ingress. Client, grant and individual credential revocation fence dependent short-lived tokens and browser sessions on subsequent requests. Public-cloud credentials and remote MCP admission are not yet implemented. _Avoid_: network reachability, approval code, internal MCP context

## Remote UIX session

A five-minute Access session for one locally approved browser-kind client on the dedicated direct-tailnet UIX TLS origin. `uix:view` selects read-only WebSocket operations and events; `uix:control` adds UIX mutations, never Access, sign-in, voice or headful browser authority. The HttpOnly cookie and rotating refresh are distinct from Content resource handoffs. Revocation and grant changes fence the next HTTP request and close existing WebSockets. _Avoid_: forwarded local UIX port, internal MCP identity, public share link

## Content handoff

A one-use, one-minute secret for opening one document, Content item or immutable Artifact version on its designated origin. The browser exchanges a URL fragment for a short-lived, resource-scoped HttpOnly cookie. Broad Access credentials never enter a URL; every subsequent request still needs verified tailnet provenance. _Avoid_: public share link, broad browser login, Artifact identity

## Browser profile

A durable, empty-at-creation Chrome user-data volume with one owner-supervised Kernel/Hypeman browser while AgentStack runs. Each Bot has an exclusive default; additional profiles may belong exclusively to that Bot or remain unassigned. Deleting a Bot retains its profiles unassigned. Only explicit profile deletion discards their data. Planned owner shutdown closes Chrome before stopping the exact VM; restart retains the volume and refreshes its guest address and CDP relay. _Avoid_: disposable task, shared account profile, sleeping browser

## Browser controller

An agent-browser session in a private Bot-launch namespace, bound to one Browser profile at a time. The private signed launch configuration establishes Bot identity; an arbitrary session name does not. Management selects the profile and queues native reconnect with that controller's commands, invalidating prior refs. Page and tab operations remain in agent-browser. Closing a controller disconnects it without deleting or stopping its profile. Other Bot and controller sessions remain independent. _Avoid_: browser ownership by session name, human handoff, global interaction lock

## Browser handoff

A durable request from a verified Bot Chat for human help with an entire Browser profile, including all its tabs and managed controllers. One unresolved handoff holds managed automation until drain is confirmed, human input is revoked, and controller refs are invalidated on return. Human completion or skip is a report that the agent verifies with a fresh snapshot; disconnect and timeout never resolve it. The originating Chat watches its completion-only read through the existing MCP event subscription service. _Avoid_: tab lease, advisory pause, continuation queue, `readOnly=1` as enforcement

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the local control transports. Socket is the full internal superset. Each MCP and WebSocket declaration independently requires `operations` and `events`: `all`, a positive name list, or `[]` for none; an absent transport is disabled. MCP forwards over loopback HTTP using a request-time selection and, under the owner, offers generated Bot event tools for selected topics and exposed read-only operations. WebSocket forwards over one shared loopback listener and package-addressed connection, retaining its operation/topic selection from handshake; each subscription has its own identifier and optional scope. An optional `http` Transport declares explicit JSON or static routes on separate owner-lifecycle listeners; it does not expose other Package API operations.

_Avoid_: protocol, binding

## Event

A named change notice a Package API publishes on an event-capable transport. Topics and descriptions are declared in TypeScript on the PackageApi (`events`); the socket transport delivers them to connections that call `events/subscribe`. A Package API can require a subscription scope (such as a bot ID), which filters notices without adding data to them. A notice carries only the topic name — never a payload or credentials — so callers snapshot state after (re)subscribing. The owner-managed MCP event tools turn notices into fresh read-only operation values for subscribed Bot threads.

_Avoid_: stream, feed, pubsub

## MCP event subscription

A durable, revisionless request by a verified Bot thread to watch one MCP-selected Package API topic and re-read one exposed read-only operation after each invalidation. The owner records the request, reconnects and resnapshots after interruptions, coalesces unchanged values, and starts a Codex turn on that same sanctioned thread for a changed value. Current exposure is checked around reads and before delivery, including after queued or idle waits; removed or invalid configuration fences subsequent work. The initial value is returned to the subscribing tool call; event notices themselves carry no values.

## Codex account

An AgentStack-owned Codex sign-in credential with an immutable account ID managed by the `auth` Package API for Bots. A new sign-in whose known native ChatGPT identity is already registered is rejected; existing duplicates are not removed. Creating one also creates its paired Codex Worker account for the same ChatGPT login, which needs its own sign-in; both inventories report the pair in `linkedAccounts`, and removing the Bot account removes its paired Worker. Accounts can be enabled or disabled; `bot_start` requires an explicit enabled Bot account ID. An existing Bot changes account only through assignment, then the next start after a stop. A running Bot reports both its assignment and its launched identity. Removing either its assigned or launched Bot account deletes that Bot; removing a Worker account does not. Accounts never take a durable human-facing ordinal. A UI may present dense `codex-bot-account-N` labels derived from the Bot account list. _Avoid_: active account, Codex home, capability profile

## Worker account

A stable account ID for an isolated, native sign-in managed through `auth`. Codex, Grok, Devin and Claude appear in `worker_account_list`, with independent enablement. Grok, Devin and Claude Worker accounts are added and removed directly. A Codex Worker account comes with its paired Codex Bot account and is removed with it; it uses its own OpenCode login, which must be the Bot's ChatGPT login, and shares no credentials with it. A Claude Worker account has its own Claude Code sign-in, independent of AgentUsage and ambient Claude sessions. An older Codex Worker is paired at startup with the Bot account sharing its UUID or its signed-in identity; one matching no Bot stays unpaired and removable. Only a ready, enabled Worker account may admit native Worker sessions. Like Bot accounts, Worker accounts take no durable ordinal; a UI may present dense per-provider `<provider>-worker-account-N` labels (`codex-worker-account-1`, `claude-worker-account-1`) derived from the Worker account list. _Avoid_: active worker account, credential copy, `codex-wN`, `codex-worker-N`, `claude-N`

## ACP runtime

An owner-supervised stdio ACP process for one ready Worker account: OpenCode for Grok or Codex, Devin CLI for Devin. Its pipe is private to AgentStack and is not itself a Package API Transport. The `worker` Package API reports health and account-bound capabilities.

## Claude runtime

An account-bound Claude Agent SDK backend supervised by the `worker` Package API. It owns native Claude Code sessions under one isolated Worker account, sharing the Worker lifecycle and durable records with ACP Workers. Its private SDK control channel is not a Package API Transport, and an available backend does not imply one shared account process.

_Avoid_: Claude ACP process, Bot, ambient Claude session

## Worker catalog

A no-turn observation of model and dependent effort choices actually offered by one account's native runtime: an ACP session or the Claude Agent SDK. Native Devin model IDs remain separately labelled evidence. A Codex catalog omits OpenAI registry entries that offer no effort choice or belong to the o3, realtime and image families, since the ChatGPT sign-in cannot dispatch them; a Grok catalog likewise omits Imagine media-generation models; a Devin catalog omits entries that offer no effort choice; a Claude catalog omits models that Claude refuses to select for the account without purchased usage credits. A newly ready account is observed when its runtime starts, without waiting for a catalog read. Cached values retain source, observation time and stale/error state; they do not by themselves prove successful inference or spendable quota.

## Usage observation

A read-only, scope-and-account-ID-bound measurement of provider quota or billing, collected by the owner-managed `usage` Package API. Bot Codex and Worker Codex observations read their own credentials. Links repeat auth's Codex Bot–Worker pairing by ID. It retains the last good value with an explicit observation time, freshness and sanitized failure code. A subscription end, where a provider exposes one, is account-level evidence with its own source and check time; it says nothing about renewal. It is evidence for a human or agent, not an eligibility verdict or a balancing recommendation; Grok Bot is the machine's separate CLI login rather than a Worker account, observed only while a signed-in Grok Worker account exists.

_Avoid_: account score, capacity decision, balance action

## Resource observation

A cached, timestamped census of the owner's observed process ancestry with OS CPU and memory measurements, domain attribution, availability and sampling limits. The owner Package API exposes process self/subtree and overlapping component, Bot, account and ACP-runtime rollups plus bounded recent history. Shared process costs are not allocated to Worker sessions, chats or turns; these observations are independent of provider quota and billing Usage observations.

_Avoid_: per-chat cost, unique RAM, complete accounting

## Worker

An AgentStack-owned native session started by a Bot (or the local operator) under one enabled Worker account in an owned Git worktree. Its backend is ACP or the Claude Agent SDK. It retains its account, model/effort, Role revision, transcript and origin across turns. Closing a Worker retains the worktree and branch for review. _Avoid_: Bot, active account, disposable prompt

## Worker turn

One admitted prompt on an existing Worker, dispatched through its native backend. Admission returns durable Worker and turn IDs before completion; status and transcript reads establish the outcome. A lost response is `unknown`, never a reason to resubmit the turn automatically. A subsequent turn can request corrections in the same native session after it is idle or explicitly loaded for recovery.

## Worker MCP invocation context

Transport-supplied Worker ID and exact native runtime instance from a private signed MCP URL. The owner checks both against the durable Worker and live account backend before admitting tools; the URL exposes read-only Package API operations and cannot subscribe a Bot thread. It is a same-user correlation and stale-runtime fence, not an OS sandbox. _Avoid_: Bot identity, operator authority

## Inference request

One non-agentic `infer` request on an explicitly chosen Bot account, recorded as a run in `infer`'s durable request ledger whether it came from `infer_complete` or `infer_start`. It finishes exactly once as `completed`, `failed` (definite) or `unknown` (may have been charged). Its request ID makes resending safe: it never dispatches twice, and nothing is retried automatically.

_Avoid_: turn, completion, job

## Main thread

The single Codex thread ID retained by a Bot. A fresh Bot has no main thread until the first persistent root thread created by a connected UI has a durable turn; later Bot launches resume that ID. Only this root and its descendants belong to AgentStack's view of the Bot. Other Codex top-level threads on the same socket are ignored.

## Chat

A Codex app-server thread in an AgentStack-owned Bot's sanctioned main-thread lineage. Historical search and raw records belong to the Bot's history, while live turns, items and interactions come from its owned app-server. Other top-level threads and Worker sessions are not chats. _Avoid_: session, Worker thread

## Chat window

A Fleet window that follows one Bot's main thread: human and assistant text, streamed live, with the turn's activity in a status line. The primary chat window always exists and switches between Bots; additional chat windows keep their own Bot until closed. The arrangement is browser-local. _Avoid_: chat tab, transcript pane

## Worker window

A read-only Workers-space window that follows one Worker: its summary, pending permissions, conversation, turns, tools, records and session metadata. The primary Worker window follows the Workers list; additional windows keep their own Worker until closed. The arrangement is browser-local. Its Bot, not the window, answers and steers the Worker. _Avoid_: Worker chat, Worker console

## Bot subagent

A Codex child thread whose parent chain reaches a Bot's sanctioned main thread. Subagents can themselves have children; a thread's identity and parentage do not establish that it is currently loaded or working. Native task or child-session evidence belongs to its Worker and is not a Bot subagent. _Avoid_: Worker, arbitrary thread on the Bot socket

## Bot

A Codex app-server process with, after its first turn, a durable main thread. By default it is numbered `bot-N` with a private workspace and copies the current Bot defaults: Sol at medium reasoning effort, unrestricted sandbox, and no approval prompts. The Bots Package API can change defaults for future Bots; `bot_start` requires an explicit enabled Codex account and can override a Bot's ID, working directory, saved settings, and launch arguments. Legacy unbound Bots require assignment before a turn. Bots restart on AgentStack startup with their saved account and settings and resume their main thread when one exists.

## Role

The single AgentStack-owned configuration shared by every new Bot launch: ordered developer-instruction fragments, enabled skills, internal owner MCP connections, and additional enabled MCP servers. Each Bot receives a private launch snapshot through codexnk's required `--capabilities` directory. Edits affect later launches, not a running process. _Avoid_: capability profile, system-prompt flag, live prompt file

## Trusted project

An explicit, revisioned Role entry for a canonical project root. Only a Bot launched inside an enabled root receives its `[projects]` trust decision in the private runtime config. That permits the selected project's Codex config, including project MCP servers; it does not import the operator's home configuration.

## Category

An ordered group of instruction fragments in the Role. Its title and description help humans manage content but do not render into the prompt. Disabling it suppresses all its fragments.

## Attention interpretation

An LLM-produced, versioned annotation of newly observed human or assistant conversation text. It identifies semantic items, exact evidence, audience, engagement, informational attention and relationships. Current resolution state is derived separately; an interpretation is not an executable permission grant. Its original input, context, output and processing evidence remain addressable for evaluation.

## Attention inference defaults

The headless `signal` Package API's revisioned model, reasoning effort and optional Codex Bot account assignment. Defaults are Luna/low; a null account uses the first available enabled Bot account in inventory order. These defaults affect subsequent interpretations, independently of Bot launch defaults.

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

The `content` Package API's directory of plain-text wiki documents. Files are authoritative; its SQLite Index is derived and reconciles on reads. This vault remains under AgentStack's `wiki` state directory to preserve existing documents, separate from the original agentwiki vault. _Avoid_: notebook, workspace

## Artifact

A named static file or directory held by `content` with an immutable content-hash Version and a mutable latest pointer. Its manifest and bytes live in AgentStack state, and a stub Document in the Vault makes it searchable and linkable. _Avoid_: attachment, upload

## Artifact origin

The second HTTP origin owned by the `content` Package API. It serves static Artifact and Content item bytes and has no access to the document origin; the separate origin and CSP isolate Artifact scripts from the Vault. Both backend listeners are loopback-only; Access provides distinct authenticated remote origins. _Avoid_: sandbox

## Content collection

A named, optional group of Content items. Items exist independently of collections: each document, file or image has a stable ID and revision, a portable `/c/<id>` path and immutable content-addressed bytes; moving or deleting a collection does not change an item's identity or discard its bytes. The Package API uses IDs and bounded byte transfer rather than machine paths. Content's backends are loopback-only; Access authenticates remote read-only bytes on separate document and Artifact origins.

## Canvas space

A named collection of related windows on its own UIX open bench, addressed as `/x/<space>`. Fleet (Bots) is the default space, Accounts holds accounts, usage limits and model catalogs, Lab holds experimental windows, and System holds the owner, its processes, package channels, host resources and sampling; a relationship between cards in different spaces is a link, not a wire. Spaces retain independent window arrangements and cameras. Navigating switches the visible bench; panning and zooming cannot reveal another space. API reference is a global dock rather than a space.

_Avoid_: page, tab, workspace (a Bot's working directory)

Roles is the fifth Canvas space, managing the Role's instruction Categories and Fragments. Inbox is the sixth, where people read, answer and dismiss Notifications. Signal is the seventh, showing what conversations ask of people and the interpretation evidence behind it. Content is the eighth, for Vault documents, Content collections and items, and published Artifacts; it does not publish Artifacts. Workers is the ninth, following what Workers started by Bots are doing. Scrape is the tenth, for trying extractions, checking preset health and running scrape-to-file jobs. Browse is the eleventh, where a person answers Browser handoffs in a profile viewer and manages Browser profiles and the browser toolchain; it is local-only. Brain is the twelfth, for searching and reading collected research, submitting material, and following ingestion jobs and Research sources.

## Open bench

UIX's continuous canvas for one Canvas space, with its own camera and window arrangement. Only the selected space's bench is visible and interactive. API reference and record inspection are global tools attached to the viewport; their destinations need not name a canvas card.

_Avoid_: shared world, space tabs

## Brain

The `brain` Package API's isolated research index and durable ingestion system. Its database and research artifacts live under AgentStack state; Access owns shared device credentials. It collects material for retrieval; the Content Vault holds authored wiki documents.

_Avoid_: external research service, Content Vault

## Xcom archive

The `xcom` Package API's best-effort, private cache of observed posts from the authenticated X following feed and fetched full X Articles. A post ID remains stable; an observed author profile is not proof that the account is currently followed. Its independent two-month backfill and frequent bounded head scans prioritize freshness without promising complete feed coverage. FTS5 searches tweet and article text separately; Brain remains the general research index. _Avoid_: complete following graph, semantic embeddings, Brain ingestion job

## Scrape

The `scrape` Package API's extraction, preset, link and source-discovery engine. Brain consumes its typed library interface for Ingestion jobs; standalone scrape-to-file jobs live under isolated AgentStack state and are not Brain jobs. A preset's failure to match the provider's current content shape is a classified failure requiring a preset update, not permission for generic extraction. Browser page actions still belong to agent-browser. The local UIX operates its canary checks and queue over the WebSocket; agents do not receive them over MCP. _Avoid_: Brain ingestion worker, browser lifecycle, separate Agentscrape service

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

The current searchable representation of a Research resource in Brain's SQLite index. It is not a plain-text document in the Content Vault.

_Avoid_: Vault document, research artifact

## Research artifact

Immutable captured or derived bytes in Brain's content-addressed store, referenced by typed SQLite records. A content digest identifies bytes, not a Research resource; this is separate from a named, published Content Artifact.

_Avoid_: Content Artifact, resource identity

## Research source

A versioned recurring producer or discovery definition, such as a feed or account timeline. Synchronization creates a durable run grouping observations and child jobs; cadence and checkpoints are policy and evidence, not an independent scheduling service.

_Avoid_: ingress, individual URL job, attempt

## Research egress grant

Operator-controlled permission for a URL submission root or exact Research source version to reach specified TCP IP/port endpoints in addition to public destinations. Children retain its scope; execution and completion recheck revocation. It grants no browser-profile access and is not part of shared intent.

_Avoid_: caller network boolean, source credential, indexing permission

## Proc schedule

A durable, attributed definition for a one-shot or interval invocation of one Package API operation or guarded argv process. Its execution authority is the operator, a sanctioned Bot/root/thread, or a protected system task; operator edits do not promote Bot authority. Proc owns the wake-up, authorized due admission and execution evidence; the target Package API owns its own effects and idempotency. A missed interval is coalesced, not replayed. An interrupted API call has an unknown outcome, never an automatic retry. _Avoid_: Brain Source cadence, agent turn, cron job

## Proc run

One local-user process execution supervised by Proc's IPC guardian, with a caller-supplied idempotency ID for direct admission, bounded stdout/stderr line records, and a durable exit state. Output change notices contain no lines; consumers read by cursor to survive coalescing. _Avoid_: ACP Worker, Bot, Ingestion worker

## Share ingress

Brain's authenticated inbound HTTP listener for AgentStack device clients. It resolves each share into the same Admission boundary and owns no separate queue or index. Network reachability alone is not authorization.

_Avoid_: public API, research extractor

## Share outbox

A device client's bounded durable hold of intent the Share ingress has not acknowledged. It retries delivery using the original destination identity; a held entry is not an ingestion job or proof of saving.

_Avoid_: ingestion queue, saved item

## Share history

A client's bounded record of shares and their last observed outcomes. It echoes server admission and job state rather than deciding whether indexing succeeded; unlike the Share outbox, it does not hold delivery intent.

_Avoid_: ingestion ledger, queue
