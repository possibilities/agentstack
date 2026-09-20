# 0007: Codex-only engine surface

Status: accepted 2026-09-20; supersedes 0001 and the dual-engine clauses of 0002, 0003, and 0005.

AgentStack retires the Fx ACP engine from milestone one. The OS-managed daemon directly parents only Codex app-server. Native protocol code lives in `packages/engine-codex` only. Vendor inputs, staged releases, Debian packages, and control-surface inventories are Codex-only: staging, payload verification, package inspection, and repository audits reject retired Fx manifest keys, paths, binaries, licenses, and provenance.

Existing `$XDG_STATE_HOME/agentstack/engines/fx` user data may remain after upgrade as inactive/orphaned state. Package install, upgrade, and removal never delete it; cleanup stays an explicit operator action.

This keeps a single product-owned engine under the daemon while preserving the architectural history recorded in earlier accepted decisions.
