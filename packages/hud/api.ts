import { z } from "zod";
import { operation, stateDir, type PackageApi } from "@stack/api";
import * as s from "./src/schema.js";
import { workAdmissionPage } from "./src/client.js";
import { HudStore } from "./src/store.js";
import { HudService } from "./src/service.js";

export type HudContext = { store: HudStore; service: HudService };
const read = { readOnlyHint: true } as const;
const write = { idempotentHint: true } as const;
const requestId = z.uuid().describe("Retry the same UUID and identical input after a lost response. Changed intent needs a new UUID.");
const id = z.strictObject({ id: z.uuid() });
const page = { after: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(40) };

export const workCreate = operation({ name: "work_create",
  description: "Create durable shared work with a caller-generated ID, objective, nested parent, state, dependencies and typed resource links. Records the verified originating Chat automatically. Does not dispatch resources or select Chat focus. Human attention and nextAction are explicit; native activity never determines work state.",
  input: s.create.extend({ requestId }), output: s.receipt, annotations: write,
  async call(ctx: HudContext, { requestId, ...input }, invocation) { return ctx.service.apply(requestId, [{ action: "create", ...input }], invocation); },
});
export const workUpdate = operation({ name: "work_update",
  description: "Patch selected work fields against expectedRevision; omitted fields stay unchanged and arrays replace whole arrays. Parent moves and objective/dependency changes advance scopeRevision. Completion requires completed dependencies and terminal children. Reopen closed scope before revising it. This never starts, stops or approves native execution.",
  input: s.update.extend({ requestId }), output: s.receipt, annotations: write,
  async call(ctx: HudContext, { requestId, ...input }, invocation) { return ctx.service.apply(requestId, [{ action: "update", ...input }], invocation); },
});
export const workBatch = operation({ name: "work_batch",
  description: "Atomically create, update, annotate and set metadata on up to 50 work items. Changes execute in order with exact revisions; validate hierarchy, dependency cycles and completion against the final graph. Any conflict rolls everything back. Use for reparenting, closing a subtree or reopening a completed ancestor with a child.",
  input: z.strictObject({ requestId, changes: z.array(s.change).min(1).max(50).refine(value => Buffer.byteLength(JSON.stringify(value)) <= 512_000, "Batch exceeds 512,000 bytes") }),
  output: s.receipt, annotations: write,
  async call(ctx: HudContext, input, invocation) { return ctx.service.apply(input.requestId, input.changes, invocation); },
});
export const workGet = operation({ name: "work_get", description: "Read one shared work item and its semantic state, objective, next action, attention, revision, scope revision and typed links. Metadata and collaboration history have separate bounded reads. Bot readers share this work graph; Workers receive no HUD access by default.",
  input: id, output: s.workItem, annotations: read,
  async call(ctx: HudContext, { id }, invocation) { await ctx.service.caller(invocation); return ctx.store.get(id); },
});
export const workList = operation({ name: "work_list", description: "Page work in creation order. Filter exact parent (null means roots), states, attention, text or an exact namespaced metadata key/value correlation. Results omit metadata. nextCursor is null at the end; restart on hud_changed to reconcile earlier rows. Both row count and response bytes are bounded.",
  input: s.listInput, output: z.strictObject({ items: z.array(s.workItem), nextCursor: z.number().int().nullable(), cursor: z.number().int() }), annotations: read,
  async call(ctx: HudContext, input, invocation) { await ctx.service.caller(invocation); return ctx.store.list(input); },
});
export const workTree = operation({ name: "work_tree", description: "Read an ordered, flat preorder tree with parent IDs, depth, direct child counts, open descendant counts and unmet dependency IDs. Optional rootId includes that root and all descendants. Pass snapshot on later pages; any intervening HUD journal change requires restarting pagination. No completion or activity is inferred from rollups.",
  input: z.strictObject({ rootId: z.uuid().optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(100), snapshot: z.number().int().nonnegative().optional() }),
  output: z.strictObject({ rows: z.array(z.strictObject({ item: s.workItem, depth: z.number().int(), childCount: z.number().int(), openDescendants: z.number().int(), unmetDependencies: z.array(z.uuid()) })),
    total: z.number().int(), nextOffset: z.number().int().nullable(), snapshot: z.number().int() }), annotations: read,
  async call(ctx: HudContext, input, invocation) { await ctx.service.caller(invocation); return ctx.store.tree(input); },
});
export const workMetadataGet = operation({ name: "work_metadata_get", description: "Explicitly read agent coordination metadata, optionally one namespace. It is excluded from ordinary work, tree and activity projections, not a secret store or an authorization boundary. Maximum 32 namespaces of 16 KB each. Do not store credentials here.",
  input: id.extend({ namespace: s.namespace.optional() }), output: z.strictObject({ id: z.uuid(), revision: z.number().int(), namespaces: z.record(s.namespace, s.metadata) }), annotations: read,
  async call(ctx: HudContext, input, invocation) { await ctx.service.caller(invocation); return { id: input.id, revision: ctx.store.get(input.id).revision, namespaces: ctx.store.metadata(input.id, input.namespace) }; },
});
export const workMetadataSet = operation({ name: "work_metadata_set", description: "Replace one namespaced JSON metadata object, or remove it with null, using the work item's expectedRevision. Other namespaces are preserved. Null, false and empty values inside the object are retained. Metadata advances item revision, not scopeRevision; journal entries name only the namespace, never its values.",
  input: s.metadataSet.extend({ requestId }), output: s.receipt, annotations: write,
  async call(ctx: HudContext, { requestId, ...input }, invocation) { return ctx.service.apply(requestId, [{ action: "metadata", ...input }], invocation); },
});
export const workNoteAdd = operation({ name: "work_note_add", description: "Append an immutable note, progress report, result, decision or handoff with exact references, actor and current scope revision. Recording a result neither accepts it nor completes work; record review/decisions explicitly and update semantic state separately. Metadata is never copied into notes automatically.",
  input: s.note.extend({ requestId }), output: s.receipt, annotations: write,
  async call(ctx: HudContext, { requestId, ...input }, invocation) { return ctx.service.apply(requestId, [{ action: "note", ...input }], invocation); },
});
export const workActivityList = operation({ name: "work_activity_list", description: "Read the durable collaboration journal after an exclusive sequence cursor, globally or for one item. Includes edits, scope revisions, focus changes and immutable notes/results/decisions. Notices are not the journal: resnapshot or continue this cursor after reconnect. Metadata values are excluded.",
  input: z.strictObject({ id: z.uuid().optional(), ...page }), output: z.strictObject({ entries: z.array(s.activity), nextCursor: z.number().int(), hasMore: z.boolean() }), annotations: read,
  async call(ctx: HudContext, input, invocation) { await ctx.service.caller(invocation); return ctx.store.activity(input); },
});
export const workFocusGet = operation({ name: "work_focus_get", description: "Read an exact Chat's durable focus and revision. Bots default to their verified calling Chat; operators must supply botId, sanctioned mainThreadId and threadId. Revision zero means no selection and permits ancestor inheritance. A saved null explicitly clears focus and blocks inheritance. Focus is context, not native activity.",
  input: z.strictObject({ target: s.chatTarget.optional() }), output: s.focus, annotations: read,
  async call(ctx: HudContext, { target }, invocation) { const caller = await ctx.service.caller(invocation); return ctx.store.focus(await ctx.service.target(caller, target)); },
});
export const workFocusSet = operation({ name: "work_focus_set", description: "Set or clear a verified Chat's work focus using its own expectedRevision (zero initially). Bots may select only their calling Chat; operators select an exact target. Descendants inherit the nearest explicit ancestor focus. Worker admission captures it durably; changing focus never reassigns previous turns or proves the Bot is working.",
  input: z.strictObject({ requestId, target: s.chatTarget.optional(), expectedRevision: z.number().int().nonnegative(), workItemId: z.uuid().nullable() }), output: s.receipt, annotations: write,
  async call(ctx: HudContext, input, invocation) { const caller = await ctx.service.caller(invocation); const target = await ctx.service.target(caller, input.target); return ctx.store.setFocus({ ...input, target }, caller.actor); },
});
export const workContextResolve = operation({ name: "work_context_resolve", description: "Resolve an explicit open work item or the verified calling Chat's nearest inherited focus into a scope-versioned admission context. Operators without an explicit item receive null. A closed focus is an error requiring reconciliation. Read-only: the Worker owner stores the returned context atomically with its new turn.",
  input: z.strictObject({ workItemId: z.uuid().optional() }), output: z.strictObject({ context: s.workContext.nullable() }), annotations: read,
  async call(ctx: HudContext, input, invocation) { return ctx.service.resolve(input.workItemId, invocation); },
});
export const workResources = operation({ name: "work_resources", description: "Read typed links, exact Chat focuses and a page of captured Worker-turn associations for this item. Worker observations are separately timestamped and may be unavailable or limited to the calling Bot. Compare captured scopeRevision with current scopeRevision. Refresh on hud_changed and worker/workers_changed; execution never changes semantic work state.",
  input: id.extend({ ...page, limit: z.number().int().min(1).max(50).default(30) }), output: z.strictObject({ workItemId: z.uuid(), scopeRevision: z.number().int(), links: z.array(s.link), focuses: z.strictObject({ entries: z.array(s.focus), total: z.number().int(), truncated: z.boolean() }),
    workers: workAdmissionPage.nullable(), observation: z.strictObject({ state: z.enum(["available", "unavailable"]), at: z.number().int(), issue: z.string().nullable(), visibility: z.enum(["all", "own_bot"]) }) }), annotations: read,
  async call(ctx: HudContext, input, invocation) { return ctx.service.resources(input.id, input.after, input.limit, invocation); },
});
export const topics = {
  hud_changed: "Durable work, metadata, collaboration history or Chat focus changed. Refresh work_list/work_tree or continue work_activity_list. No payload. Worker runtime changes remain worker/workers_changed.",
  work_changed: "A work item or its derived tree/readiness context changed. Subscribe with the item ID, then re-read it and its tree/resources. Ancestor and dependent invalidations do not imply their stored revision changed.",
} as const;
export const api: PackageApi<HudContext, keyof typeof topics> = {
  operations: [workCreate, workUpdate, workBatch, workGet, workList, workTree, workMetadataGet, workMetadataSet, workNoteAdd, workActivityList, workFocusGet, workFocusSet, workContextResolve, workResources],
  events: { topics, scope: { description: "Optional work item ID for work_changed. Global hud_changed is unscoped.", example: "00000000-0000-4000-8000-000000000001", valid: (ctx, id) => ctx.store.has(id) },
    start(ctx, publish) { ctx.store.onChange = ids => { publish("hud_changed"); for (const id of ids) publish("work_changed", id); }; return () => { ctx.store.onChange = undefined; }; } },
  async createContext(env) { const store = new HudStore(stateDir(env)); return { store, service: new HudService(store, env) }; },
  async closeContext(ctx) { ctx.store.close(); },
};
