# 122. Select a Worker's Role at creation and deliver capabilities without Role instructions

Status: accepted, 2026-09-29. Extends [ADR 0118](0118-multiple-roles-and-default.md)'s default selection and revises its no-per-Worker-selector decision. Supersedes the Worker instruction-delivery portions of [ADR 0038](0038-durable-acp-worker-execution.md) and [ADR 0060](0060-claude-sdk-workers.md). Their session, snapshot, permission and recovery contracts remain.
The shared-default and no-instruction portions below were revised by [ADR 0124](0124-manager-and-worker-launch-defaults.md).

## Decision

`worker_start` accepts an optional `roleId`. Omission selects the default at creation; an explicit ID selects that existing Role even if it is not default. The socket-only `role_launch_snapshot` accepts the same optional ID and reads either selected content or the default in one Roles-store transaction. Worker start request identity includes an explicit selection while the omitted request retains its previous digest, so retries of existing requests remain valid even after the default changes. An unknown Role fails preparation without choosing another Role.

The Worker captures its selected Role ID, revision, skills and MCP definitions in the existing private snapshot. Enabled internal Package API connections and additional Role MCP servers are supplied to the native session with their existing Worker-instance binding and read-only disclosure restrictions. Enabled skills are copied into its private worktree for ACP Workers or loaded from its private Claude SDK plugin. No Role instruction fragments are submitted as a user prompt, appended to a Claude system prompt or exposed through a generated Devin `/prime` skill. Claude retains its native `claude_code` preset without a Stack Role append. Native defaults and repository-discovered guidance are outside this Role instruction rule.

The choice is per Worker, not per account-bound ACP process or turn. It does not change through `worker_send`; changing Roles means starting another Worker. Recovery reloads the saved snapshot, even if the selected Role was edited, deleted or ceased to be default. Bot launch behavior remains unchanged: Bots still receive the full default Role including instructions and trusted-project decisions. Worker trusted-project entries are retained in the snapshot but are not translated into a native Worker trust grant.

## Delivery

The Worker API, Roles socket operation and discovery schemas change together. The existing Worker read fields `roleId` and `roleRevision` continue to describe the applied snapshot. The UI does not yet offer a launch-time Role selector; a design handoff outside the repository covers that future work. No server restart is part of this decision.
