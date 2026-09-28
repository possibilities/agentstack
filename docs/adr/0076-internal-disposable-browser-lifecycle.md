# 76. Keep disposable browser lifecycle behind agent-browser

Status: superseded by [ADR 0092](0092-durable-bot-browser-profiles.md), 2026-09-27. Originally accepted 2026-09-26; extends [ADR 0001](0001-package-apis.md) and [ADR 0014](0014-recovery-and-shutdown-order.md).

The `browser` Package API has a Unix socket lifecycle Transport and a loopback
WebSocket management Transport. AgentStack owns the provider bridge, Hypeman
placement, profile volumes, target incarnations, durable leases and cleanup in
its own private state. The bridge translates agent-browser's plugin protocol to
the socket operations. Page actions stay wholly in agent-browser.

This phase has one backend policy, not one shared saved profile. A new task
gets a fresh disposable profile. The backend never selects existing saved
profiles or AgentBrowse receipts; it derives a provider-specific session name
from the agent-browser session. A close carries the exact lease,
backend, target and profile, rejects a changed target and keeps a failed
release visible. No timeout steals a lease. A session name is a routing key,
not authenticated Bot or Worker identity. Shared account-level ACP processes
cannot guarantee per-Worker ownership of arbitrary CLI invocations.

The owner writes a private agent-browser provider config under AgentStack
state. `AGENTSTACK_BROWSER_PROVIDER=agentstack` opts an isolated test owner and
its launched clients into that config. Do not route production browser work to
it until agent-browser propagates failed provider closes and its 60-second
launch and 15-second close plugin budgets have been validated against Hypeman. An
agent-browser close reporting success does not yet prove that cleanup finished;
inspect the backend's durable ledger before recovery. Do not restart the live
owner or rebuild its served UI as part of this change.

Installation detection and selection never contact a remote Hypeman host.
Manual update policy is the default; an explicitly enabled automatic policy
checks npm periodically and installs newer observed releases. Changes are
announced as invalidations, not a guarantee that a daemon still owns a target.

No saved-profile selection, saved sign-ins, task handoff, remote-file staging,
agent-facing page-action Transport, or canvas control is added. Human and agent
browser operations use agent-browser CLI/MCP; its dashboard is only a candidate
for human viewing/control, not an exclusive handoff protocol.
