import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { AnyOperation, InvocationContext } from "./operation.js";

/** A record owner explicitly proves refusal before any operation mutation.
 * Ordinary handler/output errors provide no such proof. */
export class OperationRejected extends Error {}

/** One validation and presentation boundary for socket and standalone owners. */
export async function executeOperation<Ctx>(operation: AnyOperation<Ctx>, ctx: Ctx, input: unknown,
  invocation?: InvocationContext, format?: "mcp") {
  let parsed: unknown;
  try { parsed = operation.input.parse(input); }
  catch (error) {
    throw new OperationRejected(error instanceof z.ZodError
      ? error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
      : error instanceof Error ? error.message : String(error), { cause: error });
  }
  const result = operation.output.parse(await operation.call(ctx, parsed, invocation));
  if (format !== "mcp") return result;
  const content = operation.mcpContent ? await operation.mcpContent(ctx, parsed, result)
    : [{ type: "text" as const, text: JSON.stringify(result) }];
  return CallToolResultSchema.parse({ structuredContent: result, content });
}
