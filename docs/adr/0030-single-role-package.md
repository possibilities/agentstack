# 30. Name the single launch configuration a Role

Status: accepted, 2026-09-24. Supersedes the public `capabilities` package, `bundle_*` operations, and `bundle_changed` event of [ADR 0027](0027-default-capabilities-bundle.md). Retains its fragment ordering, revision preconditions, launch snapshot, and owner MCP behavior.

AgentStack configures one Role for every newly launched Bot. The `roles` Package API reads it with `role_snapshot`, previews rendered instructions with `role_preview`, and publishes `role_changed`; category and fragment CRUD keep their existing operation names and behavior. Bot views report `roleRevision`. The owner serves the `roles` socket, MCP, and WebSocket paths in place of `capabilities` and supplies its bound MCP URL to Bots. The canvas and markdown twins show the new names through discovery without adding controls.

The store moves `capabilities.sqlite` to `roles.sqlite` on first open, preserving all categories, fragments, and revisions. It refuses two competing files rather than choosing one silently. The Bot store migrates saved `capabilities_root` and `capabilities_revision` to role columns once; legacy launch roots are accepted during cleanup of a recorded process. New snapshots live under `<state>/roles/<bot-id>/`. These migrations are applied when the owner next starts after the old processes have stopped.

The pinned codexnk runtime still calls its input `--capabilities` and reads `SYSTEM_APPEND.md`, `config.toml`, and `skills/`; the native flag is not an AgentStack naming decision. Clients of the old Package API path, operation names, event, or bot output field must update. There is no alias. This phase changes the name and preserves behavior; skill and additional MCP CRUD extend the Role later.
