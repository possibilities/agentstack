# 0003: Ship pinned product-owned engines

Status: accepted 2026-09-20; Fx packaging clauses superseded 2026-09-20 by 0007.

The Debian artifact contains its own Node runtime, exact Fx integration build, and official Codex package payload. Provenance and source/archive digests are distinct from hashes of the executables actually shipped. Engine commands remain internal under the release root and never replace global `fx` or `codex` commands.

This makes the installed process tree reviewable and prevents mutable PATH state from changing product behavior.

Source identity and target triple alone did not yield universal Fx bytes in the observed Darwin and Linux builds; current evidence does not establish the cause. The single Linux observation is a release candidate. Qualification remains pending until two isolated-cache Linux x86-64 builds compare byte-for-byte and match that candidate. Darwin arm64 bytes remain development evidence and cannot enter release staging.
