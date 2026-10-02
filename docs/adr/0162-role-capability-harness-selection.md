# 162. Select Role capabilities by the actual launch harness

Status: accepted, 2026-10-01. Extends [ADR 0031](0031-role-resources.md),
[ADR 0119](0119-per-role-internal-mcp.md) and
[ADR 0123](0123-role-injection-for-native-clis.md). Supersedes the `computer-use`
connection name in [ADR 0129](0129-codex-tools-in-default-mcp-fleet.md), not its
bridge ownership, approvals or transport contract.

## Decision

Skills and additional MCP connections have an optional `harnesses` allowlist.
Internal connections keep their independent enabled switch and store explicit
allowlists in `internalMcpHarnesses`, keyed by connection name. Null or omission
on creation means unrestricted; `[]` means no harness; a nonempty list selects
only its named harnesses. Updates preserve omitted fields, replace supplied
lists and clear a restriction with null. Invalid names and duplicates are refused.
All writes retain the Role revision fence and `role_changed` invalidation.

The finite launch identities are `codex`, `opencode`, `claude` and `devin`:

- Bots materialize capabilities for `codex`.
- Worker admission uses `opencode` for its Codex account backend, `claude` for
  the Claude Agent SDK, and `devin` for Devin ACP.
- `stack roles inject` uses the selected native executable's harness identity.

One shared resolver selects enabled resources before writing skill files,
resolving MCP commands/credentials or constructing native connections. A matching
allowlist never enables a disabled resource. Worker captures retain the full
Role, including unselected resources and allowlists; explicit recovery selects
from that capture, not the current Role or default. Existing sessions are not
reconfigured by later edits. Trusted project roots retain their Bot-only contract.

Capability selection is independent of fragment conditions. `context.harness`
and `--with-harness` still supply render-only context and cannot impersonate the
actual launcher. A Claude model running in OpenCode selects `opencode`, not
`claude`. The `claude` selection does not promise interactive Claude Code built-ins
to an SDK Worker. No native computer-use backend is selected or enabled here.

`role_launch_preview` and `role_internal_mcp_list` accept an optional `harness`.
An unspecified harness selects only unrestricted enabled capabilities; restricted
ones are reported as `harness_required` or, for `[]`, `harness_mismatch`. Previews
return the requested harness, selected resources and config, explicit exclusions
with reasons, and each internal connection's stored switch, allowlist, effective
`included` flag and `selectionReason`. Instruction counts still use the independent
rendering context. Selection is configuration, not transport exposure, tool
availability, execution authority or an OS sandbox.

## Computer bridge compatibility

The catalog and all newly generated launch configurations expose
`codex-computer-use` / “Codex Computer Use”. Claude Code reserves `computer-use`
for its native integration, so Stack no longer emits that key. The bridge still
uses the installed Codex REPL and `@oai/sky` without an inference turn.

The Roles owner adds nullable resource columns and the internal allowlist table
transactionally. Existing resources stay unrestricted and their revisions,
bytes, order, IDs and defaults are preserved. Stored `computer-use` exclusions
move to the new key without re-enabling the connection. Read-only injection can
read pre-filter stores as unrestricted and normalize the legacy exclusion without
migrating the database. Older Worker captures normalize that name on selection.
Previously captured stdio launches can still resolve the old bridge spelling;
discovery and new configurations advertise only the new name. Neither name can
be used by an additional Role MCP connection to alias the internal bridge.

## UI boundary and verification

Existing UI types, duplication semantics and launch status text track the changed
records. The Launch view distinguishes stored enablement from inclusion and states
that its unspecified-harness preview contains unrestricted capabilities only.
New filter editors and a separate capability-harness preview selector are deferred
to a UI handoff, not added implicitly. The instruction-context controls remain
render-only.

Verification covers revisioned persistence and clearing through the socket API,
read-only compatibility and owner upgrades, actual private Bot/CLI capability
files, and captured MCP/skill selection at Worker admission and recovery. Native
boundary fixtures use disposable state and no inference or real credentials;
they do not prove availability or consent for live desktop tools.
