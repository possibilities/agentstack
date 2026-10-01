import { z } from "zod";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { operation, type InvocationContext } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";

/** Experimental MCP Events draft, poll profile. Not socket invalidations. */
export type EventSource = {
  name: string; description: string; delivery: ["poll"];
  inputSchema: Record<string, unknown>; payloadSchema: Record<string, unknown>;
};
export const occurrence = z.strictObject({ eventId: z.string().min(1).max(512), name: z.string().min(1),
  timestamp: z.iso.datetime(), data: z.record(z.string(), z.unknown()) });
export type Occurrence = z.infer<typeof occurrence>;
export const pollInput = z.strictObject({ name: z.string().min(1).max(64), arguments: z.record(z.string(), z.unknown()).default({}),
  cursor: z.string().min(1).max(4096).nullable().default(null), maxAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  maxEvents: z.number().int().min(1).max(50).default(25) });
export type PollInput = z.infer<typeof pollInput>;
export const pollOutput = z.strictObject({ events: z.array(occurrence).max(50), cursor: z.string().nullable(),
  truncated: z.boolean(), hasMore: z.boolean(), nextPollMs: z.number().int().min(1000).max(3_600_000) });
export type PollOutput = z.infer<typeof pollOutput>;

/** A typed read operation supplies occurrence behavior through every gateway. */
export function pollEvent<Ctx, Input extends z.ZodType, Payload extends z.ZodType>(definition: {
  name: string; operation: string; description: string; input: Input; payload: Payload;
  poll(ctx: Ctx, args: z.infer<Input>, request: PollInput, invocation?: InvocationContext): Promise<PollOutput>;
}) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(definition.name)) throw new Error("invalid occurrence name");
  const source: EventSource = { name: definition.name, description: definition.description, delivery: ["poll"],
    inputSchema: publishedJsonSchema(definition.input), payloadSchema: publishedJsonSchema(definition.payload) };
  return operation({ name: definition.operation, description: definition.description, input: pollInput, output: pollOutput,
    annotations: { readOnlyHint: true }, eventSource: source,
    async call(ctx: Ctx, request, invocation) {
      if (request.name !== definition.name) throw new McpError(-32011, "NotFound", { kind: "event" });
      const args = definition.input.safeParse(request.arguments);
      if (!args.success) throw new McpError(-32602, "InvalidParams", { reason: "event_arguments" });
      const result = pollOutput.parse(await definition.poll(ctx, args.data, request, invocation));
      if (result.events.length > request.maxEvents) throw new Error("occurrence source exceeded maxEvents");
      for (const event of result.events) {
        if (event.name !== source.name) throw new Error("occurrence source returned another event name");
        definition.payload.parse(event.data);
      }
      return result;
    },
  });
}
