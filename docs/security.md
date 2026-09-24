# Local trust boundary

Agentstack is designed for one trusted local user account. Its Package API and Codex app-server control sockets live in mode `0700` state directories and use mode `0600` sockets. Anyone who can act as that OS user or read its state directory can control these local processes. Do not place the state directory on a shared filesystem.

Codex account credentials and raw per-bot launch arguments live in `<state>/secrets.sqlite`, separate from account IDs and bot metadata in `<state>/configuration.sqlite`. Arguments may contain sensitive configuration values; `bot_list` does not return them. Both files are mode `0600`; they are not encrypted against the local user. Device sign-in uses a temporary private Codex home and an OAuth link surfaced through the `auth` socket. A new bot gets a short-lived private input copy of the chosen credentials, removed after readiness. codexnk's private runtime copy is retained under `<state>/runtime/<id>` until AgentStack reconciles any refresh into SQLite after exit. A conflicting or unreadable copy may be retained for diagnosis. Do not expose sign-in links, database files, or private runtime directories outside the trusted local user.

`<state>/roles.sqlite` is mode `0600` and holds role instructions, skill file bytes, and additional MCP definitions. `role_snapshot` returns authored definitions, including literal stdio environment values and HTTP headers, to trusted local callers. Prefer environment variable references for credentials. Each bot launch copies enabled role resources into a private directory under `<state>/roles/<id>/`; no role-managed file or MCP configuration is written to the user's Codex home or project. Codexnk still discovers other project or home skills independently, so strict skill exclusivity is not yet guaranteed for custom working directories or future ambient installations.

An enabled trusted-project Role entry permits the matching Bot launch to load that project's Codex config, not merely its MCP entries. It is an explicit local-user decision recorded by canonical path and never applied to an unrelated Bot cwd. Repository skills are intentionally available; the new codexnk carry excludes home-level skill and personal marketplace discovery when its three invocation axes are used, but that behavior is not in the currently installed runtime.

The package sockets own the control operations. MCP forwards tools over loopback HTTP; WebSocket forwards operations and scoped event subscriptions over a separate loopback listener. Their ordinary local endpoints have no per-client authorization: a local process that can reach either port can invoke mutating operations. Bot-bound MCP URLs have a launch proof for correlation and stale-connection fencing, not general authentication. Host and Origin checks reject DNS-rebinding and cross-origin browser requests, but are not authentication. Do not expose either port through a public proxy. Socket and WebSocket event subscriptions deliver only a topic name, never a payload or credentials. The owner-managed MCP event tools separately re-read a caller-selected read-only operation and deliver its value into a Bot turn. A subscription may therefore expose that operation's data to the model; its read arguments and delivery status are saved in private `<state>/event-subscriptions.sqlite` (mode `0600`), while values are not persisted. `tools/list` and the `api` package's `docs_list`/`docs_get` operations expose schemas and metadata, never stored credential material. The optional `agentstack docs` command serves that metadata read-only over loopback HTTP with a local Host check; it exposes no operation-call bridge or credential state. It has no browser admission token or cookie, so keep it local and do not put it behind a public proxy.

Internal MCP URLs given to a Bot include a per-launch HMAC proof from a private `<state>/mcp-bot-identity.key`. The owner verifies the proof and that the Bot still owns the exact instance before forwarding a tool call, then carries Codex's `threadId` metadata through the private socket as invocation context. These URLs are private to Bot launch snapshots, not returned by owner discovery. The proof distinguishes Bot connections from ordinary local callers; it does not authenticate mutually untrusted processes running as the same OS user, and a claimed thread ID must be checked against the Bot's main-thread lineage before targeting a turn.

These controls do not provide isolation between mutually untrusted processes running as the same OS user. Agentstack should not be exposed through a public reverse proxy or a shared host account without an additional authentication and isolation design.

The owned MCP Inspector binds to loopback separately from the MCP transport.
Its API requires a per-launch token, injected into the locally served page;
the owner suppresses its token-bearing startup banner and prints only the bare
local URL. Its generated server list is read-only in Inspector and lives in a
private, temporary directory under the state directory. The Inspector's
authenticated UI can initiate tool calls, so it shares the local-user trust
boundary described above.

The UI canvas is a separate loopback-only Next.js listener and child process.
It reads the Package APIs over local WebSocket and operates account and voice
controls. It shares their local-user trust boundary and is not an authentication
boundary.
