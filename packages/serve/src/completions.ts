import { z } from "zod";
import { completionDomainLink, completionHistoryDetail, completionHistoryGetInput, completionHistoryListInput, completionHistoryPage, operation,
  requireStateOperator, socketCall, socketPath, type CompletionDomainLink, type CompletionHistoryReceipt } from "@stack/api";
import type { ServerContext } from "../api.js";

type CompletionLinkResolution =
  { kind: "local"; link: CompletionDomainLink } |
  { kind: "owner"; name: string; expected: CompletionDomainLink["kind"]; extra?: Record<string, unknown> } |
  { kind: "unsupported" };
const completionLinkResolution = (receipt: CompletionHistoryReceipt): CompletionLinkResolution => {
  switch (`${receipt.pkg}/${receipt.operation}`) {
    case "notify/notification_send": return { kind: "local", link: { kind: "notify", notificationId: receipt.recordId } };
    case "proc/proc_run_start": return { kind: "local", link: { kind: "proc", runId: receipt.recordId } };
    case "browse/browser_handoff_request": return { kind: "owner", name: "browser_completion_identity_get", expected: "browse" };
    case "worker/worker_start":
    case "worker/worker_send": return { kind: "owner", name: "worker_completion_identity_get", expected: "worker" };
    case "brain/submit": return { kind: "owner", name: "brain_completion_identity_get", expected: "brain-submit", extra: { operation: "submit" } };
    case "brain/sources_sync": return { kind: "owner", name: "brain_completion_identity_get", expected: "brain-sources", extra: { operation: "sources_sync" } };
    default: return { kind: "unsupported" };
  }
};

export const serverCompletionOperations = [
  operation({ name: "serve_completion_list", description: "Local operator: page retained completion receipts across all Bots and threads, ordered by receipt id and outliving their watches. Fixed diagnostic codes only — never error text, read arguments or domain content. Pass revision on later pages; a changed observation rejects stale paging.",
    input: completionHistoryListInput, output: completionHistoryPage, annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, input, invocation) {
      requireStateOperator(invocation);
      if (!ctx.source.subscriptions) throw new Error("server subscription owner unavailable");
      return ctx.source.subscriptions.completionHistory(input);
    } }),
  operation({ name: "serve_completion_get", description: "Local operator: inspect one retained completion receipt by receipt id regardless of Bot, filters or watch presence, with one bounded identity-only lookup against its domain owner for a navigation link. Owner absence, refusal or malformed answers degrade to linkStatus without leaking owner detail.",
    input: completionHistoryGetInput, output: completionHistoryDetail, annotations: { readOnlyHint: true },
    async call(ctx: ServerContext, input, invocation) {
      requireStateOperator(invocation);
      if (!ctx.source.subscriptions) throw new Error("server subscription owner unavailable");
      const receipt = ctx.source.subscriptions.completionHistoryGet(input.id);
      if (!receipt) return { receipt: null, link: null, linkStatus: "not_found" as const };
      const resolution = completionLinkResolution(receipt);
      if (resolution.kind === "unsupported") return { receipt, link: null, linkStatus: "unsupported" as const };
      if (resolution.kind === "local") return { receipt, link: resolution.link, linkStatus: "resolved" as const };
      try {
        const result = await socketCall(socketPath(receipt.pkg, ctx.env ?? process.env), "tools/call",
          { name: resolution.name, arguments: { botId: receipt.botId, threadId: receipt.threadId, requestId: receipt.recordId, ...resolution.extra } },
          { timeoutMs: 5_000 });
        const link = z.strictObject({ link: completionDomainLink.nullable() }).parse(result).link;
        if (!link) return { receipt, link: null, linkStatus: "missing" as const };
        if (link.kind !== resolution.expected || !("requestId" in link) || link.requestId !== receipt.recordId)
          return { receipt, link: null, linkStatus: "unavailable" as const };
        return { receipt, link, linkStatus: "resolved" as const };
      } catch {
        return { receipt, link: null, linkStatus: "unavailable" as const };
      }
    } }),
];
