import type { z } from "zod";

export type Annotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type AnyOperation<Ctx> = {
  name: string;
  description: string;
  input: z.ZodType;
  output: z.ZodType;
  annotations?: Annotations;
  call(ctx: Ctx, input: any): Promise<any>;
};

export type PackageApi<Ctx> = {
  operations: readonly AnyOperation<Ctx>[];
  createContext(env: NodeJS.ProcessEnv): Promise<Ctx>;
  closeContext(ctx: Ctx, options?: { halt?: boolean }): Promise<void>;
  uiData?(ctx: Ctx, request?: URL): Promise<unknown>;
};

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;

export function operation<Ctx, InputSchema extends z.ZodType, OutputSchema extends z.ZodType>(op: {
  name: string;
  description: string;
  input: InputSchema;
  output: OutputSchema;
  annotations?: Annotations;
  call(ctx: Ctx, input: z.infer<InputSchema>): Promise<z.infer<OutputSchema>>;
}): {
  name: string;
  description: string;
  input: InputSchema;
  output: OutputSchema;
  annotations?: Annotations;
  call(ctx: Ctx, input: z.infer<InputSchema>): Promise<z.infer<OutputSchema>>;
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
