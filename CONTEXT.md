# Context

## Notification

A durable Stack-owned message with a stable ID. It is open or dismissed; dismissal happens once and records its outcome (closed, opened, action, replied or replaced), so answering or clicking through is what acknowledges it. A group replaces the open notification with the same key. Its actions, reply prompt and open URL are data; presentation is separate from storage and nothing executes. _Avoid_: operating-system notification, acknowledgment as a separate state, callback

A verified Bot MCP send watches dismissal by default when it offers actions or a reply. `subscribe: true` also watches plain notices; `false` opts out. The send receipt distinguishes storing the Notification from admitting its completion watch. A dismissed initial record is returned to inspect, not a second wakeup. Dismissal and native input admission never imply approval or consumption.

## Package API

Typed operations a workspace package exports so stack can serve them. Descriptions and schemas are written for selection, in the same spirit as an MCP tool or a skill.

_Avoid_: MCP server, endpoint, route

## State maintenance

Owner-specific inspection and exact cleanup of retained Stack state. An inventory
reports coverage, ownership, retention and regeneration; a plan binds observed
revisions and consequences; a request receipt records effects and uncertainty.
Conversation reset, workspace clearing, payload clearing, work cancellation,
settings reset and identity removal are distinct. A receipt never turns an unknown
native outcome into a known one. See [ADR 0135](docs/adr/0135-owner-state-maintenance.md)
and the [operation matrix](docs/state-control.md). _Avoid_: reset everything,
clear means cancel, tombstone means erased, unmeasured means zero

## Standalone operation

An operation whose Package API explicitly supplies a scoped context factory for
operator stdio execution when its private socket is definitely absent before
dispatch. It reuses the owner's handler, schemas and MCP content projection,
without the full Server context or background lifecycle. Discovery's `standalone`
flag describes this capability, not live availability or permission for a managed
caller. A read-only hint alone does not opt in. _Avoid_: offline server, implicit
read-only fallback, replay after timeout

## Access client

A durable phone, extension, browser, desktop or future cloud consumer identity owned by the `access` Package API. A tailnet client pairs through manual local approval, a one-use local QR invitation, or an offline QR request explicitly approved by a permitted enrollment sponsor. Its human approval code or request QR is distinct from its private high-entropy redemption secret. One client may receive multiple Stack resource scopes. _Avoid_: Brain token, Bot, Worker, Tailscale node identity

## Access enrollment sponsor

A non-browser Access client explicitly granted `access:enroll` by trusted local control. Its access-audience token can inspect and approve a new device's offline QR request for a subset of its own resource scopes, never delegate enrollment authority. A credential-free receipt returns the server destination to the new device; only that device can redeem using its retained secret and destination-bound Ed25519 proof. Sponsor authority is checked again before issuance; issued clients are independent and retain durable sponsor provenance. _Avoid_: forwarded phone credential, automatic QR approval, remote Access administrator

## Access grant

An explicit set of scopes or selected operations for one Access client and one network policy. Tailnet device grants and public-cloud grants are distinct; a device credential never authorizes public ingress. Client, grant and individual credential revocation fence dependent short-lived tokens and browser sessions on subsequent requests. Public-cloud credentials and remote MCP admission are not yet implemented. _Avoid_: network reachability, approval code, internal MCP context

## Remote UI session

A five-minute Access session for one approved browser or desktop Access client on the dedicated direct-tailnet UI TLS origin. Desktop clients enter through a one-use UI handoff; the viewer's HttpOnly refresh lineage is independent of the desktop's native credential. `ui:view` selects read-only WebSocket operations and events; `ui:control` adds UI mutations, never Access, sign-in, voice or headful browser authority. Cookies and rotating refresh are distinct from Content resource handoffs. Revocation and grant changes fence the next HTTP request and close existing WebSockets. _Avoid_: forwarded local UI port, internal MCP identity, public share link

## Client host

A same-user local controller owned by `packages/client`, independent of a running
Stack platform. It owns one optional local installation/background user service,
explicit saved/applied platform login preference and multiple destination-pinned
Access connections. Its private socket can exist before installation; it is not
part of the platform Package API fleet. The separate client-UI authority cannot
grant local platform or remote Access authority. _Avoid_: remote installer,
anonymous loopback control, native app means trusted platform, npx cache as durable install

