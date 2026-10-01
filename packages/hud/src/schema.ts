import { z } from "zod";

export const identity = z.string().min(1).max(256);
export const workState = z.enum(["planned", "active", "blocked", "waiting", "paused", "review", "completed", "cancelled"]);
export const actor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operator") }),
  z.strictObject({ kind: z.literal("bot"), botId: identity, mainThreadId: identity, threadId: identity }),
]);
export const chatTarget = z.strictObject({ botId: identity, mainThreadId: identity, threadId: identity });
export const reference = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("operator") }),
  z.strictObject({ kind: z.literal("bot"), botId: identity, mainThreadId: identity }),
  chatTarget.extend({ kind: z.literal("chat") }),
  z.strictObject({ kind: z.literal("worker"), workerId: z.uuid(), turnId: z.uuid().nullable().default(null) }),
  z.strictObject({ kind: z.literal("work"), workItemId: z.uuid() }),
  z.strictObject({ kind: z.literal("resource"), package: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    resource: identity, id: identity, version: identity.nullable().default(null) }),
  z.strictObject({ kind: z.literal("url"), url: z.url().max(4096).refine(value => /^https?:/.test(value), "Use an HTTP(S) URL") }),
]);
export const link = z.strictObject({
  relation: z.enum(["lead", "contributor", "context", "evidence", "output", "related"]),
  target: reference, label: z.string().max(200).default(""),
});
const content = z.strictObject({
  title: z.string().trim().min(1).max(200),
  objective: z.string().trim().min(1).max(8000),
  summary: z.string().max(2000),
  state: workState,
  parentId: z.uuid().nullable(),
  order: z.number().finite(),
  priority: z.enum(["low", "normal", "high", "urgent"]),
  nextAction: z.string().max(2000),
  attention: z.enum(["none", "human", "agent"]),
  dependencies: z.array(z.uuid()).max(64),
  labels: z.array(z.string().trim().min(1).max(64)).max(24),
  links: z.array(link).max(64).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64_000, "Links must fit in 64,000 bytes"),
});
export const fields = content.extend({ summary: content.shape.summary.default(""), state: workState.default("planned"),
  parentId: content.shape.parentId.default(null), order: content.shape.order.default(0), priority: content.shape.priority.default("normal"),
  nextAction: content.shape.nextAction.default(""), attention: content.shape.attention.default("none"),
  dependencies: content.shape.dependencies.default([]), labels: content.shape.labels.default([]), links: content.shape.links.default([]) });
export const workItem = fields.extend({
  id: z.uuid(), sequence: z.number().int().positive(), revision: z.number().int().positive(),
  scopeRevision: z.number().int().positive(), createdBy: actor, updatedBy: actor,
  createdAt: z.number().int(), updatedAt: z.number().int(),
  contentGeneration: z.number().int().nonnegative().optional(),
  contentClearedAt: z.number().int().nullable().optional(),
  contentDigest: z.string().nullable().optional(),
});
export const namespace = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/);
export const metadata = z.record(z.string().min(1).max(128), z.json()).refine(value =>
  Buffer.byteLength(JSON.stringify(value)) <= 16_000, "A metadata namespace must fit in 16,000 bytes");
const versioned = { id: z.uuid(), expectedRevision: z.number().int().positive() };
export const create = z.strictObject({ id: z.uuid(), ...fields.shape });
export const update = z.strictObject({ ...versioned, patch: content.partial().refine(value => Object.keys(value).length > 0, "Supply a patch") });
export const metadataSet = z.strictObject({ ...versioned, namespace, value: metadata.nullable() });
export const note = z.strictObject({ ...versioned, kind: z.enum(["note", "progress", "result", "decision", "handoff"]),
  body: z.string().trim().min(1).max(16_000), references: z.array(reference).max(32).default([]) });
export const change = z.discriminatedUnion("action", [
  create.extend({ action: z.literal("create") }), update.extend({ action: z.literal("update") }),
  metadataSet.extend({ action: z.literal("metadata") }), note.extend({ action: z.literal("note") }),
]);
export const receipt = z.strictObject({ requestId: z.uuid(), duplicate: z.boolean(), cursor: z.number().int().nonnegative(),
  items: z.array(z.strictObject({ id: z.uuid(), revision: z.number().int().positive(), scopeRevision: z.number().int().positive() })) });
export const activity = z.strictObject({ sequence: z.number().int().positive(), workItemId: z.uuid(), revision: z.number().int().positive(),
  scopeRevision: z.number().int().positive(), requestId: z.uuid(), actor, at: z.number().int(),
  kind: z.enum(["created", "updated", "metadata", "note", "progress", "result", "decision", "handoff", "focus", "maintenance"]),
  fields: z.array(z.string()), changes: z.array(z.strictObject({ field: z.string(), before: z.json(), after: z.json() })),
  body: z.string().nullable(), references: z.array(reference), contentClearedAt: z.number().int().optional() });
export const historySelection = z.strictObject({ items: z.array(z.uuid()).min(1).max(100), scope: z.enum(["journal_bodies", "item_and_journal"]) });
export type HistorySelection = z.infer<typeof historySelection>;
export const focus = chatTarget.extend({ revision: z.number().int().nonnegative(), workItemId: z.uuid().nullable(),
  updatedAt: z.number().int().nullable(), updatedBy: actor.nullable() });
export const workContext = z.strictObject({ workItemId: z.uuid(), scopeRevision: z.number().int().positive(),
  source: z.enum(["explicit", "focus", "continuation"]) });
export const listInput = z.strictObject({ after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40),
  parentId: z.uuid().nullable().optional(), states: z.array(workState).min(1).optional(),
  query: z.string().trim().min(1).max(200).optional(), attention: fields.shape.attention.unwrap().optional(),
  correlation: z.strictObject({ namespace, key: z.string().min(1).max(128), value: z.json() }).optional() });
export type Actor = z.infer<typeof actor>;
export type WorkItem = z.infer<typeof workItem>;
export type Change = z.infer<typeof change>;
export type Receipt = z.infer<typeof receipt>;
export type Activity = z.infer<typeof activity>;
export type Focus = z.infer<typeof focus>;
export type ChatTarget = z.infer<typeof chatTarget>;
export type WorkContext = z.infer<typeof workContext>;
export type Reference = z.infer<typeof reference>;
export type ListInput = z.infer<typeof listInput>;
export type Metadata = z.infer<typeof metadata>;
