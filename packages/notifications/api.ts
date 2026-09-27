import { z } from "zod";
import { operation, stateDir, type PackageApi } from "@agentstack/api";
import { content, notification, page } from "./src/schema.js";
import { NotificationStore } from "./src/store.js";

type Context = { store: NotificationStore; changed?: () => void };
const id = z.strictObject({ id: z.uuid() });
const read = { readOnlyHint: true } as const;
const edit = z.strictObject({ title: content.shape.title.optional(), message: content.shape.message.optional(),
  subtitle: z.string().trim().max(400).nullable().optional(), source: z.string().trim().min(1).max(200).nullable().optional() });

export const api: PackageApi<Context, "notifications_changed"> = {
  operations: [
    operation({ name: "notification_send", description: "Persist a notification with title, message, optional subtitle and source. Returns its stable ID and record. Optional caller ID deduplicates identical submissions; no system banner or action is triggered.",
      input: content.extend({ id: z.uuid().optional() }), output: notification, annotations: { idempotentHint: false },
      async call(ctx, input) { const result = ctx.store.create(input); if (result.created) ctx.changed?.(); return result.record; } }),
    operation({ name: "notification_get", description: "Read one durable notification by ID, including revision and independent acknowledgment and dismissal timestamps.",
      input: id, output: notification, annotations: read, async call(ctx, { id }) { return ctx.store.get(id); } }),
    operation({ name: "notification_list", description: "Page newest-first durable notifications. Filter independently by acknowledged and dismissed booleans and exact source; before is the exclusive sequence cursor. Null nextCursor ends the page sequence.",
      input: z.strictObject({ before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(25).default(20),
        acknowledged: z.boolean().optional(), dismissed: z.boolean().optional(), source: z.string().min(1).max(200).optional() }),
      output: page, annotations: read, async call(ctx, input) { return ctx.store.list(input); } }),
    operation({ name: "notification_update", description: "Edit the text or source of an existing notification by ID. Requires its current revision to prevent lost edits; does not reset acknowledgment or dismissal.",
      input: id.extend({ expectedRevision: z.number().int().positive(), ...edit.shape }), output: notification,
      async call(ctx, { id, expectedRevision, ...patch }) { const before = ctx.store.get(id); const record = ctx.store.update(id, expectedRevision, patch); if (record.revision !== before.revision) ctx.changed?.(); return record; } }),
    operation({ name: "notification_acknowledge", description: "Acknowledge one notification without dismissing it. Repeated calls retain the first acknowledgment timestamp.",
      input: id, output: notification, annotations: { idempotentHint: true },
      async call(ctx, { id }) { const result = ctx.store.mark(id, "acknowledged_at"); if (result.changed) ctx.changed?.(); return result.record; } }),
    operation({ name: "notification_dismiss", description: "Dismiss one notification without deleting its history or implicitly acknowledging it. Repeated calls retain the first dismissal timestamp.",
      input: id, output: notification, annotations: { idempotentHint: true },
      async call(ctx, { id }) { const result = ctx.store.mark(id, "dismissed_at"); if (result.changed) ctx.changed?.(); return result.record; } }),
    operation({ name: "notification_dismiss_all", description: "Atomically dismiss all currently undismissed notifications. Preserves their history and acknowledgment state; returns the number newly dismissed.",
      input: z.strictObject({}), output: z.strictObject({ dismissed: z.number().int().nonnegative() }),
      annotations: { idempotentHint: true }, async call(ctx) { const dismissed = ctx.store.dismissAll(); if (dismissed) ctx.changed?.(); return { dismissed }; } }),
  ],
  events: { topics: { notifications_changed: "Notification records changed. Re-read notification_list or notification_get; notices contain no notification text." },
    start(ctx, publish) { ctx.changed = () => publish("notifications_changed"); return () => { ctx.changed = undefined; }; } },
  async createContext(env) { return { store: new NotificationStore(stateDir(env)) }; },
  async closeContext(ctx) { ctx.store.close(); },
};