## UI handoff

A one-use, one-minute Access capability for a desktop or browser client to
establish a scoped Remote UI session on one exact UI origin. It travels in an
erased navigation fragment, never carries the native refresh credential and
checks live grant revision before consumption. The resulting viewer refresh
family is independent of native credential rotation. _Avoid_: Content handoff,
phone credential forwarding, durable browser token in a URL

## Local operator session

An eight-hour local UI or Inspector browser session established by a one-use capability minted through the private server socket and opened by `stack serve open`. It is bound to one exact origin and audience. UI server renders require it; each local WebSocket reconnect exchanges it for a one-use 30-second ticket. Server restart or explicit local revocation invalidates sessions and the external HTTP operator bearer credential. Private operator stdio launch authority is a separate audience in the same LocalAuth store: routine startup preserves it, explicit local revocation invalidates it, and existing pipes never silently renew it. Bot/Worker identities and remote Access sessions remain independent. _Avoid_: anonymous loopback authority, OS sandbox, Access grant

## Content handoff

A one-use, one-minute secret for opening one document, Content item or immutable Artifact version on its designated origin. The browser exchanges a URL fragment for a short-lived, resource-scoped HttpOnly cookie. Broad Access credentials never enter a URL; every subsequent request still needs verified tailnet provenance. _Avoid_: public share link, broad browser login, Artifact identity

## Browser profile

A durable, empty-at-creation Chrome user-data volume with one server-supervised Kernel/Hypeman browser while Stack runs. Each Bot has an exclusive default; additional profiles may belong exclusively to that Bot or remain unassigned. Deleting a Bot retains its profiles unassigned. Only explicit profile deletion discards their data. Planned server shutdown closes Chrome before stopping the exact VM; restart retains the volume and refreshes its guest address and CDP relay. _Avoid_: disposable task, shared account profile, sleeping browser

## Browser controller

An agent-browser session in a private Bot-launch namespace, bound to one Browser profile at a time. The private signed launch configuration establishes Bot identity; an arbitrary session name does not. Management selects the profile and queues native reconnect with that controller's commands, invalidating prior refs. Page and tab operations remain in agent-browser. Closing a controller disconnects it without deleting or stopping its profile. Other Bot and controller sessions remain independent. _Avoid_: browser ownership by session name, human handoff, global interaction lock

## Browser handoff

A durable request from a verified Bot Chat for human help with an entire Browser profile, including all its tabs and managed controllers. One unresolved handoff holds managed automation until drain is confirmed, human input is revoked, and controller refs are invalidated on return. Human completion or skip is a report that the agent verifies with a fresh snapshot; disconnect and timeout never resolve it. The originating Chat watches its completion-only read through the existing MCP event subscription service. _Avoid_: tab lease, advisory pause, continuation queue, `readOnly=1` as enforcement

## Transport

A configured way to expose one Package API. `socket`, `mcp`, and `websocket` are the local control transports. Socket is the full internal superset. Each MCP and WebSocket declaration independently requires `operations` and `events`: `all`, a positive name list, or `[]` for none; an absent transport is disabled. MCP uses native stdio for Stack's Bot, Worker and injected Role launches, and authenticated loopback HTTP for external consumers. Internal stdio discovery uses installed typed declarations and current manifest exposure without a running Server or Package API context. Calls prefer the private socket owner; only definite pre-dispatch absence permits explicitly owner-supported standalone execution. Other calls return actionable dependency errors without closing the pipe or replaying an uncertain request. HTTP retains live socket validation. Generated Bot event tools route to the server's sole durable subscription owner. WebSocket forwards over one shared loopback listener and package-addressed connection, retaining its operation/topic selection from handshake; each subscription has its own identifier and optional scope. An optional `http` Transport declares explicit JSON or static routes on separate server-lifecycle listeners; it does not expose other Package API operations. See [ADR 0146](docs/adr/0146-server-independent-internal-mcp.md).

_Avoid_: protocol, binding

## Event

