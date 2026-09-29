# Default role

Every newly launched Bot receives the Bot default Role (initially Manager). A new Worker captures the Worker default (initially Worker) unless `worker_start.roleId` explicitly selects another existing Role. `roles_snapshot` returns both `defaultRoleId` and `workerDefaultRoleId`. Fresh stores provision both Roles, initially empty and independent, with no Worker instruction fragments. Older Role databases are **not** upgraded on startup; inspect one while the server is stopped, archive it for a fresh start if empty, or convert it explicitly offline if it contains content. Future edits to Manager and Worker do not sync. Use `role_set_default` for Bot launches and `role_set_worker_default` for Workers; neither changes running sessions. The two defaults cannot be deleted until reassigned. Read `role_snapshot {roleId}` for its `revision`, ordered categories, fragments, skills, additional MCP servers, and trusted project roots. Pass the Role ID and its revision as `expectedRevision` on every content edit. A stale revision fails without changing state; read again before retrying an intentional edit.

Use `category_create`, `category_update`, `category_delete`, and `category_reorder` to manage categories. Use `fragment_create`, `fragment_update`, `fragment_delete`, `fragment_reorder`, and `fragment_move` for their fragments. `fragment_create` appends unless given a zero-based `index`. `fragment_move` atomically places a fragment at an `index` of any category, counting that category's other fragments; updating `categoryId` instead appends it there. Categories and fragments report `createdAt` and `updatedAt` in Unix milliseconds, null for records saved before timestamps were kept; reordering does not change `updatedAt`. A reorder supplies every current ID in the relevant list exactly once. Deleting a category with fragments is refused. Empty bodies are useful as drafts and do not render. Disabling a category suppresses all its fragments. Titles and descriptions never appear in the prompt.

Use `skill_create`, `skill_update`, `skill_delete`, and `skill_reorder` to manage role-owned skills. A skill has a unique lowercase `name`, a description, a Markdown `body`, an `enabled` flag, and optional supporting `files` (`path`, `contentBase64`). Stack generates the `SKILL.md` frontmatter from the name and description; `body` does not include that frontmatter. `files` on update replaces the complete supporting-file set. Paths are relative to that skill and cannot traverse directories or replace `SKILL.md`. Only enabled skills are written under the private launch `skills/` directory. Disabled skills remain editable in the Role.

Use `mcp_server_create`, `mcp_server_update`, `mcp_server_delete`, and `mcp_server_reorder` for additional role MCP servers. Each has a unique name, description, enabled flag, and a complete `definition`: HTTP (`type: "http"`, `url`, optional `bearerTokenEnvVar`, `httpHeaders`, `envHttpHeaders`) or stdio (`type: "stdio"`, `command`, `args`, optional `env`, `envVars`). Updating `definition` replaces it. Enabled definitions join the internal Package API MCP connections in `config.toml` on the next Bot launch. An additional server cannot take a currently configured internal Package API name or address the server's MCP listener. A launch skips disabled servers before checking them; an enabled server that clashes stops the launch. Ordinary snapshots and mutation replies return MCP server summaries with `transport`, omitting definitions. The operator UI uses the socket/WebSocket-only `role_editor_snapshot` for complete definitions; native launch uses socket-only `role_launch_snapshot`. Keep credentials in environment references where possible.

Use `project_create`, `project_update`, `project_delete`, and `project_reorder` to explicitly authorize project roots. Give the project root as an absolute directory path; Stack stores its canonical path. An enabled entry is written as `[projects."<root>"] trust_level = "trusted"` only for a Bot whose launch `cwd` is inside that root. A disabled or unrelated entry is not placed in that Bot's private `config.toml`. The pinned codexnk release trusts the project's `.codex/config.toml` layer—including its MCP definitions and other project settings—rather than copying its MCP servers into the Role. A running Bot keeps its launch decision until restarted.

