import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AnyOperation, InvocationContext } from "./operation.js";

/** One validation and presentation boundary for socket and standalone owners. */
export async function executeOperation<Ctx>(operation: AnyOperation<Ctx>, ctx: Ctx, input: unknown,
  invocation?: InvocationContext, format?: "mcp") {
  const parsed = operation.input.parse(input);
  const result = operation.output.parse(await operation.call(ctx, parsed, invocation));
  if (format !== "mcp") return result;
  const content = operation.mcpContent ? await operation.mcpContent(ctx, parsed, result)
    : [{ type: "text" as const, text: JSON.stringify(result) }];
  return CallToolResultSchema.parse({ structuredContent: result, content });
}
