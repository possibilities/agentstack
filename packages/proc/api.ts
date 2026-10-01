import { join } from "node:path";
import { operation, stateDir, stateDependencies, stateDependencyInput, requireStateOperator, type PackageApi } from "@stack/api";
import { z } from "zod";
import * as s from "./src/schema.js";
import { ProcService, newId, scheduleFromInput } from "./src/service.js";
import { ProcStore } from "./src/store.js";
import { withStateInventory, statePlan, stateApplyInput, stateReceipt } from "@stack/api";
import { procStateCategories } from "./src/state-categories.js";

type Context = { service: ProcService };
const read = { readOnlyHint: true, idempotentHint: true } as const;
const schedules = z.strictObject({ schedules: z.array(s.scheduleListItem) });
export const topics = {
  proc_schedules_changed: "A schedule or execution changed. Re-read proc_schedule_get or proc_execution_get.",
  proc_runs_changed: "A process run started, changed state or exited. Re-read proc_run_get.",
  proc_output_changed: "One process output line arrived (or output reached its bound). Read proc_run_read after the last cursor; notices contain no line text and may be coalesced.",
} as const;

const packageApi: PackageApi<Context, keyof typeof topics> = {
  operations: [
    operation({ name: "proc_history_plan", description: "Preview exact run_output, execution_content or removed schedule_definition redaction. Active records block; Brain schedules are protected. Schedule input, argv, env and cwd clear, but identity, authority, label, target, timing and spec digest remain. Captured executions/output are separate selections. Run/execution history keeps Proc's 30-day policy.",
      input: z.strictObject({ kind: z.enum(["run_output", "execution_content", "schedule_definition"]), ids: z.array(z.uuid()).min(1).max(100) }), output: statePlan,
      async call(ctx, { kind, ids }, invocation) { requireStateOperator(invocation); return ctx.service.store.historyPlan(kind, ids); } }),
    operation({ name: "proc_history_clear", description: "Apply exact terminal output, execution-content or removed schedule-definition cleanup atomically with its receipt. Output cursors disclose gaps; removed schedule reads expose contentClearedAt/specDigest. Preserve authority and outcome, including unknown. Active or protected Brain schedules refuse. Cancellation, removal and redaction are separate decisions.",
      input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
      async call(ctx, input, invocation) { requireStateOperator(invocation); const result = ctx.service.store.historyClear(input);
        for (const item of result.outcomes) { ctx.service.onRunsChanged?.(item.resource); ctx.service.onOutputChanged?.(item.resource); ctx.service.onSchedulesChanged?.(item.resource); } return result; } }),
    operation({ name: "proc_state_receipt_get", description: "Read a durable Proc cleanup receipt and its exact removed/retained resources. Receipts do not imply a process was cancelled or a schedule disabled.",
      input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: read,
      async call(ctx, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.service.store.maintenance.receipt(requestId) }; } }),
    operation({ name: "proc_bot_dependencies", description: "Inspect Bot-root schedules, in-flight executions and known cwd process writers for maintenance. Disabled schedules retain captured admissions. Unknown process exits remain blockers, never proof that the workspace is idle.",
      input: stateDependencyInput, output: stateDependencies, annotations: read,
      async call(ctx, { botId, cwd }, invocation) { requireStateOperator(invocation); return ctx.service.store.botDependencies(botId, cwd); } }),
    operation({ name: "proc_schedule_create", description: "Register an attributed one-shot or interval schedule; callers should set a short label naming its purpose. Bot authority persists across restarts and requires current MCP exposure for API targets; stopped Bots hold admissions. Caller ID deduplicates identical definitions with the same authority. Missed intervals coalesce. Process execution uses the owner's OS user and is not a sandbox.",
      input: s.scheduleCreate, output: s.scheduleRecord, annotations: { idempotentHint: false, openWorldHint: true },
      async call(ctx, { id, ...input }, invocation) { return ctx.service.createSchedule(id ?? newId(), scheduleFromInput(input), invocation); } }),
    operation({ name: "proc_schedule_update", description: "Replace a schedule at an exact revision without changing its authority. Bot callers manage only their own root's schedules; operator edits never promote Bot authority. Admitted executions retain their captured action and authority. System schedules are protected; legacy schedules require explicit reauthorization.",
      input: s.scheduleUpdate, output: s.scheduleRecord, annotations: { idempotentHint: false, openWorldHint: true },
      async call(ctx, { id, expectedRevision, ...input }, invocation) { return ctx.service.updateSchedule(id, expectedRevision, scheduleFromInput(input), invocation); } }),
    operation({ name: "proc_schedule_reauthorize", description: "Explicitly authorize an unattributed legacy schedule as the operator, supplying the reviewed definition and exact revision. Preserves its unknown creator and history. Cannot promote a Bot schedule or change a protected system schedule; create a new operator schedule instead.",
      input: s.scheduleUpdate, output: s.scheduleRecord, annotations: { openWorldHint: true },
      async call(ctx, { id, expectedRevision, ...input }, invocation) { return ctx.service.updateSchedule(id, expectedRevision, scheduleFromInput(input), invocation, true); } }),
    operation({ name: "proc_schedule_remove", description: "Stop future admissions of a schedule at an exact revision; retain execution history and a removed tombstone. Does not cancel a running invocation. Protected system schedules cannot be removed.",
      input: s.scheduleRevision, output: z.strictObject({ removed: z.literal(true) }), annotations: { destructiveHint: true },
      async call(ctx, { id, expectedRevision }, invocation) { return ctx.service.removeSchedule(id, expectedRevision, invocation); } }),
    operation({ name: "proc_schedule_get", description: "Read one schedule, including its due time and exact target. The action can contain sensitive input or environment overrides; treat the result accordingly. includeRemoved reads a removed schedule's retained tombstone.",
      input: s.scheduleGet, output: s.scheduleRecord, annotations: read,
      async call(ctx, { id, includeRemoved }, invocation) { return ctx.service.schedule(id, invocation, includeRemoved); } }),
    operation({ name: "proc_schedule_list", description: "List schedules with label, authority, next due time, blocked reason and up to 12 recent executions each, live schedules before removed tombstones when includeRemoved is set. Bots see only their own root's schedules; operators also see the protected Brain source trigger. Worker identities have no Proc ownership and are refused.",
      input: s.scheduleList, output: schedules, annotations: read,
      async call(ctx, { limit, includeRemoved }, invocation) { return { schedules: await ctx.service.schedules(limit, invocation, includeRemoved) }; } }),
    operation({ name: "proc_execution_get", description: "Read one scheduled invocation. A lost API response is unknown rather than blindly retried; a process execution links its process run ID.",
      input: s.executionId, output: s.executionRecord, annotations: read,
      async call(ctx, { id }, invocation) { return ctx.service.execution(id, invocation); } }),
    operation({ name: "proc_execution_list", description: "Read invocations of one schedule, or across all schedules when id is omitted, including failures and ambiguous outcomes. Pages newest first with nextCursor; since admits only starts at or after it. Deleting a schedule does not erase history. Bots see only their own root's executions.",
      input: s.executionList, output: s.executionPage, annotations: read,
      async call(ctx, { id, since, cursor, limit }, invocation) { return ctx.service.executions(id, { since, cursor, limit }, invocation); } }),
    operation({ name: "proc_run_start", description: "Admit one argv process under an IPC guardian. Required requestId deduplicates identical intent, including label. subscribe:true reserves an exact exit watch for the invoking sanctioned Bot Chat before execution; omission/false creates none. Inspect observation and subscription separately from admission. Output stays cursor-readable. No shell/PATH lookup; uses the owner's OS user, not a sandbox.",
      input: s.runStart, output: s.runStartResult, completionWatch: s.runWatch, annotations: { idempotentHint: true, openWorldHint: true },
      async call(ctx, input, invocation) { return ctx.service.admitRun(input, invocation); } }),
    operation({ name: "proc_run_completion", description: "Exact exit projection, null before admission and while active. Includes exited, failed, cancelled or unknown outcome, code/signal and timing; never argv, environment or output. Bot reads require the originating Chat and durable-root ownership. Unknown is not proven failure. Exit does not complete Work.",
      input: s.runId, output: s.runCompletion, annotations: read,
      async call(ctx, { id }, invocation) { return ctx.service.runCompletion(id, invocation); } }),
    operation({ name: "proc_run_get", description: "Read one process's durable exit state, label and process summary (arguments, cwd and environment variable names only). The summary is sensitive; treat it accordingly. Unknown means the guardian or service was interrupted; it is not a proven failure.",
      input: s.runId, output: s.runDetail, annotations: read,
      async call(ctx, { id }, invocation) { return ctx.service.runDetail(id, invocation); } }),
    operation({ name: "proc_run_list", description: "List process runs newest first, paged with nextCursor and an optional active/terminal state filter, returning each run's label and executable path but no arguments, environment or output. Bot callers see only runs owned by their durable root; operators see all runs.",
      input: s.runList, output: s.runPage, annotations: read,
      async call(ctx, { limit, state, cursor }, invocation) { return ctx.service.runs({ state, cursor, limit }, invocation); } }),
    operation({ name: "proc_run_read", description: "Read bounded stdout/stderr lines after a monotonic cursor. Partial lines are explicitly marked; gap and outputTruncated disclose lost or unretained output. Follow proc_output_changed for invalidation.",
      input: s.runRead, output: s.outputPage, annotations: read,
      async call(ctx, { id, after, limit }, invocation) { await ctx.service.run(id, invocation); return ctx.service.read(id, after, limit); } }),
    operation({ name: "proc_run_wait", description: "Wait at most 30 seconds for a line or terminal process state, returning the same cursor page as proc_run_read. A wait timeout does not cancel the run. This is an observation, not a second execution.",
      input: s.runWait, output: s.outputPage, annotations: read,
      async call(ctx, { id, after, limit, waitMs }, invocation) { await ctx.service.run(id, invocation);
        const result = await ctx.service.wait(id, after, limit, waitMs); await ctx.service.run(id, invocation); return result; } }),
    operation({ name: "proc_run_join", description: "Observe a process until exit or a bounded timeout, returning its exit record and a timedOut flag. No line wakes this wait; use proc_run_read for output. Direct socket callers must set a timeout beyond waitMs; observer timeout does not stop the process.",
      input: s.runJoin, output: s.runJoinResult, annotations: read,
      async call(ctx, { id, waitMs }, invocation) { await ctx.service.run(id, invocation);
        const result = await ctx.service.join(id, waitMs); await ctx.service.run(id, invocation); return result; } }),
    operation({ name: "proc_run_cancel", description: "Request termination of a live process group. Read proc_run_get or proc_run_wait to establish the terminal outcome; cancelling a completed run is a no-op.",
      input: s.runId, output: s.runRecord, annotations: { idempotentHint: true, destructiveHint: true },
      async call(ctx, { id }, invocation) { await ctx.service.run(id, invocation); return ctx.service.cancel(id); } }),
    operation({ name: "proc_status", description: "Read Proc's capacity, sweep health, schedule counts and retention/output limits. Bots see counts only for their own root's schedules; capacity is shared.",
      input: z.strictObject({}), output: s.procStatus, annotations: read,
      async call(ctx, _input, invocation) { return ctx.service.status(invocation); } }),
  ],
  events: { topics, scope: { description: "Optional schedule or run ID; omit for all Proc changes.", example: "00000000-0000-4000-8000-000000000001",
    valid(_ctx, scope) { return z.uuid().safeParse(scope).success; } }, start(ctx, publish) {
    ctx.service.onSchedulesChanged = (id) => publish("proc_schedules_changed", id);
    ctx.service.onRunsChanged = (id) => publish("proc_runs_changed", id);
    ctx.service.onOutputChanged = (id) => publish("proc_output_changed", id);
    return () => { ctx.service.onSchedulesChanged = undefined; ctx.service.onRunsChanged = undefined; ctx.service.onOutputChanged = undefined; };
  } },
  async createContext(env) { const service = new ProcService(new ProcStore(join(stateDir(env), "proc")), env); service.start(); return { service }; },
  prepareCloseContext(ctx) { ctx.service.prepareClose(); },
  async closeContext(ctx) { await ctx.service.close(); },
};
export const api = withStateInventory("proc", procStateCategories, packageApi);