`role_preview {roleId}` returns the exact rendered developer instructions and revision, their UTF-8 `bytes` against `limitBytes`, and `segments` giving each rendered fragment's `[start, end)` string offsets; the blank-line separators belong to no segment. A change Event, `role_changed`, tells subscribers to read another snapshot after subscribing or reconnecting. Changes are saved immediately, but running sessions keep their launch snapshot. `bot_list` and Worker reads report the applied `roleId` and `roleRevision`; compare both with the catalog and selected Role's revision, never just revision numbers across different Roles. Restarting a Bot resolves the current default, whereas a Worker keeps its snapshot on recovery.

`role_launch_preview {roleId}` reports the selected Role's launch resources: enabled skills with file counts and sizes, the internal and Role MCP server names, the `config.toml` tables the Role contributes to Bot launches, enabled trusted project roots, and for each absolute path in `cwds` the enabled roots that contain it. Its `issues` name any enabled Role MCP server that would stop a launch, and `snapshotChars` measures the complete Role against the `snapshotLimitChars` write budget. Because its configuration can contain credentials, this preview is available over socket/WebSocket but excluded from MCP. Workers receive the selected Role's enabled instructions, skills and MCP connections, but not Bot-specific trusted-project config.

For Bots, Stack materializes `SYSTEM_APPEND.md`, the enabled Role and internal MCP entries in `config.toml`, and enabled Role skills under `skills/` in a private per-launch path passed to codexnk's `--capabilities`. For Workers, Stack passes the captured MCP definitions to ACP `session/new` (or the Claude SDK), stages enabled skills in the private worktree or SDK plugin, and delivers rendered instruction fragments once on the first ACP task or as a Claude SDK system-prompt append. Follow-up turns do not repeat the instructions; recovery reuses the saved Role snapshot. Codexnk also discovers project skills, bundled skills, and explicitly added roots; home-level `~/.agents/skills` and personal plugin marketplaces are excluded for a three-axis Bot launch. The Role is not an exclusive allowlist for project or system capabilities.

## Inject into a native CLI

With Stack running, launch a fresh native session using the default or a named Role:

```sh
stack roles inject -- claude
stack roles inject default -- codex
stack roles inject "Research" -- opencode
stack roles inject "Research" -- codex exec --model gpt-5.6-sol "Review this change"
```

Omission and literal `default` select the catalog-marked default. Other names
match ASCII case-insensitively; an unknown name fails. Executables resolve from
`PATH`. The invocation receives the selected Role's enabled skills, supporting
files, internal and additional MCP connections, and rendered instruction
fragments. It uses local operator authority for internal MCPs and does not create
a Bot or Worker. MCP environment references resolve from the launching process.

Role resources are materialized privately and removed after the native processes
exit. Ambient personal capabilities are excluded; ordinary harness configuration
is not rewritten. Native built-ins and administrator policy remain applicable.
Codex can still discover project resources, and its private `HOME` changes home
expansion and home-based tool configuration. This is capability isolation, not a
sandbox or a restriction on what the agent can read with its tools.

Authentication remains independent of the selected Role. Claude retains native
keychain/environment authentication, but settings-based auth helpers are not
imported. Codex requires an existing file-backed `CODEX_HOME/auth.json` (normally
`~/.codex/auth.json`); an auth-only symlink preserves native refresh writes.
Keyring-only Codex login is unsupported. OpenCode retains its ordinary native
credential database, selection and refresh handling. Its private server uses
pinned native packages and requires the matching stable **OpenCode 2.0.16** CLI;
a mismatch fails before the server opens the database.

Only fresh foreground launches are supported. Resume, attachment, background
modes and capability/configuration overrides are refused, as are unrecognized
native options. Normal model, effort, prompt, output and permission options are
supported; use `stack roles inject --help` for the current contract. Native UI
history selection after startup is still possible. Claude and OpenCode retain
their ordinary native history; Codex history is retained under
`<STACK_STATE_DIR>/roles/inject`, whose path is printed on exit. SIGKILL cannot
guarantee cleanup of generated files.

The design and OpenCode's pre-boot configuration boundary are recorded in
[ADR 0123](adr/0123-role-injection-for-native-clis.md).
