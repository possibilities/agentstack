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
    operation({ name: "proc_schedule_create", description: "Register a durable one-shot or interval schedule for one Package API operation or process. Caller ID deduplicates identical requests; a different definition at that ID is refused. At most one invocation per overdue interval is admitted after downtime.",
      input: s.scheduleCreate, output: s.scheduleRecord, annotations: { idempotentHint: false, openWorldHint: true },
      async call(ctx, { id, ...input }) { const spec = scheduleFromInput(input); await ctx.service.validate(spec.action);
        const record = ctx.service.store.createSchedule(id ?? newId(), spec); ctx.service.onSchedulesChanged?.(record.id); return record; } }),
    operation({ name: "proc_schedule_update", description: "Replace a schedule's definition at an exact revision. An already admitted execution continues with its own captured action; this changes only future due times. Protected system schedules cannot be edited.",
      input: s.scheduleUpdate, output: s.scheduleRecord, annotations: { idempotentHint: false, openWorldHint: true },
      async call(ctx, { id, expectedRevision, ...input }) { const spec = scheduleFromInput(input); await ctx.service.validate(spec.action);
        const record = ctx.service.store.updateSchedule(id, expectedRevision, spec); ctx.service.onSchedulesChanged?.(id); return record; } }),
    operation({ name: "proc_schedule_remove", description: "Stop future admissions of a schedule at an exact revision; retain execution history. Does not cancel a running invocation. Protected system schedules cannot be removed.",
      input: s.scheduleRevision, output: z.strictObject({ removed: z.literal(true) }), annotations: { destructiveHint: true },
      async call(ctx, { id, expectedRevision }) { const result = ctx.service.store.removeSchedule(id, expectedRevision); ctx.service.onSchedulesChanged?.(id); return result; } }),
    operation({ name: "proc_schedule_get", description: "Read one schedule, including its due time and exact target. The action can contain sensitive input or environment overrides; treat the result accordingly.",
      input: s.scheduleId, output: s.scheduleRecord, annotations: read,
      async call(ctx, { id }) { return ctx.service.store.getSchedule(id); } }),
    operation({ name: "proc_schedule_list", description: "List the latest schedules and their next due times, including the protected Brain due-source trigger.",
      input: s.list, output: schedules, annotations: read,
      async call(ctx, { limit }) { return { schedules: ctx.service.store.schedules(limit) }; } }),
    operation({ name: "proc_execution_get", description: "Read one scheduled invocation. A lost API response is unknown rather than blindly retried; a process execution links its process run ID.",
      input: s.executionId, output: s.executionRecord, annotations: read,
      async call(ctx, { id }) { return ctx.service.store.getExecution(id); } }),
    operation({ name: "proc_execution_list", description: "Read recent invocations of one schedule, including failures and ambiguous outcomes. Deleting a schedule does not erase history.",
      input: s.scheduleId.extend({ limit: s.list.shape.limit }), output: executions, annotations: read,
      async call(ctx, { id, limit }) { return { executions: ctx.service.store.executions(id, limit) }; } }),
    operation({ name: "proc_run_start", description: "Admit one directly executed argv process under an IPC guardian. Request ID is required for idempotent admission. No shell or PATH lookup; stdout and stderr are framed into bounded lines. This executes with the local owner's user authority, not a sandbox.",
      input: s.runStart, output: s.runRecord, annotations: { idempotentHint: true, openWorldHint: true },
      async call(ctx, { requestId, process }) { return ctx.service.startRun(process, null, requestId); } }),
    operation({ name: "proc_run_get", description: "Read one process's durable exit state, output counts and truncation flag. Unknown means the guardian or service was interrupted; it is not a proven failure.",
      input: s.runId, output: s.runRecord, annotations: read,
      async call(ctx, { id }) { return ctx.service.store.getRun(id); } }),
    operation({ name: "proc_run_list", description: "List recent direct and scheduled process runs without command arguments or output bodies.",
      input: s.list, output: runs, annotations: read,
      async call(ctx, { limit }) { return { runs: ctx.service.store.runs(limit) }; } }),
    operation({ name: "proc_run_read", description: "Read bounded stdout/stderr lines after a monotonic cursor. Partial lines are explicitly marked; gap and outputTruncated disclose lost or unretained output. Follow proc_output_changed for invalidation.",
      input: s.runRead, output: s.outputPage, annotations: read,
      async call(ctx, { id, after, limit }) { return ctx.service.read(id, after, limit); } }),
    operation({ name: "proc_run_wait", description: "Wait at most 30 seconds for a line or terminal process state, returning the same cursor page as proc_run_read. A wait timeout does not cancel the run. This is an observation, not a second execution.",
      input: s.runWait, output: s.outputPage, annotations: read,
      async call(ctx, { id, after, limit, waitMs }) { return ctx.service.wait(id, after, limit, waitMs); } }),
    operation({ name: "proc_run_join", description: "Observe a process until exit or a bounded timeout, returning its exit record and a timedOut flag. No line wakes this wait; use proc_run_read for output. Direct socket callers must set a timeout beyond waitMs; observer timeout does not stop the process.",
      input: s.runJoin, output: s.runJoinResult, annotations: read,
      async call(ctx, { id, waitMs }) { return ctx.service.join(id, waitMs); } }),
    operation({ name: "proc_run_cancel", description: "Request termination of a live process group. Read proc_run_get or proc_run_wait to establish the terminal outcome; cancelling a completed run is a no-op.",
      input: s.runId, output: s.runRecord, annotations: { idempotentHint: true, destructiveHint: true },
      async call(ctx, { id }) { return ctx.service.cancel(id); } }),
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
