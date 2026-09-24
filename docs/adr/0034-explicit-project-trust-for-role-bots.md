# 34. Select project MCP through explicit Role trust

Status: accepted, 2026-09-24. Extends [ADR 0030](0030-single-role-package.md)'s one Role and [ADR 0031](0031-role-resources.md)'s private Bot launch snapshot. Implemented with codexnk-v0.1.3, which accepts `[projects]` from `--capabilities/config.toml` while excluding home-level skills and personal plugin marketplaces.

The Role stores revision-checked, enabled or disabled canonical project roots with stable IDs. `project_create`, `project_update`, `project_delete`, and `project_reorder` manage them. A Bot launch emits `trust_level = "trusted"` only for enabled roots containing its canonical working directory; it never trusts every custom cwd or imports the operator's personal Codex trust choices. The fork can then load that project's `.codex/config.toml` and MCP servers, alongside intentionally retained project skills. AgentStack's existing role-owned and internal MCP entries remain in the private launch config. The trust decision is a launch snapshot; a running Bot does not change when a Role entry is edited.

Trusting a project is broader than adding one MCP definition: other project config in that root may become active. Pinning and installing the new runtime prepares future Bot launches; an already running Bot does not load it until a separately authorized Bot stop/start or owner restart.
