import { z } from "zod";
import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { content, notification, page } from "./src/schema.js";
import { NotificationStore } from "./src/store.js";

type Context = { store: NotificationStore; changed?: () => void };
const id = z.strictObject({ id: z.uuid() });
const read = { readOnlyHint: true } as const;
const group = z.string().min(1).max(200);

export const api: PackageApi<Context, "notify_changed"> = {
  operations: [
    operation({ name: "notification_send", description: "Persist a notification with title, message, optional subtitle, source, click-through open URL, answer actions and reply placeholder. Returns its stable ID and record. A group replaces the open notification with the same group, dismissing it as replaced. Optional caller ID deduplicates identical submissions; no system banner is shown and nothing is executed.",
      input: content.extend({ id: z.uuid().optional() }), output: notification, annotations: { idempotentHint: false },
      async call(ctx, input) { const result = ctx.store.create(input); if (result.created) ctx.changed?.(); return result.record; } }),
    operation({ name: "notification_get", description: "Read one durable notification by ID, including whether and how it was dismissed and any response.",
      input: id, output: notification, annotations: read, async call(ctx, { id }) { return ctx.store.get(id); } }),
    operation({ name: "notification_list", description: "Page newest-first durable notifications. Filter by dismissed, exact source and exact group; before is the exclusive sequence cursor. Null nextCursor ends the page sequence.",
      input: z.strictObject({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(25).default(20),
        dismissed: z.boolean().optional(), source: z.string().min(1).max(200).optional(), group: group.optional() }),
      output: page, annotations: read, async call(ctx, input) { return ctx.store.list(input); } }),
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
  async createContext(env) { return { store: new NotificationStore(stateDir(env)) }; },
  async closeContext(ctx) { ctx.store.close(); },
};
