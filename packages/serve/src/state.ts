import { z } from "zod";
import { completionWatchSchema, occurrenceSubscriptionView, operation, requireStateOperator, stateDependencies, stateDependencyInput, stateHash, statePageInput, statePage, pageState, socketCall, socketPath, listPackages, workspaceRoot, type StateEntry } from "@stack/api";
import type { ServerContext } from "../api.js";

const subscription = z.strictObject({ id: z.uuid(), botId: z.string(), threadId: z.string(), instance: z.string(), pkg: z.string(), topic: z.string(), scope: z.string().nullable(),
  readOperation: z.string(), state: z.enum(["connecting", "active", "delivering", "error"]), lastDeliveredAt: z.number().nullable(), revision: z.string(),
  completion: z.strictObject({ operation: z.string(), terminalField: z.string(), retainFields: z.array(z.string()).optional(), updateField: z.string().optional(), declaration: completionWatchSchema.optional() }).nullable() });
function service(ctx: ServerContext) {
  if (!ctx.source.subscriptions) throw new Error("server subscription owner unavailable");
  return ctx.source.subscriptions;
}
export const serverStateOperations = [
  operation({ name: "serve_occurrence_list", description: "Local operator: page typed occurrence subscriptions for Bot Chats and exact Worker conversations, separate from snapshots. Receipt counts exclude bodies, arguments and errors; inspect with serve_occurrence_get. Unknown attempts freeze delivery. Remove at exact intent revision with serve_subscription_remove; admitted input cannot be recalled.",
    input: statePageInput.extend({ botId: z.string().optional(), workerId: z.string().optional(), package: z.string().optional() }),
    output: z.strictObject({ subscriptions: z.array(occurrenceSubscriptionView.omit({ deliveries: true })), revision: z.string(), nextOffset: z.number().int().nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, input, invocation) {
      requireStateOperator(invocation);
      const rows = (service(ctx).occurrences?.operatorList() ?? []).filter(row => (!input.botId || row.target.kind === "bot" && row.target.botId === input.botId)
        && (!input.workerId || row.target.kind === "worker" && row.target.workerId === input.workerId) && (!input.package || row.pkg === input.package))
        .map(({ arguments: _args, lastError: _error, deliveries: _deliveries, ...row }) => row).sort((a,b) => a.id.localeCompare(b.id));
      const revision = stateHash(rows); if (input.revision && input.revision !== revision) throw new Error("occurrence inventory changed; restart paging");
      return { subscriptions: rows.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null };
    } }),
  operation({ name: "serve_occurrence_get", description: "Local operator: inspect one exact typed occurrence subscription, including potentially sensitive source arguments and error text and the latest 128 delivery receipts with truncation/count disclosure. No input or replay is admitted by this read.",
    input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ subscription: occurrenceSubscriptionView.extend({ arguments: z.record(z.string(), z.unknown()), lastError: z.string().nullable() }).nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, { id }, invocation) { requireStateOperator(invocation); return { subscription: service(ctx).occurrences?.operatorList().find(row => row.id === id) ?? null }; } }),
  operation({ name: "serve_state_list", description: "Aggregate bounded state inventories from live Package API sockets. Unavailable owners are explicit gaps, never empty stores; no package context is created. Read links route to each owner. Optional measurement is bounded and overlapping/shared bytes must not be summed as unique storage.",
    input: statePageInput.extend({ owners: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).min(1).max(32).optional(), measure: z.boolean().default(false) }),
    output: statePage.extend({ owners: z.array(z.strictObject({ package: z.string(), available: z.boolean(), issue: z.string().nullable() })) }), annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, input, invocation) {
      requireStateOperator(invocation);
      const names = (await listPackages(workspaceRoot(import.meta.dirname))).map(pkg => pkg.config.name).sort();
      const selected = input.owners ? [...new Set(input.owners)].sort() : names;
      if (selected.some(name => !names.includes(name))) throw new Error("unknown state owner");
      const results = await Promise.all(selected.map(async name => {
        try {
          const value = statePage.parse(await socketCall(socketPath(name, ctx.env ?? process.env), "tools/call", {
            name: `${name}_state_read`, arguments: { limit: 100, measure: input.measure },
          }, { timeoutMs: 10_000 }));
          return { package: name, available: true, issue: value.nextOffset === null ? null : "Owner inventory continues; use its state read to page all categories", entries: value.entries };
        } catch { return { package: name, available: false, issue: "Owner unavailable or does not implement the current inventory contract", entries: [] as StateEntry[] }; }
      }));
      const entries = results.flatMap(row => row.entries), owners = results.map(({ entries: _entries, ...row }) => row);
      const page = pageState(entries, { offset: input.offset, limit: input.limit });
      const revision = stateHash([page.revision, owners]);
      if (input.revision && input.revision !== revision) throw new Error("aggregate inventory changed; restart paging");
      return { ...page, revision, owners };
    } }),
  operation({ name: "serve_subscription_list", description: "Page durable Bot event subscriptions across originating threads. Filter by exact Bot, thread or package; pass revision on later pages. Read arguments and error text are excluded here. Unavailable subscription ownership is an error, never an empty list.",
    input: statePageInput.extend({ botId: z.string().optional(), threadId: z.string().optional(), package: z.string().optional() }),
    output: z.strictObject({ subscriptions: z.array(subscription), revision: z.string(), nextOffset: z.number().int().nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, input, invocation) { requireStateOperator(invocation);
      const rows = service(ctx).operatorList().filter(row => (!input.botId || row.botId === input.botId) && (!input.threadId || row.threadId === input.threadId) && (!input.package || row.pkg === input.package))
        .map(({ readArguments: _args, lastError: _error, ...row }) => row).sort((a,b) => a.id.localeCompare(b.id));
      const revision = stateHash(rows); if (input.revision && input.revision !== revision) throw new Error("subscription observation changed; restart paging");
      return { subscriptions: rows.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < rows.length ? input.offset + input.limit : null }; } }),
  operation({ name: "serve_subscription_get", description: "Inspect one exact subscription, including potentially sensitive read arguments and its last error. This is operator inspection, not a subscription read or a model turn.",
    input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ subscription: subscription.extend({ readArguments: z.record(z.string(), z.unknown()), lastError: z.string().nullable() }).nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, { id }, invocation) { requireStateOperator(invocation); return { subscription: service(ctx).operatorList().find(row => row.id === id) ?? null }; } }),
  operation({ name: "serve_subscription_remove", description: "Remove one exact snapshot or typed occurrence subscription at its intent revision. Cancellation aborts pending reads and fences future intake. Previously admitted Worker inbox/native input cannot be recalled. Repeating the same absent UUID succeeds; UUIDs are never reused.",
    input: z.strictObject({ id: z.uuid(), expectedRevision: z.string().min(1) }), output: z.strictObject({ id: z.uuid(), removed: z.boolean() }), annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: ServerContext, { id, expectedRevision }, invocation) { requireStateOperator(invocation); return service(ctx).operatorRemove(id, expectedRevision); } }),
  operation({ name: "serve_bot_dependencies", description: "Read Bot-bound automatic event inputs for a maintenance plan. Every retained subscription must be explicitly removed before reset. This query starts no reads or turns; unavailable ownership fails closed.",
    input: stateDependencyInput, output: stateDependencies, annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, { botId }, invocation) { requireStateOperator(invocation); const rows = [
      ...service(ctx).operatorList().filter(row => row.botId === botId),
      ...(service(ctx).occurrences?.operatorList().filter(row => row.target.kind === "bot" && row.target.botId === botId) ?? []),
    ];
      return { revision: stateHash(rows.map(row => [row.id, row.revision])), blockedBy: rows.map(row => `Remove event subscription ${row.id} before Bot maintenance`), retained: [],
        relationships: rows.map(row => ({ relation: "automatic-input", package: "serve", kind: "subscription", id: row.id })) }; } }),
];
