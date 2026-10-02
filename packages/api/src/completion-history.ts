import { z } from "zod";

const O = z.strictObject;
const U = z.uuid();
const I = z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/);
const N = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const P = N.min(1);
const Pkg = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const completionHistoryRevision = z.string().regex(/^[a-f0-9]{64}$/);
export const completionHistoryState = z.enum(["pending", "error", "observed", "delivered", "unknown", "cancelled"]);
export const completionHistoryReceipt = O({
  id: U, botId: I, threadId: I, pkg: Pkg, operation: I, recordId: U,
  state: completionHistoryState, lastDeliveredAt: N.nullable(),
  lastDeliveryKind: z.enum(["update", "terminal"]).nullable(),
  lastError: z.enum(["diagnostic_withheld", "native_admission_unknown"]).nullable(),
  nativeAdmissionUncertain: z.boolean(), subscriptionPresent: z.boolean(),
});
export const notifyCompletionLink = O({ kind: z.literal("notify"), notificationId: U });
export const browseCompletionLink = O({ kind: z.literal("browse"), requestId: U, handoffId: U });
export const workerCompletionLink = O({ kind: z.literal("worker"), requestId: U, workerId: U, turnId: U });
export const procCompletionLink = O({ kind: z.literal("proc"), runId: U });
export const brainSubmitCompletionLink = O({ kind: z.literal("brain-submit"), requestId: U, jobId: P.nullable(), documentId: P.nullable() })
  .refine(link => link.jobId !== null || link.documentId !== null, "submit link requires a job or document identity");
export const brainSourcesCompletionLink = O({ kind: z.literal("brain-sources"), requestId: U, runIds: z.array(P).max(1000) });
export const completionDomainLink = z.discriminatedUnion("kind", [notifyCompletionLink, browseCompletionLink, workerCompletionLink, procCompletionLink, brainSubmitCompletionLink, brainSourcesCompletionLink]);
export const completionHistoryListInput = O({
  offset: N.default(0), limit: N.min(1).max(100).default(50), revision: completionHistoryRevision.optional(),
  botId: I.optional(), threadId: I.optional(), package: Pkg.optional(), operation: I.optional(), recordId: U.optional(), state: completionHistoryState.optional(),
});
export const completionHistoryPage = O({ completions: z.array(completionHistoryReceipt).max(100), revision: completionHistoryRevision, total: N, nextOffset: N.nullable(), truncated: z.boolean() });
export const completionHistoryGetInput = O({ id: U });
export const completionHistoryDetail = O({ receipt: completionHistoryReceipt.nullable(), link: completionDomainLink.nullable(),
  linkStatus: z.enum(["resolved", "missing", "unavailable", "unsupported", "not_found"]) });
export const completionIdentityInput = O({ botId: I, threadId: I, requestId: U });

export type CompletionHistoryReceipt = z.infer<typeof completionHistoryReceipt>;
export type CompletionHistoryPage = z.infer<typeof completionHistoryPage>;
export type CompletionHistoryListInput = z.infer<typeof completionHistoryListInput>;
export type CompletionHistoryGetInput = z.infer<typeof completionHistoryGetInput>;
export type CompletionHistoryDetail = z.infer<typeof completionHistoryDetail>;
export type CompletionDomainLink = z.infer<typeof completionDomainLink>;
export type CompletionIdentityInput = z.infer<typeof completionIdentityInput>;
