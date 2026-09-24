# 17. Persist caller launch arguments with each Server

Status: accepted, 2026-09-24. Extends [ADR 0005](0005-server-main-threads.md)'s durable Server binding and [ADR 0004](0004-codex-account-state.md)'s private state separation.

The caller-supplied Codex argument array is part of a Server's durable launch configuration. AgentStack saves it by Server ID in `secrets.sqlite`, atomically with its record in `configuration.sqlite`, because `-c` and other arguments may carry sensitive values. AgentStack-owned arguments and temporary paths are recreated at launch, not saved. The list operations continue to omit raw arguments.

Omitting `args` on an existing Server reuses its saved array. Explicit `[]` clears it. A live Server accepts an identical array idempotently but rejects a different one; a stopped Server accepts a new array while retaining its account, working directory, and main thread. The same rule applies to Bots through their Codex Server. Older SQLite and JSON records default to `[]` because previous versions did not persist caller arguments. Removal deletes the private argument record with the Server.
