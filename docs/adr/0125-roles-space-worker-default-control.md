# 125. The Roles space sets the Worker default

Status: accepted, 2026-09-29. Resolves the Worker-default control deferred by [ADR 0124](0124-manager-and-worker-launch-defaults.md) and extends the Roles space of [ADR 0121](0121-roles-space-for-named-roles.md). The creation-time Worker Role picker stays deferred; Workers are started by agents through the Package API.

## Decision

The Roles space offers Make Worker default alongside Make Bot default. Both are one action with an audience: the catalog row menu offers each for a Role that is not already that default, and the Role note offers a button for each default the selected Role is not. A Role that is both defaults shows no note. The Worker action calls the existing `role_set_worker_default` with the held catalog revision, and a stale catalog is reread and the write rebuilt once, exactly as for `role_set_default`. No API change was needed.

One confirmation dialog serves both audiences. It names the audience in its title and states that only that audience's later launches change: Bots keep the Bot default, Workers that select a Role are unaffected, and running Bots and Workers keep their snapshots. A default is never deletable; the delete guard names which default to move first, and both moves are now available in the page.

## Consequences

Operators can reassign either default without the API, and so can free a former default for deletion. Existing Workers are unaffected by the change, since the Workers space compares each Worker with the Role it captured, not with a default. The control is unavailable to view-only remote sessions, like every other Roles write.
