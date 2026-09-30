import { join } from "node:path";
import { z } from "zod";
import { operation, requireStateOperator, statePageInput, statePlan, stateApplyInput, stateReceipt, stateFilePage } from "@stack/api";
import type { ContentContext } from "../api.js";

export const contentStateOperations = [
  operation({ name: "blob_stage_list", description: "Page active/finalized collection upload stages with exact abort revisions. Aborted stages retain only their admission metadata and never resume under the same client key. A finalized stage holds a CAS reference until explicitly aborted.",
    input: z.strictObject({ offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50) }),
    output: z.strictObject({ stages: z.array(z.strictObject({ id: z.uuid(), bytes: z.number().int(), received: z.number().int(), digest: z.string(), blob: z.string().nullable(), createdAt: z.string(), revision: z.string() })), nextOffset: z.number().int().nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ContentContext, { offset, limit }, invocation) { requireStateOperator(invocation); return ctx.collections.stageList(offset, limit); } }),
  operation({ name: "blob_stage_abort", description: "Retire one exact staged/finalized upload and remove staging bytes. Keep its admission identity to reject accidental client-key replay; item references and finalized CAS bytes remain. Retiring a finalized stage releases its independent CAS reference for a later collection plan.",
    input: z.strictObject({ id: z.uuid(), expectedRevision: z.string() }), output: z.strictObject({ id: z.uuid(), aborted: z.literal(true) }), annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: ContentContext, { id, expectedRevision }, invocation) { requireStateOperator(invocation); return ctx.collections.stageAbort(id, expectedRevision); } }),
  operation({ name: "content_blob_list", description: "Page collection CAS metadata under one two-digit lowercase hash prefix. A missing prefix is unavailable; enumerate known digest prefixes from item/stage records or select a prefix. Includes live item/stage references. Named Artifacts and Vault Git are different stores.",
    input: statePageInput.extend({ prefix: z.string().regex(/^[a-f0-9]{2}$/) }),
    output: stateFilePage.extend({ references: z.array(z.strictObject({ digest: z.string(), items: z.array(z.strictObject({ id: z.uuid(), revision: z.number().int() })), stages: z.array(z.strictObject({ id: z.uuid() })) })) }), annotations: { readOnlyHint: true },
    async call(ctx: ContentContext, { prefix, ...input }, invocation) { requireStateOperator(invocation); return ctx.collections.storageList(prefix, input); } }),
  operation({ name: "content_storage_plan", description: "Preview collection of up to 100 exact unreferenced collection CAS digests. Live items and finalized upload stages are independent references and block removal. Select digests through content_blob_list, not filesystem paths.",
    input: z.strictObject({ digests: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(100) }), output: statePlan,
    async call(ctx: ContentContext, { digests }, invocation) { requireStateOperator(invocation); return ctx.collections.storagePlan(digests); } }),
  operation({ name: "content_storage_collect", description: "Apply an exact unreferenced collection-CAS plan while fencing new owner admissions and checking live references. Durable receipts disclose partial/unknown filesystem outcomes. This never invokes Artifact gc, edits Vault Git or removes external output files.",
    input: stateApplyInput, output: stateReceipt, annotations: { destructiveHint: true, idempotentHint: true },
    async call(ctx: ContentContext, input, invocation) { requireStateOperator(invocation); return ctx.collections.storageCollect(input); } }),
  operation({ name: "content_state_receipt_get", description: "Read one durable collection-CAS cleanup receipt, including exact removed or uncertain resources.",
    input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), annotations: { readOnlyHint: true },
    async call(ctx: ContentContext, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.collections.maintenance.receipt(requestId) }; } }),
];
