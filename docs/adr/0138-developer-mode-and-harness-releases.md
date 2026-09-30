# 138. Global developer mode gates upstream harness-release observations

Status: accepted, 2026-09-30. Extends the server-owned observations of
[ADR 0131](0131-codex-tools-availability.md) and the state inventory of
[ADR 0135](0135-owner-state-maintenance.md). Global Stack settings are separate
from the managed Bot and Worker runtime preferences of
[ADR 0128](0128-managed-runtime-settings.md).

## Decision

The `serve` Package API owns durable, revisioned global Stack settings. Its first
setting is `developerMode`, defaulting to `false`. A local operator explicitly
saves the switch, which applies to the server's developer features immediately.
It is not a Role selection, a Bot/Worker default, an environment-only development
flag or a browser-local preference. Future global settings and developer features
can extend this boundary without inventing another settings owner.

`serve_settings_read` returns `{developerMode, revision, updatedAt}`;
`serve_settings_update` requires `{developerMode, expectedRevision}` and returns
the saved value. Missing state has revision zero; current-revision unchanged
writes are no-ops. Settings live in `<STACK_STATE_DIR>/serve/settings.json`.

The first developer feature observes public upstream release channels for
OpenCode V2, Codex, Claude Code and Devin CLI. A server-owned, single-flight
observation loop runs only while developer mode is enabled. Reading returns
cached observations without fetching. An explicit check returns on admission;
payload-free events invalidate settings and release snapshots independently.
Disabling the setting cancels recurrence and fences in-flight completion; release
reads and check admission refuse while disabled. Re-enabling retains prior
evidence and resumes the observation cadence.

`serve_harness_releases` reads the snapshot; `serve_harness_releases_check`
returns `{admitted, startedAt}` and joins an existing check. The independent
events are `serve_settings_changed` and `harness_releases_changed`. The interval
is six hours from the last attempt, with a 15-second timeout and a 256-KiB
response limit per source. The cache lives in
`<STACK_STATE_DIR>/serve/harness-releases.json`; both state files use private
atomic writes. Invalid settings fail closed and cache errors remain explicit.

These observations follow fixed public metadata sources:

| Harness | Channel |
| --- | --- |
| OpenCode V2 | `https://registry.npmjs.org/@opencode/cli/latest` |
| Codex | `https://registry.npmjs.org/@openai/codex/latest` |
| Claude Code | `https://registry.npmjs.org/@anthropic-ai/claude-code/latest` |
| Devin CLI | `https://static.devin.ai/cli/current/manifest.json` |

OpenCode's [V2 installation documentation](https://opencode.ai/v2/docs/) names
`@opencode/cli`; the legacy `opencode-ai` package is a different channel. Devin's
[official installer](https://cli.devin.ai/install.sh) names its `current` manifest.
The checker reads metadata only, with bounded requests and validated versions;
it never downloads or executes an installer.

Each harness retains its last successful upstream observation, previous observed
version/change evidence, attempt and success timestamps, and explicit failure and
freshness state. Partial failures remain independent. The first observation is a
baseline; a changed version means the observed upstream channel changed, not that
the operator's installation is behind. Nothing infers an installed version from
the codexnk fork pin, the Claude Agent SDK version, a running Worker or a package
release. This feature does not install upgrades or change running runtimes.

The loop is server observation sampling, analogous to the resource monitor,
rather than a user-authored Proc schedule. It runs within Stack's existing server
process and closes with that context. Persisted observations survive restarts;
freshness and the due time derived from the retained last attempt distinguish
retained evidence from a fresh check. No independent OS daemon or browser is
required.

## API and presentation boundary

The private socket and local operator WebSocket expose the settings and feature
operations. MCP and remote Access do not gain developer controls. Manifests and
static discovery keep declaring the contract under
[ADR 0096](0096-explicit-transport-exposure.md); the live developer-mode gate is
enforced by handlers, including calls on an already-open connection. Disabling
mode cannot be bypassed by keeping a window or connection open.

All UI implementation is deferred to the human-requested UI developer handoff.
The intended placement is a general Stack settings control in System's Server
window, available while developer mode is off, and a conditional Developer window
in System with a Harness releases section. The UI must use authoritative settings
and observation events, fence late results on disable, and distinguish upstream
changes from installed updates. Existing operation shapes remain intact.