A named change notice a Package API publishes on an event-capable transport. Topics and descriptions are declared in TypeScript on the PackageApi (`events`); the socket transport delivers them to connections that call `events/subscribe`. A Package API can require a subscription scope (such as a bot ID), which filters notices without adding data to them. A notice carries only the topic name — never a payload or credentials — so callers snapshot state after (re)subscribing. The server-managed MCP event tools turn notices into fresh read-only operation values for subscribed Bot threads.

_Avoid_: stream, feed, pubsub

## Default MCP fleet

The Role-selectable MCP connections supplied by Stack: Package APIs and the
five Codex tool bridges described in [ADR 0129](docs/adr/0129-codex-tools-in-default-mcp-fleet.md).
Internal launches use stdio; external consumers retain HTTP. All are enabled unless a Role excludes them. The bridges are not Package APIs;
they have no socket operations or generated event subscriptions.

## MCP event subscription

A durable, revisionless request by a verified Bot thread to watch one MCP-selected Package API topic and re-read one exposed read-only operation after each invalidation. The server records the request, reconnects and resnapshots after interruptions, suppresses unchanged values, and submits changed snapshots as standalone tool output through Codex `turn/start` on that same sanctioned thread. Codex wakes an idle loaded thread or queues input in an active regular turn; Stack waits only for admission acknowledgement, never idle or completion. Current exposure is checked around reads and immediately before submission, including after connection setup; removed or invalid configuration fences subsequent work. The initial value is returned to the subscribing tool call; event notices themselves carry no values. See [ADR 0120](docs/adr/0120-codex-native-input-admission.md).

## Completion watch

An operation-declared, one-shot MCP event subscription owned by the same Server service. Its intent and coordination capability are stored before a record mutation. Only that record's terminal read wakes the invoking sanctioned Chat; an already-terminal initial read is returned and retained as observed instead. Acknowledged native admission retires the watch and retains its receipt for ID retries. An uncertain admission stays inspectable and is never automatically replayed, even after restart. Installed stdio discovery declares this capability without creating watches; sends require the live owner. See [ADR 0152](docs/adr/0152-notification-send-and-watch.md). _Avoid_: approval, consumption acknowledgement, independent delivery loop

## Codex account

An Stack-owned Codex sign-in credential with an immutable account ID managed by the `auth` Package API for Bots. A new sign-in whose known native ChatGPT identity is already registered is rejected; existing duplicates are not removed. Creating one also creates its paired Codex Worker account for the same ChatGPT login, which needs its own sign-in; both inventories report the pair in `linkedAccounts`, and removing the Bot account removes its paired Worker. Accounts can be enabled or disabled; `bot_start` requires an explicit enabled Bot account ID. An existing Bot changes account only through assignment, then the next start after a stop. A running Bot reports both its assignment and its launched identity. Removing either its assigned or launched Bot account deletes that Bot; removing a Worker account does not. Accounts never take a durable human-facing ordinal. A UI may present dense `codex-bot-account-N` labels derived from the Bot account list. _Avoid_: active account, Codex home, capability profile

## Worker account

A stable account ID for an isolated, native sign-in managed through `auth`. Codex, Devin and Claude appear in `worker_account_list`, with independent enablement. Devin and Claude Worker accounts are added and removed directly. A Codex Worker account comes with its paired Codex Bot account and is removed with it; it uses its own OpenCode login, which must be the Bot's ChatGPT login, and shares no credentials with it. A Claude Worker account has its own Claude Code sign-in, independent of AgentUsage and ambient Claude sessions. An older Codex Worker is paired at startup with the Bot account sharing its UUID or its signed-in identity; one matching no Bot stays unpaired and removable. Only a ready, enabled Worker account may admit native Worker sessions. Like Bot accounts, Worker accounts take no durable ordinal; a UI may present dense per-provider `<provider>-worker-account-N` labels (`codex-worker-account-1`, `claude-worker-account-1`) derived from the Worker account list. _Avoid_: active worker account, credential copy, `codex-wN`, `codex-worker-N`, `claude-N`

## ACP runtime

