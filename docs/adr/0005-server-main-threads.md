# 5. Bind every Codex Server to one main thread

Status: accepted, 2026-09-23. Builds on [ADR 0004](0004-codex-account-state.md).

A Server owns one main Codex thread ID in `configuration.sqlite`. Its first
successful launch calls `thread/start` in its working directory and stores the
returned ID. Subsequent launches call `thread/resume` with that ID and directory;
they do not substitute another thread when resume fails. A Server ID cannot be
reused with a different working directory. Older records without a thread gain
one on their next launch.

After reaping the previous owner's children, startup attempts to launch every
recorded Server, including manually created Servers and Bots. One failed launch
does not prevent the others from starting. An explicit stop stops the current
process but retains the thread; the next AgentStack startup resumes it.
Restarts use the Server's recorded Codex account rather than the active account
selected for new Servers. A removed account blocks that Server's restart instead
of silently continuing its thread under a different identity.

Codex allocates IDs at `thread/start`, so a lost response cannot prove whether
the call created a thread. Before asking Codex to allocate one, AgentStack
persists an unconfirmed-start marker. If the response or durable ID write is
interrupted, it refuses to start another thread under that Server ID until its
history is inspected. This sacrifices automatic recovery from an ambiguous
first launch rather than silently making a second main thread. The shared Codex
history directory remains unchanged for existing sessions.
