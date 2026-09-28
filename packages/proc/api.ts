import { join } from "node:path";
import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { z } from "zod";
import * as s from "./src/schema.js";
import { ProcService, newId, scheduleFromInput } from "./src/service.js";
import { ProcStore } from "./src/store.js";

type Context = { service: ProcService };
const read = { readOnlyHint: true, idempotentHint: true } as const;
const schedules = z.strictObject({ schedules: z.array(s.scheduleRecord) });
const executions = z.strictObject({ executions: z.array(s.executionRecord) });
const runs = z.strictObject({ runs: z.array(s.runRecord) });
export const topics = {
  proc_schedules_changed: "A schedule or execution changed. Re-read proc_schedule_get or proc_execution_get.",
  proc_runs_changed: "A process run started, changed state or exited. Re-read proc_run_get.",
  proc_output_changed: "One process output line arrived (or output reached its bound). Read proc_run_read after the last cursor; notices contain no line text and may be coalesced.",
} as const;

export const api: PackageApi<Context, keyof typeof topics> = {
  operations: [
    operation({ name: "proc_schedule_create", description: "Register an attributed one-shot or interval schedule. Bot authority persists across restarts and requires current MCP exposure for API targets; stopped Bots hold admissions. Caller ID deduplicates identical definitions with the same authority. Missed intervals coalesce. Process execution uses the owner's OS user and is not a sandbox.",
      input: s.scheduleCreate, output: s.scheduleRecord, annotations: { idempotentHint: false, openWorldHint: true },
      async call(ctx, { id, ...input }, invocation) { return ctx.service.createSchedule(id ?? newId(), scheduleFromInput(input), invocation); } }),
    operation({ name: "proc_schedule_update", description: "Replace a schedule at an exact revision without changing its authority. Bot callers manage only their own root's schedules; operator edits never promote Bot authority. Admitted executions retain their captured action and authority. System schedules are protected; legacy schedules require explicit reauthorization.",
      input: s.scheduleUpdate, output: s.scheduleRecord, annotations: { idempotentHint: false, openWorldHint: true },
      async call(ctx, { id, expectedRevision, ...input }, invocation) { return ctx.service.updateSchedule(id, expectedRevision, scheduleFromInput(input), invocation); } }),
    operation({ name: "proc_schedule_reauthorize", description: "Explicitly authorize an unattributed legacy schedule as the operator, supplying the reviewed definition and exact revision. Preserves its unknown creator and history. Cannot promote a Bot schedule or change a protected system schedule; create a new operator schedule instead.",
      input: s.scheduleUpdate, output: s.scheduleRecord, annotations: { openWorldHint: true },
      async call(ctx, { id, expectedRevision, ...input }, invocation) { return ctx.service.updateSchedule(id, expectedRevision, scheduleFromInput(input), invocation, true); } }),
    operation({ name: "proc_schedule_remove", description: "Stop future admissions of a schedule at an exact revision; retain execution history. Does not cancel a running invocation. Protected system schedules cannot be removed.",
      input: s.scheduleRevision, output: z.strictObject({ removed: z.literal(true) }), annotations: { destructiveHint: true },
      async call(ctx, { id, expectedRevision }, invocation) { return ctx.service.removeSchedule(id, expectedRevision, invocation); } }),
    operation({ name: "proc_schedule_get", description: "Read one schedule, including its due time and exact target. The action can contain sensitive input or environment overrides; treat the result accordingly.",
      input: s.scheduleId, output: s.scheduleRecord, annotations: read,
      async call(ctx, { id }, invocation) { return ctx.service.schedule(id, invocation); } }),
    operation({ name: "proc_schedule_list", description: "List schedules with authority, attribution, next due time and blocked reason. Bots see only their own root's schedules; operators also see the protected Brain source trigger. Worker identities have no Proc ownership and are refused.",
      input: s.list, output: schedules, annotations: read,
      async call(ctx, { limit }, invocation) { return { schedules: await ctx.service.schedules(limit, invocation) }; } }),
    operation({ name: "proc_execution_get", description: "Read one scheduled invocation. A lost API response is unknown rather than blindly retried; a process execution links its process run ID.",
      input: s.executionId, output: s.executionRecord, annotations: read,
      async call(ctx, { id }, invocation) { return ctx.service.execution(id, invocation); } }),
    operation({ name: "proc_execution_list", description: "Read recent invocations of one schedule, including failures and ambiguous outcomes. Deleting a schedule does not erase history.",
      input: s.scheduleId.extend({ limit: s.list.shape.limit }), output: executions, annotations: read,
      async call(ctx, { id, limit }, invocation) { return { executions: await ctx.service.executions(id, limit, invocation) }; } }),
    operation({ name: "proc_run_start", description: "Admit one directly executed argv process under an IPC guardian. Request ID is required for idempotent admission. No shell or PATH lookup; stdout and stderr are framed into bounded lines. This executes with the local owner's user authority, not a sandbox.",
      input: s.runStart, output: s.runRecord, annotations: { idempotentHint: true, openWorldHint: true },
      async call(ctx, { requestId, process }, invocation) { return ctx.service.startRun(process, null, requestId, await ctx.service.policy.actor(invocation)); } }),
    operation({ name: "proc_run_get", description: "Read one process's durable exit state, output counts and truncation flag. Unknown means the guardian or service was interrupted; it is not a proven failure.",
      input: s.runId, output: s.runRecord, annotations: read,
      async call(ctx, { id }, invocation) { return ctx.service.run(id, invocation); } }),
    operation({ name: "proc_run_list", description: "List recent direct and scheduled process runs with attribution, without command arguments or output bodies. Bot callers see only runs owned by their durable root; operators see all runs.",
      input: s.list, output: runs, annotations: read,
      async call(ctx, { limit }, invocation) { return { runs: await ctx.service.runs(limit, invocation) }; } }),
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