An server-supervised stdio ACP process for one ready Worker account: OpenCode for Codex, Devin CLI for Devin. Its pipe is private to Stack and is not itself a Package API Transport. The `worker` Package API reports health and account-bound capabilities.

## Claude runtime

An account-bound Claude Agent SDK backend supervised by the `worker` Package API. It owns native Claude Code sessions under one isolated Worker account, sharing the Worker lifecycle and durable records with ACP Workers. Its private SDK control channel is not a Package API Transport, and an available backend does not imply one shared account process.

_Avoid_: Claude ACP process, Bot, ambient Claude session

## Worker catalog

A no-turn observation of model and dependent effort choices actually offered by one account's native runtime: an ACP session or the Claude Agent SDK. Native Devin model IDs remain separately labelled evidence. A Codex catalog omits OpenAI registry entries that offer no effort choice or belong to the o3, realtime and image families, since the ChatGPT sign-in cannot dispatch them; a Devin catalog omits entries that offer no effort choice; a Claude catalog omits models that Claude refuses to select for the account without purchased usage credits. A newly ready account is observed when its runtime starts, without waiting for a catalog read. Cached values retain source, observation time and stale/error state; they do not by themselves prove successful inference or spendable quota.

## Usage observation

A read-only, scope-and-account-ID-bound measurement of provider quota or billing, collected by the server-managed `usage` Package API. Bot Codex and Worker Codex observations read their own credentials. Links repeat auth's Codex Bot–Worker pairing by ID. It retains the last good value with an explicit observation time, freshness and sanitized failure code. A subscription end, where a provider exposes one, is account-level evidence with its own source and check time; it says nothing about renewal. It is evidence for a human or agent, not an eligibility verdict or a balancing recommendation.

_Avoid_: account score, capacity decision, balance action

## Resource observation

A cached, timestamped census of the server's observed process ancestry with OS CPU and memory measurements, domain attribution, availability and sampling limits. The server Package API exposes process self/subtree and overlapping component, Bot, account and ACP-runtime rollups plus bounded recent history. Shared process costs are not allocated to Worker sessions, chats or turns; these observations are independent of provider quota and billing Usage observations.

_Avoid_: per-chat cost, unique RAM, complete accounting

## Worker

An Stack-owned native session started by a Bot (or the local operator) under one enabled Worker account in an owned Git worktree. Its backend is ACP or the Claude Agent SDK. It retains its account, model/effort, selected Role ID and revision, transcript and origin across turns. A new Worker uses the Worker default Role unless creation selects another; it receives its enabled instructions, skills and MCP connections. The initial Worker Role has no instruction fragments, but later edits can add them. Closing a Worker retains the worktree and branch for review. _Avoid_: Bot, active account, disposable prompt

## Worker turn

One admitted prompt on an existing Worker, dispatched through its native backend. Admission returns durable Worker and turn IDs before completion; status and transcript reads establish the outcome. A lost response is `unknown`, never a reason to resubmit the turn automatically. A subsequent turn can request corrections in the same native session after it is idle or explicitly loaded for recovery.

A turn can capture a HUD Work context: exact Work item ID, observed scope revision
and explicit, Chat-focus or continuation provenance. The Worker owner stores this
with admission; retries and runtime recovery preserve it. Native completion never
completes the Work item.

## Work item

A shared, durable objective owned by the `hud` Package API, with ordered nested
children, semantic state, dependencies, next action, human/agent attention and
typed resource links. Optimistic revisions coordinate human/agent edits; a separate
scope revision identifies the objective, parent and dependency epoch. Namespaced
agent metadata is available through explicit reads and correlation queries, outside
ordinary human projections. _Avoid_: Worker turn, native task, runtime phase

## Work context

A Work item ID and scope revision captured for one Worker admission. It comes from
an explicit selector, verified Chat focus or continuation of the preceding turn.
It is historical association evidence, not a lease, dispatch permission or proof of
completion. _Avoid_: inferred ownership by title, account or working directory

## Chat focus

An explicit, revisioned Work selection keyed by a Bot's sanctioned main thread and
one exact Chat. Descendants inherit the nearest selected ancestor; saved null blocks
inheritance. Changing focus never reassigns previously admitted Worker turns.
_Avoid_: native activity, UI selection, global Bot current task

