import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { InvocationContext } from "./operation.js";
import type { McpEventSubscriptions } from "./mcp-subscriptions.js";
import { currentMcpCatalog, currentWorkerCatalog, type SocketCatalog } from "./exposure.js";
import { listenInput } from "./occurrence-subscriptions.js";
import { mcpInvocation, parseMcpBinding, verifyMcpIdentity } from "./mcp-authority.js";

export const subscriptionTools: Tool[] = [
  { name: "events_listen", description: "Attach a typed occurrence source to this verified Bot Chat or Worker. Stack owns polling, durable intake and cursor recovery. native uses Codex start-or-steer, or a recorded Worker follow-up after its active prompt ends. interrupt explicitly cancels a Worker's active prompt first. Worker intake is not native acknowledgement or consumption. Repeating identical arguments preserves the existing cursor; unknown deliveries never replay automatically.", inputSchema: {
    type: "object", properties: { name: { type: "string" }, arguments: { type: "object", additionalProperties: true }, cursor: { type: ["string", "null"] }, maxAgeMs: { type: "integer", minimum: 0 }, policy: { type: "string", enum: ["native", "interrupt"] } }, required: ["name"], additionalProperties: false } },
  { name: "events_catalog", description: "List this Package API's snapshot topics, scope rule, typed poll occurrence sources, and exposed read-only operations.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "events_subscribe", description: "Subscribe this Bot thread to a topic and read-only snapshot operation. Return the first value now; later changed snapshots arrive as standalone tool output through Codex start-or-steer. Idle threads wake; working threads receive pending input at Codex's processing boundary. Stack never waits for idle or turn completion. Repeating the same request returns the existing subscription.", inputSchema: {
    type: "object", properties: { topic: { type: "string" }, scope: { type: "string" }, readOperation: { type: "string" }, readArguments: { type: "object", additionalProperties: true } },
    required: ["topic", "readOperation"], additionalProperties: false,
  } },
  { name: "events_status", description: "List this conversation's occurrence subscriptions with bounded receipt history, and (Bot Chats only) snapshot watches and completion receipts. Optional completionId reads an exact Bot receipt. Occurrence boundary native_admission means native acknowledged, worker_inbox means durable Worker intake only. Neither means consumption. Unknown is never replayed automatically; truncated histories disclose their counts.", inputSchema: { type: "object", properties: { completionId: { type: "string", format: "uuid" } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "events_unsubscribe", description: "Stop one exact subscription owned by this Bot Chat or Worker. Fences future intake, not input already admitted to a Worker inbox or native runtime. Source watches and their consumption cursors remain independent.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];

export type McpEventCall = (pkg: string, tool: string, args: Record<string, unknown>, invocation: InvocationContext, signal: AbortSignal) => Promise<object>;
const subscriptionInput = z.strictObject({ topic: z.string().min(1), scope: z.string().optional(), readOperation: z.string().min(1), readArguments: z.record(z.string(), z.unknown()).optional() });

export function mcpEventCatalog(doc: SocketCatalog) {
  return { topics: doc.events?.topics ?? {}, scope: doc.events?.scope ?? null,
    occurrences: doc.tools.flatMap(tool => tool.eventSource ? [tool.eventSource] : []),
    reads: doc.tools.filter(tool => tool.annotations?.readOnlyHint).map(({ name, description, inputSchema }) => ({ name, description: description ?? "", inputSchema })) };
}

/** Runs only in the serve owner; both local HTTP and private stdio relays use it. */
export function subscriptionService(service: McpEventSubscriptions, root: string, env: NodeJS.ProcessEnv): McpEventCall {
  return async (pkg, tool, args, invocation, signal) => {
    signal.throwIfAborted();
    const listed = invocation.workerId ? await currentWorkerCatalog(root, pkg, env) : await currentMcpCatalog(root, pkg, env);
    if (tool === "operation_watch") {
      await service.validateInvocation(invocation);
      const input = z.strictObject({ operation: z.string(), input: z.record(z.string(), z.unknown()) }).parse(args);
      return service.callAndWatch(pkg, input.operation, input.input, invocation);
    }
    if (tool === "events_listen") {
      if (!service.occurrences) throw new Error("occurrence subscription owner is unavailable");
      return { subscription: await service.occurrences.subscribe(pkg, listenInput.parse(args), invocation) };
    }
    if (!Object.keys(listed.events?.topics ?? {}).length && !listed.tools.some(tool => tool.eventSource)) throw new Error("event subscriptions are unavailable over mcp");
    if (tool === "events_catalog") return service.catalog(pkg, listed);
    if (tool === "events_status") {
      const input = z.strictObject({ completionId: z.uuid().optional() }).parse(args);
      if (!invocation.workerId) await service.validateInvocation(invocation);
      else if (input.completionId) throw new Error("Bot completion receipts are unavailable to Workers");
      return { ...(invocation.workerId ? { subscriptions: [], completions: [], completionsTruncated: false, lifetime: "durable" } : service.status(invocation, input.completionId)),
        occurrences: await service.occurrences?.status(invocation) ?? [] };
    }
    if (tool === "events_unsubscribe") {
      const id = z.strictObject({ id: z.uuid() }).parse(args).id;
      if (service.occurrences?.has(id)) return service.occurrences.unsubscribe(id, invocation);
      if (invocation.workerId) return { id, removed: false };
    }
    await service.validateInvocation(invocation);
    if (tool === "events_subscribe") {
      const input = subscriptionInput.parse(args);
      if (!Object.hasOwn(listed.events?.topics ?? {}, input.topic) || !listed.tools.some(tool => tool.name === input.readOperation && tool.annotations?.readOnlyHint))
        throw new Error("subscription requires a selected topic and exposed read-only operation");
      return service.subscribe(pkg, input, invocation);
    }
    if (tool === "events_unsubscribe") return service.unsubscribe(z.strictObject({ id: z.uuid() }).parse(args).id, invocation);
    throw new Error(`unknown event tool: ${tool}`);
  };
}

export const mcpEventRelayInput = z.strictObject({
  binding: z.string().min(1).max(512), pkg: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
   tool: z.enum(["events_catalog", "events_subscribe", "events_status", "events_unsubscribe", "events_listen", "operation_watch"]),
   arguments: z.record(z.string(), z.unknown()), threadId: z.string().min(1).max(128).nullable(), sessionId: z.string().max(128).nullable(),
});

/** Independently authenticate the relay. Never trust a caller-supplied InvocationContext. */
export async function relayMcpEvent(service: McpEventSubscriptions, input: z.infer<typeof mcpEventRelayInput>, root: string, env: NodeJS.ProcessEnv): Promise<object> {
  const identity = parseMcpBinding(input.binding, env);
  await verifyMcpIdentity(identity, env);
  const invocation = mcpInvocation(identity, input);
  if ("botId" in identity) await service.validateInvocation(invocation);
  const result = await subscriptionService(service, root, env)(input.pkg, input.tool, input.arguments, invocation, new AbortController().signal);
  await verifyMcpIdentity(identity, env);
  return result;
}
