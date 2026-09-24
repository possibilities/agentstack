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

export type PackageEvents<Ctx, Topic extends string = string> = {
  topics: Readonly<Record<Topic, string>>;
  start(ctx: Ctx, publish: (topic: Topic) => void): (() => void) | void | Promise<(() => void) | void>;
};

export type PackageApi<Ctx, Topic extends string = string> = {
  operations: readonly AnyOperation<Ctx>[];
  events?: PackageEvents<Ctx, Topic>;
  createContext(env: NodeJS.ProcessEnv): Promise<Ctx>;
  closeContext(ctx: Ctx, options?: { halt?: boolean }): Promise<void>;
};

const namePattern = /^[a-z][a-z0-9_]{0,63}$/;

export function packageEventTopics<Ctx>(name: string, events: PackageEvents<Ctx, string>): Record<string, string> {
  const topics: Record<string, string> = {};
  for (const [topic, description] of Object.entries(events.topics)) {
    if (!namePattern.test(topic)) throw new Error(`${name} event topic is invalid: ${topic}`);
    const blurb = description.trim();
    if (blurb.length === 0 || blurb.length > 400) throw new Error(`${name} event ${topic} description must be 1-400 characters`);
    if (topics[topic] !== undefined) throw new Error(`${name} declares duplicate event topic: ${topic}`);
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