## Worker MCP invocation context

Transport-supplied Worker ID and exact native runtime instance from a private signed MCP launch binding, carried in stdio environment or a legacy HTTP URL. Internal stdio catalog admission verifies the signature without requiring a live owner; every call checks both identities against the durable Worker and live account backend. Missing or invalid bindings never fall back to operator authority. A manifest's positive `mcp.workerOperations` list, intersected with MCP exposure, selects disclosed reads; omission denies all. Read-only hints alone grant no access. Worker record reads are self-only, and Worker calls cannot subscribe Bot threads. It is not an OS sandbox. _Avoid_: Bot identity, operator authority

## Inference request

One non-agentic `infer` request on an explicitly chosen Bot account, recorded as a run in `infer`'s durable request ledger whether it came from `infer_complete` or `infer_start`. It finishes exactly once as `completed`, `failed` (definite) or `unknown` (may have been charged). Its request ID makes resending safe: it never dispatches twice, and nothing is retried automatically.

_Avoid_: turn, completion, job

## Main thread

The single sanctioned Codex thread ID retained by a Bot. New account-bound Bots allocate it for their one-time orientation turn; the ID alone does not prove durable admission or completed initialization. Legacy Bots bind the first persistent UI root with a durable turn. Later launches resume the exact ID, never allocate a replacement on uncertainty. Only this root and its descendants belong to Stack's view of the Bot. Other Codex top-level threads on the same socket are ignored.

## Bot orientation

One genuine, Stack-originated initialization turn for a new account-bound Bot: bounded orientation, a brief introduction and a grounded offer to help. Its durable admission fence, exact root/turn and observed native outcome are distinct from process readiness. Uncertain allocation or admission never retries automatically; legacy Bots are not enrolled. Voice waits for a known terminal outcome, not merely admission. Explicit conversation reset retires orientation without implying native completion or repeating it. See [ADR 0141](docs/adr/0141-role-bot-personality-and-orientation.md). _Avoid_: human first message, onboarding questionnaire, dummy turn, admission means ready

## bot.md

A Role-owned, editable Bot personality, stored as `botMarkdown` and captured verbatim into a Bot's private launch capabilities. It composes with Role instruction Fragments but is separate from them and from the one-time orientation request. Changes apply on a later Bot launch; Workers and injected CLIs do not receive it. It is not mutable per-Bot memory and cannot expand authority. _Avoid_: Bot-owned identity file, live prompt file, onboarding prompt

## Chat

A Codex app-server thread in an Stack-owned Bot's sanctioned main-thread lineage. Historical search and raw records belong to the Bot's history, while live turns, items and interactions come from its owned app-server. Other top-level threads and Worker sessions are not chats. _Avoid_: session, Worker thread

## Chat window

A Fleet window that follows one Bot's main thread: human and assistant text, streamed live, with the turn's activity in a status line. The primary chat window always exists and switches between Bots; additional chat windows keep their own Bot until closed. The arrangement is browser-local. _Avoid_: chat tab, transcript pane

## Worker window

A Workers-space window that follows one Worker: its summary, pending permissions, conversation, turns, tools, records and session metadata, all read-only, plus its managed model and effort settings, which it can save and apply to the exact idle runtime. The primary Worker window follows the Workers list; additional windows keep their own Worker until closed. The arrangement is browser-local. Its Bot, not the window, answers and steers the Worker. _Avoid_: Worker chat, Worker console

## Bot subagent

A Codex child thread whose parent chain reaches a Bot's sanctioned main thread. Subagents can themselves have children; a thread's identity and parentage do not establish that it is currently loaded or working. Native task or child-session evidence belongs to its Worker and is not a Bot subagent. _Avoid_: Worker, arbitrary thread on the Bot socket

## Bot

A Codex app-server process with a sanctioned main thread. New account-bound Bots automatically take one orientation turn; legacy Bots bind their first durable UI root. By default it is numbered `bot-N` with a private workspace and copies the current Bot defaults: Sol at medium reasoning effort, unrestricted sandbox, and no approval prompts. The Bots Package API can change defaults for future Bots; `bot_start` requires an explicit enabled Codex account and can override a Bot's ID, working directory, saved settings, and launch arguments. Legacy unbound Bots require assignment before a turn. Bots restart on Stack startup with their saved account and settings and resume their exact main thread when one exists.

