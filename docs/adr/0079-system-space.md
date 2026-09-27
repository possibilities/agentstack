# 79. System becomes a fourth space, showing owner resources

Status: accepted, 2026-09-26. Supersedes the left System dock of
[ADR 0058](0058-open-bench-and-global-tools.md) and the System toggle of
[ADR 0061](0061-spaces-menu-and-edge-tools.md), and amends two statements of
[ADR 0054](0054-owner-resource-observations.md): `owner_status` no longer
retains its old exact shape, and the UI gains resource presentation.

## Decision

**System** (`/x/system`, key 4) is a fourth Canvas space beside Fleet,
Accounts and Lab; the four spaces pack as a square. Everything the left System
dock showed is now windows there, joined by new windows for the owner resource
observations of ADR 0054: **Owner** (status, runtime vitals, URLs, children),
**Packages** (channels, MCP endpoints, subscription health), **Resources**
(freshness, AgentStack totals, per-scope charts and breakdown), **Host**
(machine identity, memory, load), **Processes** (the observed process tree)
and **Sampling** (attempts, coverage, retention, capabilities), plus
**Activity** (the dock's notice list). The `resource` and `process` node kinds
join `owner` and `child` with System destinations in `homeOf`; rows flash on
arrival like any other card.

The top bar keeps places and tools apart, but only API reference remains a
tool: the right dock still shares reference and record inspection, while the
left dock, its `?system=` URL parameter and the palette action are retired
without alias — a legacy `?system=` query is ignored, never redirected.

`owner_status` gains `startedAt`/`nodeVersion` on the owner and
`startedAt`/`exitedAt` on each child, so a process's lifecycle reads directly
rather than from presence alone. Resource `host` gains identity (`hostname`,
`arch`, `release`, `cpuModel`) and `uptimeSeconds`; `owner_resources` gains
`runtime`, vitals of the Node process serving the API pinned to each captured
frame, with `eventLoopUtilization` measured between successful captures and
null until a second exists.

The store subscribes to `resources_changed` alongside `pids_changed`, but the
five-second sampling tick is never written to the Activity log. Watched
histories fetch incrementally: a known window resumes from `since` at its
newest retained attempt and merges by `attemptId`, bounded to the owner's
declared retention.

## Consequences

System content pans and resizes like every other space; on a narrow screen it
no longer hides behind a dock that had to coexist with inspection. The dock
geometry loses its left arm, and camera persistence no longer compensates for
it. Attention that once flagged the System button — stopped children, closed
channels, sampling errors, stale attribution — now flags the System space in
the Spaces menu.
