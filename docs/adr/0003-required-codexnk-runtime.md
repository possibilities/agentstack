# 3. Require the released codexnk runtime

Status: accepted, 2026-09-23.

AgentStack ships with a required, pinned codexnk runtime dependency, not an
operator-selected Codex command. Its setup invokes the sibling codexnk workshop's
release installer with an exact tag and Integration SHA. That owner downloads
the GitHub release, verifies the tag, asset digest and binary contract, and
atomically publishes `~/.local/libexec/codexnk/codex`. AgentStack does not grow a
second downloader or replace vendor Codex. AgentStart's shared consumer pin and
AgentStack's dependency pin must advance together.

Every new managed app server uses that absolute, home-relative path. There is no
`codexBin` request field, PATH search, binary environment override, or vendor
fallback. Legacy request overrides are rejected instead of silently ignored.
The same-named field retained in private server records is launch provenance,
not configuration; it never selects a subsequent executable.

Missing or non-executable runtime bytes fail with installation guidance. Runtime
launch does not install or download software. An already-running record from a
different executable is not returned as a codexnk instance: it must be explicitly
stopped before that ID can be started again. Setup and builds do not restart
AgentStack or its children; a running owner must be restarted during maintenance
to load the new implementation.