## Managed runtime settings

Versioned explicit preferences owned by Bots or Workers, with backend-specific catalogs and separate saved, loaded, resolved-configuration and observed-effective evidence. Creation defaults are copied into new instances; reset removes an override and restores native resolution. Saving does not apply: Bot process changes load at start, voice changes on the next call, and Worker selections on the next follow-up or explicit idle application. Roles own instructions and resources. _Avoid_: effective values inferred from saved configuration, native subagent defaults as Worker controls

## Developer mode

A durable global Stack setting owned by `serve`, disabled by default and explicitly
selected by the local operator. It immediately gates developer features and their
operation calls. Its first feature is periodic, cached upstream harness-release
observation. It is independent of Bot and Worker managed runtime settings and of
the UI development server. See [ADR 0138](docs/adr/0138-developer-mode-and-harness-releases.md).
_Avoid_: browser-local preference, Role setting, development environment

## Harness release observation

A timestamped observation of the public upstream release channel for OpenCode V2,
Codex, Claude Code or Devin CLI. The server retains last-good values, failures and
changes between successful observations while developer mode controls collection
and access. A changed upstream version does not establish that an installed or
forked runtime needs upgrading. _Avoid_: installed version, automatic update,
update eligibility

## Role

A named Stack-owned configuration with a stable ID and independent revision: ordered developer-instruction fragments, Bot-only `bot.md` personality, enabled skills, per-Role internal MCP enablement, additional MCP servers and trusted projects. Bot and Worker defaults are independent; any existing Role can be marked default. Every new Bot launch captures the Bot default; a new Worker captures the Worker default unless `worker_start` selects another Role. Bot launches receive a private snapshot through codexnk's required `--capabilities` directory; Workers receive instruction fragments, skills and MCP connections without `bot.md`. Worker recovery retains its saved snapshot. Edits and default changes affect later launches, not a running process. _Avoid_: singleton Role, capability profile, system-prompt flag, live prompt file

## Role injection

A local operator invocation of `stack roles inject [default|role-name] -- <claude|codex|opencode> ...` that captures one Role's enabled skills, MCP connections and rendered instruction fragments for a native CLI. Omission or literal `default` selects the catalog default. It reads the existing local Role store without initialization or migration and does not require a running Server. Private capability delivery excludes ambient personal configuration while authentication remains native and independent of the Role. This invocation is neither a Bot nor a Worker; internal MCP connections use operator authority. A connected tool can still require its running owner. _Avoid_: account selection, global Role installation, Worker launch, OS sandbox

## Role shim

An explicitly installed, Stack-owned executable in Stack's command directory (by default `~/.local/bin`) that runs `stack roles inject` with an exact configured argument vector and appends invocation arguments unchanged. The installed script is the durable definition; its content hash fences edits and removal. It resolves Role names and defaults when invoked, not when installed. Unrelated or manually edited commands are never adopted or replaced. Shim management is local operator control, not a remote UI or Worker capability. _Avoid_: ambient role overlay, Bot launch, implicit install

## Default Role

The Role selected in the Role catalog for every later Bot launch and for new Workers that omit `roleId`. Selecting a Role for editing does not make it default. A fresh catalog has no Role until its first creation; afterward exactly one is default. The default cannot be deleted until another Role is selected. A session's `roleId` and `roleRevision` record the applied snapshot, not a mutable assignment.

## Internal Role MCP enablement

Per-Role selection of Stack's configured Package API MCP connections. All are on by default, including newly configured internal servers. `disabledInternalMcpServers` stores explicit exclusions. These settings affect launch connections, not the package's availability, operation exposure or authorization. Additional Role MCP servers remain separately managed.

## Trusted project

An explicit, revisioned Role entry for a canonical project root. Only a Bot launched inside an enabled root receives its `[projects]` trust decision in the private runtime config. That permits the selected project's Codex config, including project MCP servers; it does not import the operator's home configuration.

