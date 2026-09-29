# 131. Observe Codex tool bridge availability separately from Role selection

Status: accepted, 2026-09-29. Extends [ADR 0129](0129-codex-tools-in-default-mcp-fleet.md) and the Roles MCP switches of [ADR 0119](0119-per-role-internal-mcp.md).

## Decision

The `serve` Package API owns server-wide observations of the five Codex tool bridges, because the shared listener owns the bridges and they are not Package APIs. `serve_codex_tools` reads the cached observation. `serve_codex_tools_check` starts an explicit check, returns on admission, and `codex_tools_changed` announces its start and finish.

A check is single-flight: a request while one runs joins it. It resolves the selected runtime (`STACK_CODEX_TOOLS_BIN`/`STACK_CODEX_TOOLS_HOME` or a desktop installation) and starts one temporary app-server for all five connections. The app-server opens an ephemeral thread, lists upstream catalogs, starts no model turn, and is closed before the check finishes. Approvals raised during a check are cancelled and reported, never answered. Reading never starts a runtime. Observations are in memory and reset when the server restarts.

Each connection reports its catalog as `not_checked`, `available`, `unavailable` or `failed`, with a timestamp, the evidence actually observed, and a sanitized problem (code, message and recovery step) without paths, credentials, signed URLs or raw runtime output. `available` means only that the upstream catalog lists the connection. A failed check replaces every earlier result, so an old success is never shown as current.

Chrome has a second observation. With `chromeBrowser: true`, a check asks the extension how many Chrome browsers are connected, without reading a tab or page. Catalog availability does not imply a connected browser.

## Presentation

Role switches remain selection for later launches. The Roles MCP window marks each bridge's availability beside its switch and explains each result, with its evidence and recovery step, under “Codex tools availability”. Unavailable connections stay selectable, and no check changes a switch. `role_internal_mcp_list` and `role_launch_preview` carry each server's title, description and kind (`package` or `codex`) from the shared catalog. The UI shows friendly titles while writes keep stable keys.

System has a Codex tools card showing the same observations server-wide. It has the runtime, one inspectable `codex-tool` node per connection, and the same Check actions, but no switches. Each Roles availability row links to that connection's System card.

Checks start a process on the operator's desktop, so the operation is not read-only. It is exposed on the local WebSocket and socket, not on MCP, and remote UI selection excludes it. Agents may read observations over MCP.

## Not decided here

These observations describe the installation, not a consumer. Whether a particular Bot or Worker connected, and whether its client can answer an approval, needs native session evidence and a separate decision about who owns approval responses.
