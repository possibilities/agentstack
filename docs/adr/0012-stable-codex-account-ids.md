# 12. Keep Codex account IDs stable and ordinals presentational

Status: accepted, 2026-09-24. Supersedes the ordinal naming, bound-Server removal, and shared-history-for-new-Servers details of [ADR 0004](0004-codex-account-state.md); its credential and refresh design remains.

`account_login_start` takes no name and allocates an immutable UUID only after a successful device sign-in. Re-sign-in is the separate `account_login_replace` operation targeting an existing ID. The Package API and persisted Server bindings use IDs rather than `codex-N`; a UI can label the current ordered accounts `codex-1` through `codex-N` without gaps, even after a removal. Existing ordinal-backed accounts and Server bindings migrate together on startup, retaining an alias only for importing older JSON Server records.

Removing an account first fences new launches, then stops and deletes its bound Servers, bot workspaces, private runtime, log, and per-Server history before deleting credentials. An interrupted removal remains marked for retry. Legacy Codex history was stored in one shared directory, so files that cannot safely be attributed to the removed account are retained rather than deleting other accounts' sessions. New Servers use isolated history directories to make future removal complete.