## Category

An ordered group of instruction fragments in the Role. Its title and description help humans manage content but do not render into the prompt. Disabling it suppresses all its fragments.

## Attention interpretation

An LLM-produced, versioned annotation of newly observed human or assistant conversation text. It identifies semantic items, exact evidence, audience, engagement, informational attention and relationships. Current resolution state is derived separately; an interpretation is not an executable permission grant. Its original input, context, output and processing evidence remain addressable for evaluation.

## Attention inference defaults

The headless `signal` Package API's revisioned model, reasoning effort and optional Codex Bot account assignment. Defaults are Luna/low; a null account uses the first available enabled Bot account in inventory order. These defaults affect subsequent interpretations, independently of Bot launch defaults.

## Fragment

A durable, ordered developer-instruction body with a stable ID, human-only title and description, and first-class conditions. Only enabled, nonblank fragments in enabled categories whose conditions match the explicit rendering context enter the instructions. Conditions initially support exact, case-sensitive model and harness values, combined with AND; an empty condition object is unconditional, and missing context never satisfies a condition. `roles inject --with-model VALUE --with-harness VALUE` supplies rendering context without configuring native harness arguments.

## Role skill

A named, enabled or disabled skill record containing Markdown instructions and optional supporting files. Stack stores the bytes in the Role and writes only enabled skills to a Bot's private launch snapshot. Codex also discovers project skills, while the three-axis launch excludes home-level skills. Role skill selection does not suppress project, bundled, or explicitly added skill roots.

## Role MCP server

An additional named, enabled or disabled HTTP or stdio MCP definition in the Role. Enabled definitions join internal Package API connections in a Bot's private launch configuration or a Worker's native session. They do not change ambient configuration or running sessions.

## MCP invocation context

Transport-supplied information about one Package API operation invoked through MCP. A private signed launch binding proves a live Bot ID and instance, carried in stdio environment or a legacy HTTP URL; Codex supplies a thread ID in each tool call's `_meta`, independently of the connection. Package API handlers can read that context as an optional third argument without changing their public input schema. The thread ID is a claim until checked against the Bot's sanctioned main-thread lineage. Role injection uses explicit operator authority and cannot acquire Bot wakeups.

## Voice call

One ephemeral, full-duplex WebRTC audio session into a running Bot's existing main thread. The Bots Package API relays an SDP offer and answer, tracks the exact call ID, and stops only native realtime on hang-up; it never creates a thread or ends a turn. The browser owns microphone capture and speaker playback. A caller can submit speakable text only on the exact connected call; native acknowledgement does not establish audible or verbatim delivery.

_Avoid_: voice agent, voice thread

## Vault

The `content` Package API's directory of plain-text wiki documents. Files are authoritative; its SQLite Index is derived and reconciles on reads. This vault remains under Stack's `wiki` state directory to preserve existing documents, separate from the original agentwiki vault. _Avoid_: notebook, workspace

## Artifact

A named static file or directory held by `content` with an immutable content-hash Version and a mutable latest pointer. Its manifest and bytes live in Stack state, and a stub Document in the Vault makes it searchable and linkable. _Avoid_: attachment, upload

## Artifact origin

The second HTTP origin owned by the `content` Package API. It serves static Artifact and Content item bytes and has no access to the document origin; the separate origin and CSP isolate Artifact scripts from the Vault. Both backend listeners are loopback-only; Access provides distinct authenticated remote origins. _Avoid_: sandbox

## Content collection

A named, optional group of Content items. Items exist independently of collections: each document, file or image has a stable ID and revision, a portable `/c/<id>` path and immutable content-addressed bytes; moving or deleting a collection does not change an item's identity or discard its bytes. The Package API uses IDs and bounded byte transfer rather than machine paths. Content's backends are loopback-only; Access authenticates remote read-only bytes on separate document and Artifact origins.

## Canvas space

A named collection of related windows on its own UI open bench, addressed as `/<space>` (Fleet lives at `/`). Fleet (Bots) is the default space, Accounts holds accounts, usage limits and model catalogs, Lab holds experimental windows, and System holds the server, its processes, package channels, host resources and sampling; a relationship between cards in different spaces is a link, not a wire. Spaces retain independent window arrangements and cameras. Navigating switches the visible bench; panning and zooming cannot reveal another space. API reference is a global dock rather than a space.

