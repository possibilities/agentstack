# 35. Launch Bots with full access by default

Status: accepted, 2026-09-24. Extends [ADR 0029](0029-bots-own-codex-lifecycle.md)'s default Bot launch and saved argument overrides.

AgentStack prepends codexnk app-server config overrides for `sandbox_mode="danger-full-access"` and `approval_policy="never"` to every Bot launch. Previously it passed no access settings, leaving Codex's project-dependent restricted sandbox and approval defaults in effect. The new baseline applies to new Bots and restarts of recorded Bots; it does not change a running process. Explicit caller `-c` arguments follow the baseline and can select narrower settings. `args: []` clears those caller arguments without clearing the baseline. The baseline is not stored in `secrets.server_args`, preserving that table as the caller's saved choice rather than resolved process config.

This uses codexnk's existing app-server `-c` syntax and requires no fork change. Managed policy can still constrain effective permissions. The Bot workspace remains private for data ownership, but full access does not confine actions to that workspace.
