# @agentstack/codex

Typed Codex app-server lifecycle operations for agentstack APIs.

Every invocation uses the required codexnk release at
`~/.local/libexec/codexnk/codex`, installed by AgentStack's setup through the
codexnk workshop. `server_start` has no executable override and never searches
PATH or falls back to vendor Codex.