_Avoid_: page, tab, workspace (a Bot's working directory)

Roles is the fifth Canvas space, managing named Roles, the default Role and each Role's instruction Categories and Fragments, skills, MCP servers, trusted projects and internal MCP switches. Inbox is the sixth, where people read, answer and dismiss Notifications. Signal is the seventh, showing what conversations ask of people and the interpretation evidence behind it. Content is the eighth, for Vault documents, Content collections and items, and published Artifacts; it does not publish Artifacts. Workers is the ninth, following what Workers started by Bots are doing. Scrape is the tenth, for trying extractions, checking preset health and running scrape-to-file jobs. Browse is the eleventh, where a person answers Browser handoffs in a profile viewer and manages Browser profiles and the browser toolchain; it is local-only. Brain is the twelfth, for searching and reading collected research, submitting material, and following ingestion jobs and Research sources.

## Open bench

UI's continuous canvas for one Canvas space, with its own camera and window arrangement. Only the selected space's bench is visible and interactive. API reference and record inspection are global tools attached to the viewport; their destinations need not name a canvas card.

_Avoid_: shared world, space tabs

## Brain

The `brain` Package API's isolated research index and durable ingestion system. Its database and research artifacts live under Stack state; Access owns shared device credentials. It collects material for retrieval; the Content Vault holds authored wiki documents.

_Avoid_: external research service, Content Vault

## Xcom archive

The `xcom` Package API's best-effort, private cache of observed posts from the authenticated X following feed and fetched full X Articles. A post ID remains stable; an observed author profile is not proof that the account is currently followed. Its independent two-month backfill and frequent bounded head scans prioritize freshness without promising complete feed coverage. FTS5 searches tweet and article text separately; Brain remains the general research index. _Avoid_: complete following graph, semantic embeddings, Brain ingestion job

## Scrape

The `scrape` Package API's extraction, preset, link and source-discovery engine. Brain consumes its typed library interface for Ingestion jobs; standalone scrape-to-file jobs live under isolated Stack state and are not Brain jobs. A preset's failure to match the provider's current content shape is a classified failure requiring a preset update, not permission for generic extraction. Browser page actions still belong to agent-browser. The local UI operates its canary checks and queue over the WebSocket; agents do not receive them over MCP. _Avoid_: Brain ingestion worker, browser lifecycle, separate Agentscrape service

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

A durable, attributed definition for a one-shot or interval invocation of one Package API operation or guarded argv process. It may carry a short label naming its purpose. Its execution authority is the operator, a sanctioned Bot/root/thread, or a protected system task; operator edits do not promote Bot authority. Proc owns the wake-up, authorized due admission and execution evidence; the target Package API owns its own effects and idempotency. A missed interval is coalesced, not replayed. An interrupted API call has an unknown outcome, never an automatic retry. _Avoid_: Brain Source cadence, agent turn, cron job

## Proc run

One local-user process execution supervised by Proc's IPC guardian, with a caller-supplied idempotency ID for direct admission, bounded stdout/stderr line records, and a durable exit state. It may carry a short label, and retains its executable, arguments, cwd and environment variable names — never values. Output change notices contain no lines; consumers read by cursor to survive coalescing. _Avoid_: ACP Worker, Bot, Ingestion worker

## Share ingress

Brain's authenticated inbound HTTP listener for Stack device clients. It resolves each share into the same Admission boundary and owns no separate queue or index. Network reachability alone is not authorization.

_Avoid_: public API, research extractor

## Share outbox

A device client's bounded durable hold of intent the Share ingress has not acknowledged. It retries delivery using the original destination identity; a held entry is not an ingestion job or proof of saving.

_Avoid_: ingestion queue, saved item

## Share history

A client's bounded record of shares and their last observed outcomes. It echoes server admission and job state rather than deciding whether indexing succeeded; unlike the Share outbox, it does not hold delivery intent.

_Avoid_: ingestion ledger, queue
