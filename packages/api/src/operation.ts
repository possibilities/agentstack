import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { InvocationContext } from "./invocation.js";
export type { InvocationContext } from "./invocation.js";

export type McpContent = CallToolResult["content"];

export type Annotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

/** Explicit owner opt-in. Open only the resources this operation needs, never
 * the service context. The same handler, schemas and MCP presentation run in
 * either context; the gateway always closes a standalone context per call. */
export type StandaloneContext<Ctx> = {
  open(env: NodeJS.ProcessEnv, signal?: AbortSignal): Ctx | Promise<Ctx>;
  close(ctx: Ctx): void | Promise<void>;
};

export type AnyOperation<Ctx> = {
  name: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations?: Annotations;
  // Erase the standalone context at the heterogeneous package boundary. The
  // operation factory checks it against the handler's (possibly narrower) Ctx.
  standalone?: NoInfer<StandaloneContext<any>>;
  call(ctx: Ctx, input: any, invocation?: InvocationContext): Promise<any>;
  /** Optional MCP presentation of the validated output. Ordinary socket calls
   * and WebSocket callers still receive the operation's declared JSON output. */
  mcpContent?(ctx: Ctx, input: any, output: any): McpContent | Promise<McpContent>;
};

export type PackageEvents<Ctx, Topic extends string = string> = {
  topics: Readonly<Record<Topic, string>>;
  /** Unscoped subscribers receive every notice. A scoped subscriber receives
   * only notices published with that exact scope, never unscoped notices. */
  scope?: {
    description: string;
    example: string;
    required?: boolean;
    valid(ctx: Ctx, scope: string): boolean;
  };
  start(ctx: Ctx, publish: (topic: Topic, scope?: string) => void): (() => void) | void | Promise<(() => void) | void>;
};

export type PackageApi<Ctx, Topic extends string = string> = {
  operations: readonly AnyOperation<Ctx>[];
  events?: PackageEvents<Ctx, Topic>;
  /** Non-control HTTP origins owned by this package context. Routes are an
   * explicit positive selection; declaring HTTP never exports operations from
   * the local socket/MCP/WebSocket control surface. */
  http?: readonly {
    name: string;
    kind: "json" | "static";
    authentication: "bearer" | "none";
    description: string;
    routes: readonly {
      method: string;
      path: string;
      description: string;
      format: string;
      operation?: AnyOperation<any>;
      /** HTTP wire schemas, not the operation's normalized internal schemas. */
      request?: z.ZodType;
      query?: z.ZodType;
      response?: z.ZodType;
      error?: z.ZodType;
    }[];
  }[];
  createContext(env: NodeJS.ProcessEnv): Promise<Ctx>;
  /**
   * Stop admission and signal cancellation after events stop, before socket
   * calls drain. Keep resources used by active calls open until closeContext.
   * Also runs if startup fails after createContext has returned successfully.
   */
  prepareCloseContext?(ctx: Ctx, options?: { halt?: boolean }): void | Promise<void>;
  closeContext(ctx: Ctx, options?: { halt?: boolean }): Promise<void>;
};

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;

export function packageEventTopics<Ctx>(name: string, events: PackageEvents<Ctx, string>): Record<string, string> {
  const topics: Record<string, string> = {};
  for (const [topic, description] of Object.entries(events.topics)) {
    if (!namePattern.test(topic)) throw new Error(`${name} event topic is invalid: ${topic}`);
    const blurb = description.trim();
    if (blurb.length === 0 || blurb.length > 400) throw new Error(`${name} event ${topic} description must be 1-400 characters`);
    topics[topic] = blurb;
  }
  if (Object.keys(topics).length === 0) throw new Error(`${name} must declare at least one event topic`);
  return topics;
}

export function operation<Ctx, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(op: {
  name: string;
  description: string;
  input: InputSchema;
  output: OutputSchema;
  annotations?: Annotations;
  standalone?: StandaloneContext<Ctx>;
  call(ctx: Ctx, input: z.infer<InputSchema>, invocation?: InvocationContext): Promise<z.infer<OutputSchema>>;
  mcpContent?(ctx: Ctx, input: z.infer<InputSchema>, output: z.infer<OutputSchema>): McpContent | Promise<McpContent>;
}): {
  name: string;
  description: string;
  input: InputSchema;
  output: OutputSchema;
  annotations?: Annotations;
  standalone?: NoInfer<StandaloneContext<Ctx>>;
  call(ctx: Ctx, input: z.infer<InputSchema>, invocation?: InvocationContext): Promise<z.infer<OutputSchema>>;
  mcpContent?(ctx: Ctx, input: z.infer<InputSchema>, output: z.infer<OutputSchema>): McpContent | Promise<McpContent>;
} {
  if (!namePattern.test(op.name)) throw new Error(`invalid operation name: ${op.name}`);
  const description = op.description.trim();
  if (description.length === 0 || description.length > 400) {
    throw new Error(`${op.name} description must be 1-400 characters`);
  }
  if (op.annotations?.title && op.annotations.title.trim().length > 80) {
    throw new Error(`${op.name} title must be at most 80 characters`);
  }
  return { ...op, description };
}
