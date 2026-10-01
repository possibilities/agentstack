import { z } from "zod";
import { operation, socketCall, socketPath, stateDir, wantsCompletion, type CompletionWatch, type PackageApi } from "@stack/api";
import { notification, notificationSendInput, notificationSend, page } from "./src/schema.js";
import { NotificationStore } from "./src/store.js";
import { withStateInventory, requireStateOperator, statePlan, stateApplyInput, stateReceipt } from "@stack/api";
import { notifyStateCategories } from "./src/state-categories.js";

type Context = { store: NotificationStore; env: NodeJS.ProcessEnv; changed?: () => void };
const id = z.strictObject({ id: z.uuid() });
const read = { readOnlyHint: true } as const;
const group = z.string().min(1).max(200);
const count = z.number().int().nonnegative();
const completionWatch: CompletionWatch = { topic: "notify_changed", readOperation: "notification_get", idArgument: "id", terminalField: "dismissedAt", defaultWhen: ["actions", "reply"], retainFields: ["id", "dismissedAt", "outcome", "response", "contentClearedAt"] };

const packageApi: PackageApi<Context, "notify_changed"> = {
  operations: [
    operation({ name: "notification_history_plan", description: "Preview clearing bodies, prompts, actions and responses for up to 100 exact dismissed Notifications. Open records must be dismissed first. ID/digest/outcome receipts remain so sends and dismissals cannot be replayed as new actions.",
      input: z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) }), output: statePlan,
      async call(ctx, { ids }, invocation) { requireStateOperator(invocation); return ctx.store.historyPlan(ids); } }),
    operation({ name: "notification_history_clear", description: "Apply one exact dismissed-Notification payload plan atomically with its cleanup receipt. Removes authored bodies, source/group labels, URLs, actions, prompts and responses; retains original outcome and retry digests. An identical retry returns its prior receipt.",
      input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
      async call(ctx, input, invocation) { requireStateOperator(invocation); const result = ctx.store.historyClear(input); ctx.changed?.(); return result; } }),
    operation({ name: "notify_state_receipt_get", description: "Read one durable Notification payload-cleanup receipt, including the minimal metadata retained for retries.",
      input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: read,
      async call(ctx, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.store.maintenance.receipt(requestId) }; } }),
    operation({ name: "notification_send", description: "Persist a Notification; group replaces its open predecessor and caller ID deduplicates retries. subscribe defaults on for verified Bot MCP prompts (actions/reply); true also watches plain notices, false opts out. Other callers may send with omission, but true requires a sanctioned Bot Chat. Returns record plus subscription receipt; dismissal is completion, never approval. Nothing executes.",
      input: notificationSendInput, output: notificationSend,
      completionWatch, annotations: { idempotentHint: false },
      async call(ctx, input, invocation) {
        if (wantsCompletion(completionWatch, input, invocation)) {
          if (!(invocation?.transport === "mcp" && invocation.botId && invocation.instance && invocation.threadId && invocation.completionWatchId && input.id))
            throw new Error("subscribe requires owner-coordinated Bot MCP delivery to a verified sanctioned Chat; nothing was sent");
          await socketCall(socketPath("serve", ctx.env), "tools/call", { name: "serve_completion_check", arguments: {
            id: invocation.completionWatchId, package: "notify", operation: "notification_send", recordId: input.id, caller: invocation,
          } }, { timeoutMs: 5_000 });
        }
        const result = ctx.store.create(input); if (result.created) ctx.changed?.(); return { ...result.record, subscription: null };
      } }),
    operation({ name: "notification_get", description: "Read one durable notification by ID, including whether and how it was dismissed and any response.",
      input: id, output: notification, annotations: read, async call(ctx, { id }) { return ctx.store.get(id); } }),
    operation({ name: "notification_list", description: "Page newest-first durable notifications. Filter by dismissed, exact source and exact group; before is the exclusive sequence cursor. Null nextCursor ends the page sequence.",
      input: z.strictObject({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(25).default(20),
        dismissed: z.boolean().optional(), source: z.string().min(1).max(200).optional(), group: group.optional() }),
      output: page, annotations: read, async call(ctx, input) { return ctx.store.list(input); } }),
    operation({ name: "notification_counts", description: "Count open and total notifications, overall and per exact source (null for notifications sent without one), most-used sources first.",
      input: z.strictObject({}), output: z.strictObject({ open: count, total: count,
        sources: z.array(z.strictObject({ source: z.string().nullable(), open: count, total: count })) }),
      annotations: read, async call(ctx) { return ctx.store.counts(); } }),
    operation({ name: "notification_dismiss", description: "Dismiss one notification, recording how: closed (default), opened (clicked through), action (response is one of its actions) or replied (response is the reply text). The first dismissal wins; repeating it returns the record unchanged, and a different outcome is refused. History is kept.",
      input: id.extend({ outcome: z.enum(["closed", "opened", "action", "replied"]).default("closed"), response: z.string().trim().min(1).max(4_000).optional() }),
      output: notification, annotations: { idempotentHint: true },
      async call(ctx, { id, ...dismissal }) { const result = ctx.store.dismiss(id, dismissal); if (result.changed) ctx.changed?.(); return result.record; } }),
    operation({ name: "notification_dismiss_all", description: "Atomically dismiss every open notification as closed, or only those in one group. Preserves history; returns the number newly dismissed.",
      input: z.strictObject({ group: group.optional() }), output: z.strictObject({ dismissed: z.number().int().nonnegative() }),
      annotations: { idempotentHint: true }, async call(ctx, { group }) { const dismissed = ctx.store.dismissAll(group); if (dismissed) ctx.changed?.(); return { dismissed }; } }),
  ],
  events: { topics: { notify_changed: "Notification records changed. Re-read notification_list or notification_get; notices contain no notification text." },
    start(ctx, publish) { ctx.changed = () => publish("notify_changed"); return () => { ctx.changed = undefined; }; } },
  async createContext(env) { return { store: new NotificationStore(stateDir(env)), env }; },
  async closeContext(ctx) { ctx.store.close(); },
};
export const api = withStateInventory("notify", notifyStateCategories, packageApi);
