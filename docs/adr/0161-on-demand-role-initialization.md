# 161. Initialize missing Roles on demand without a Server

Status: accepted, 2026-10-01. Supersedes only the existing-store prerequisite for
Role injection in [ADR 0146](0146-server-independent-internal-mcp.md). Extends
[ADR 0124](0124-manager-and-worker-launch-defaults.md) with a shared initialization
entry point; Role selection, native isolation and managed launch lifecycles remain
unchanged.

## Decision

`stack roles inject` and the Roles owner at Server startup can initialize an absent
`<STACK_STATE_DIR>/roles.sqlite` with the normal independent Manager and Worker
defaults. Injection requires neither a running Server nor a separate initialization
flag. It opens the resulting catalog read-only and uses the same named/default
selection and renderer as before. Standalone MCP reads remain read-only and do not
initialize missing stores.

The shared initializer prepares and closes a complete private SQLite database
before publishing it with an exclusive filesystem link. Concurrent Server and
injection initializers adopt the same winning catalog, including its stable Role
IDs and defaults; an existing filesystem entry is never replaced. An existing
legacy `capabilities.sqlite` prevents fresh initialization and requires explicit
offline inspection or conversion. Injection never repairs, migrates or replaces
an empty, corrupt or incompatible existing store.

Private capability files are derived launch material, not an independent Role
configuration. Every injection captures the current Role revision and regenerates
instructions, skills and MCP connections for that invocation. Role edits reach the
next invocation without a Server restart or a regeneration command; already running
native sessions retain their captured capabilities. Bot and Worker snapshots keep
their existing launch/application rules.

## Consequences and verification

The first injection can provision the local catalog without starting platform
listeners, supervisors or background workers. Arbitrary unknown Role names still
fail instead of creating empty named Roles. Existing storage and authored resources
are preserved; no ambient configuration or legacy store is imported.

Process-level injection checks cover missing storage, subsequent server reuse,
regeneration after edits and refusal without modification of existing invalid
storage. Concurrent owner/injection processes establish one complete catalog and
unchanged default identities. Tests use disposable state and native-boundary
fixtures without model requests or real credentials.
