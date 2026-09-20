# 0003: Ship pinned product-owned engines

Status: accepted 2026-09-20.

The Debian artifact contains its own Node runtime, exact Fx integration build, and official Codex package payload. Provenance and source/archive digests are distinct from hashes of the executables actually shipped. Engine commands remain internal under the release root and never replace global `fx` or `codex` commands.

This makes the installed process tree reviewable and prevents mutable PATH state from changing product behavior.
