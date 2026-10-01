import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { InvocationContext } from "./operation.js";
import type { McpEventSubscriptions } from "./mcp-subscriptions.js";
import { currentMcpCatalog, type SocketCatalog } from "./exposure.js";
import { mcpInvocation, parseMcpBinding, verifyMcpIdentity } from "./mcp-authority.js";

export const subscriptionTools: Tool[] = [
  { name: "events_catalog", description: "List this Package API's event topics, scope rule, and read-only operations that can supply subscription values.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "events_subscribe", description: "Subscribe this Bot thread to a topic and read-only snapshot operation. Return the first value now; later changed snapshots arrive as standalone tool output through Codex start-or-steer. Idle threads wake; working threads receive pending input at Codex's processing boundary. Stack never waits for idle or turn completion. Repeating the same request returns the existing subscription.", inputSchema: {
    type: "object", properties: { topic: { type: "string" }, scope: { type: "string" }, readOperation: { type: "string" }, readArguments: { type: "object", additionalProperties: true } },
    required: ["topic", "readOperation"], additionalProperties: false,
  } },
  { name: "events_status", description: "List this Chat's watches and latest 128 completion receipts, or one exact completionId. Observed means the initial result was terminal; delivered means native admission acknowledged, not consumption. Unknown is never replayed automatically. completionsTruncated means older receipts need their exact ID.", inputSchema: { type: "object", properties: { completionId: { type: "string", format: "uuid" } }, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: "events_unsubscribe", description: "Stop one exact subscription for this Bot thread.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false } },
];

export type McpEventCall = (pkg: string, tool: string, args: Record<string, unknown>, invocation: InvocationContext, signal: AbortSignal) => Promise<object>;
const subscriptionInput = z.strictObject({ topic: z.string().min(1), scope: z.string().optional(), readOperation: z.string().min(1), readArguments: z.record(z.string(), z.unknown()).optional() });

export function mcpEventCatalog(doc: SocketCatalog) {
  return { topics: doc.events?.topics ?? {}, scope: doc.events?.scope ?? null,
    reads: doc.tools.filter(tool => tool.annotations?.readOnlyHint).map(({ name, description, inputSchema }) => ({ name, description: description ?? "", inputSchema })) };
}

/** Runs only in the serve owner; both local HTTP and private stdio relays use it. */
export function subscriptionService(service: McpEventSubscriptions, root: string, env: NodeJS.ProcessEnv): McpEventCall {
  return async (pkg, tool, args, invocation, signal) => {
    signal.throwIfAborted();
    const listed = await currentMcpCatalog(root, pkg, env);
    if (tool === "operation_watch") {
      await service.validateInvocation(invocation);
      const input = z.strictObject({ operation: z.string(), input: z.record(z.string(), z.unknown()) }).parse(args);
      return service.callAndWatch(pkg, input.operation, input.input, invocation);
    }
    if (!Object.keys(listed.events?.topics ?? {}).length) throw new Error("event subscriptions are unavailable over mcp");
    if (tool === "events_catalog") return service.catalog(pkg, listed);
    await service.validateInvocation(invocation);
    if (tool === "events_subscribe") {
      const input = subscriptionInput.parse(args);
      if (!Object.hasOwn(listed.events?.topics ?? {}, input.topic) || !listed.tools.some(tool => tool.name === input.readOperation && tool.annotations?.readOnlyHint))
        throw new Error("subscription requires a selected topic and exposed read-only operation");
      return service.subscribe(pkg, input, invocation);
    }
    if (tool === "events_status") return service.status(invocation, z.strictObject({ completionId: z.uuid().optional() }).parse(args).completionId);
    if (tool === "events_unsubscribe") return service.unsubscribe(z.strictObject({ id: z.uuid() }).parse(args).id, invocation);
    throw new Error(`unknown event tool: ${tool}`);
  };
}

export const mcpEventRelayInput = z.strictObject({
  binding: z.string().min(1).max(512), pkg: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
  tool: z.enum(["events_catalog", "events_subscribe", "events_status", "events_unsubscribe", "operation_watch"]),
  arguments: z.record(z.string(), z.unknown()), threadId: z.string().min(1).max(128), sessionId: z.string().max(128).nullable(),
});

/** Independently authenticate the relay. Never trust a caller-supplied InvocationContext. */
export async function relayMcpEvent(service: McpEventSubscriptions, input: z.infer<typeof mcpEventRelayInput>, root: string, env: NodeJS.ProcessEnv): Promise<object> {
  const identity = parseMcpBinding(input.binding, env);
  if (!("botId" in identity)) throw new Error("event relay requires a Bot launch binding");
  await verifyMcpIdentity(identity, env);
  const invocation = mcpInvocation(identity, input);
  await service.validateInvocation(invocation);
  const result = await subscriptionService(service, root, env)(input.pkg, input.tool, input.arguments, invocation, new AbortController().signal);
  await verifyMcpIdentity(identity, env);
  return result;
}
