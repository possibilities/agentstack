# 123. Inject a Role into one native CLI invocation

Status: accepted, 2026-09-29. Extends [ADR 0118](0118-multiple-roles-and-default.md)
and [ADR 0119](0119-per-role-internal-mcp.md) with a local operator launch path.
The Bot and Worker delivery contracts, including
[ADR 0122](0122-worker-role-selection-without-instructions.md), remain independent.

## Decision

The Roles package owns `stack roles inject [default|role-name] --
<claude|codex|opencode> [native args...]`; the Stack CLI dispatches to it.
Omission or literal `default` selects the catalog's designated default. Another
name resolves with the catalog's ASCII case-insensitive naming semantics. The
launcher captures a complete Role snapshot through the existing socket API.
Unknown names fail rather than falling back to the default.

This operator invocation receives enabled skills and their supporting files,
enabled internal and additional MCP connections, and the exact rendered enabled
instruction fragments. Internal MCP connections use local operator authentication;
launching a native CLI creates neither a Bot nor a Worker identity. A later Role
edit affects later invocations, not the captured snapshot.

## Fragment conditionality

Conditionality is first-class fragment metadata, separate from the body and
enabled state. `conditions: { model?: string, harness?: string }` is its first
contract. Every present dimension must equal its explicit rendering-context
value, case-sensitively. Missing context fails a condition; `{}` is unconditional.
Values are nonblank strings of at most 200 characters, preserved verbatim.
Unknown dimensions are rejected rather than silently ignored. New dimensions
can extend this shared contract later; expressions, OR, patterns and negation
are not part of this version.

`fragment_create` accepts conditions; `fragment_update` replaces the entire
object, preserves it when omitted, and clears it with `{}`. All snapshot reads
retain conditions. Current stores always return an object; older captured
snapshots without it remain unconditional. A transactional additive SQLite
upgrade gives existing fragments `{}` without changing revisions or content.
Writes conservatively enforce the instruction byte limit over all enabled
nonblank fragments regardless of conditions, so every context stays bounded.

The shared renderer and `role_preview` / `role_launch_preview` accept optional
`context: { model?: string, harness?: string }`. Preview text, spans, byte counts
and fragment counts reflect that context. Snapshot reads remain complete and
unfiltered, and `role_changed` continues to invalidate them after writes.

`stack roles inject [role-name] [--with-model VALUE] [--with-harness VALUE] --
<claude|codex|opencode> ...` supplies this context only to instruction rendering.
Flags can occur before or after the Role name, accept `=VALUE`, and cannot be
repeated. Neither value is inferred from the native command or its model flags.
They neither select an executable/model nor add arguments to the native command.
All native delivery paths receive the same selected instruction bytes. Existing
Bot and Worker callers that supply no context render only unconditional bodies;
automatic context inference for those lifecycles is a separate decision.

Capabilities are private to the invocation. The launcher excludes ambient
personal configuration and does not install Role resources into ordinary native
configuration directories. Even an empty Role uses the isolation path. Native
built-ins and administrator policy remain native concerns; capability discovery
is not an OS sandbox. Configuration and attachment arguments that bypass this
boundary are refused explicitly.

## Native delivery and authentication

Authentication is orthogonal to Role selection. The launcher does not select a
Stack account or introduce a Role-specific login workflow.

- Claude uses explicit plugin, instruction and strict MCP arguments, disabled
  filesystem setting sources, and disabled automatic memory discovery. Native
  authentication remains in its ordinary location.
- Codex uses private `HOME` and `CODEX_HOME` directories to separate home skill
  discovery from its per-invocation configuration. Its native file-auth record
  is linked independently of capability files, preserving native credential
  refresh writes. The launcher does not copy the ordinary configuration.
- OpenCode uses a private, authenticated loopback server built with matching
  pinned native packages. Before service construction, it replaces only the
  well-known configuration source with an empty, non-writable source. Native
  credential selection and persistence keep the ordinary database. Private
  filesystem configuration and disabled compatibility and instruction discovery
  supply the Role; a private context hook appends its instructions.

OpenCode's CLI flags alone cannot provide this boundary: its ordinary database
contains both credentials and well-known capability sources. A copied login in
a separate database would introduce independent refresh state. A late plugin
cannot exclude ambient modules before they are imported. The pre-boot service
replacement avoids both problems without an upstream patch or credential
synchronization service. Its tradeoff is a substantial pinned native dependency
tree and a private server lifecycle owned by the launcher.

## Verification boundary

Disposable native probes establish Role resources present, synthetic ambient
resources absent, and ordinary configuration still available after exit. The
OpenCode proof additionally establishes identical native credential selection
and shared native persistence without copying OAuth values. Probes use fake
credentials and no model requests. Context-hook registration and native source
contracts establish instruction delivery without spending a model turn.
