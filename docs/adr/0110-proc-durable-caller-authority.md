# 110. Proc schedules retain durable caller authority

Status: accepted, 2026-09-28. Supersedes the operator-context dispatch decision in [ADR 0105](0105-proc-local-scheduling-and-process-control.md). Implements the approved first hardening-review proposal.

## Decision

Proc assigns each schedule immutable `createdBy`, editable-attribution `lastEditedBy`, and a separate `authority`. Authorities are the operator, a Bot bound to `{ botId, mainThreadId, threadId }`, or the protected `brain-source-sync` system task. Callers cannot supply these fields. Bot callers must have a verified live instance and a thread in their sanctioned root's lineage. Anonymous local MCP retains its existing operator meaning; Worker-bound callers have no Proc ownership contract and are refused rather than promoted to operator authority.

Bots may read and manage only schedules, executions and process runs owned by their durable root. Ownership checks cover ID-based reads, list filters, process output and cancellation; filtering happens before list limits. Operators may read all records and manage non-system schedules. An operator edit preserves a Bot schedule's authority. Promotion requires creating a new operator-owned schedule. Process execution still uses the owner's OS user and is not a sandbox.

Bot API targets must be selected by the current MCP manifest and live socket catalog at admission and dispatch, using the shared exposure resolver without constructing target contexts. Proc cannot schedule itself. Immediately before admission, Proc verifies the captured root, sanctioned thread and current Bot launch. It sends explicit private-socket `transport: "proc"` provenance with the schedule and execution IDs, authority and resolved live instance; it never synthesizes an MCP launch proof. Targets retain normal authorization, including operator-only account guards and Worker/Browser ownership checks. Operator schedules remain operator calls; the protected system schedule remains bound to Brain's due-only source sync.

An unavailable or stopped Bot, unavailable thread or withdrawn target exposure holds the pending occurrence with `blockedReason` and a persisted retry time, at most once per 30 seconds. Returning with a valid launch resumes the pending occurrence; overdue intervals coalesce from actual admission time. A missing Bot or changed root blocks without automatic retry. Edits retain the original authority. Revision and due-time fencing prevents a schedule edited or removed during asynchronous authorization from dispatching its old definition. Each admitted execution captures its action and authority. Removal retains a tombstone for authorized history access and prevents reusing its ID for a different owner.

Pre-admission refusal is a definite blocked schedule, with no admitted execution or consumed one-shot. A shutdown refusal after admission but before socket dispatch is `refused`. Once dispatched, a lost response or unclassified downstream error remains `unknown`, because a target may fail output validation after performing effects. Neither becomes an automatic replay. A bounded later interval is independent. Shutdown drains in-flight authorization before closing the store.

## Migration

Proc schema v2 migrates its own v1 database transactionally. Existing definitions and execution/run history remain. Unattributed schedules are marked `createdBy: { kind: "legacy_unknown" }`, receive null authority, have future admissions disabled, and require `proc_schedule_reauthorize`. That operator-only operation takes a reviewed complete definition and expected revision, preserves the unknown creator, and assigns operator authority. It cannot promote a Bot schedule. Only the exact recognized protected Brain schedule retains automatic authority. Legacy execution authority and action remain null, rather than inventing historical attribution.

## UI

The existing live API reference discovers the new schemas and reauthorization operation. Proc still has no dedicated schedule/run window or reauthorization controls. A System-space view remains a separate human decision.
