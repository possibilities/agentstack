# 105. Proc owns local scheduling and guarded process execution

Status: accepted, 2026-09-28. Extends [ADR 0059](0059-isolated-brain-and-platform-clients.md)'s external Source trigger and [ADR 0096](0096-explicit-transport-exposure.md)'s explicit exposure boundary.

The caller/dispatch policy below is superseded by [ADR 0110](0110-proc-durable-caller-authority.md): schedules now retain explicit durable authority.

## Decision

`proc` is an owner-supervised Package API with an isolated durable store below Stack state. Its operations and events are selected `all` independently on MCP and WebSocket, as on its full local socket. Stack is built for agent–human collaboration: Bots already have execution authority, so Proc's ability to schedule mutating Package API calls and run arbitrary local-user programs is not a reason to hide those operations from them. Worker-bound MCP retains the shared read-only tool policy; WebSocket remains loopback. Proc neither impersonates a Bot nor forwards an MCP invocation context to a later scheduled call. It does not grant OS privileges beyond the local owner user, but it is not a sandbox. No HTTP route or dedicated UI is added.

One-shot and interval schedules capture a typed API target plus JSON input, or a direct argv process specification. Proc verifies the live socket operation exists before accepting an API target and again before dispatch; the target validates its input and owns its effects. The due evaluator admits at most one invocation per overdue schedule and advances recurring due time from the current evaluation. Restart marks interrupted calls and runs `unknown`; it never automatically replays an ambiguous API operation. A guarded process loses its parent IPC when Proc dies and terminates its process group. No shell expansion, PATH lookup or unbounded child output occurs.

The system-owned five-minute schedule invokes Brain's `sources_sync` with `due: true`. It is the wake-up, not a second Source cadence authority. Fresh Brain has no enabled Sources; Source registration and activation stay explicit. The resident Brain Ingestion worker executes the admitted discovery jobs, and Scrape handles their network extraction. A Source Run's success does not imply its child URLs are indexed.

Processes have direct idempotent admission by caller request ID, bounded per-line stdout/stderr retention, cursor reads and blocking observational line/exit waits. Event-capable transports publish payload-free notices for each output line and for lifecycle changes; readers must fetch by cursor because delivery may coalesce or disconnect. Output and schedule input are owner-local state and may contain sensitive data; agents and other clients reading them must treat them accordingly. A process can opt out of retaining lines after exit; terminal history is pruned after 30 days. No default process is spawned on a fresh installation.

## Limits and follow-up

This is a relative interval and one-shot mechanism, not a civil-time recurrence engine. Clock alarms, timers, reminders, time zones, delivery policy and any UI need their own design. Arbitrary Package API operations cannot promise exactly-once effects across an ambiguous socket call; a target needing deduplication must implement its own request key. Schedule outcome and process exit are separate from the effects of downstream asynchronous jobs.

[ADR 0111](0111-proc-space.md) adds the dedicated Proc space UI this decision deferred.
