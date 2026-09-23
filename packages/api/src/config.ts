import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

export const transportTypes = ["socket", "mcp", "websocket"] as const;
export type TransportType = (typeof transportTypes)[number];

const blurb = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0 && value.length <= 400, {
    message: "description must be 1-400 characters",
  });

const topicName = /^[a-z][a-z0-9_]{0,63}$/;

const transportSchema = z
  .object({
    description: blurb,
  })
  .strict();

const websocketSchema = z
  .object({
    description: blurb,
    pubsub: z.record(z.string().regex(topicName), blurb).optional(),
  })
  .strict();

const configSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
    description: blurb,
    socket: transportSchema.optional(),
    mcp: transportSchema.optional(),
    websocket: websocketSchema.optional(),
  })
  .strict()
  .refine((config) => transportTypes.some((type) => config[type] !== undefined), {
    message: "at least one transport is required",
  });

export type TransportConfig = z.infer<typeof transportSchema>;
export type WebsocketConfig = z.infer<typeof websocketSchema>;
export type PackageConfig = z.infer<typeof configSchema>;

export function parseConfig(text: string, label = "api.yaml"): PackageConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${message}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || label;
    throw new Error(`${label}: ${path}: ${issue?.message ?? "invalid config"}`);
  }
  return parsed.data;
}

export async function readConfig(file: string): Promise<PackageConfig> {
  return parseConfig(await readFile(file, "utf8"), file);
}

export function configuredTransports(config: PackageConfig): Array<{ type: TransportType; description: string }> {
  return transportTypes.flatMap((type) => {
    const transport = config[type];
    return transport ? [{ type, description: transport.description }] : [];
  });
}

export function isTransportType(value: string): value is TransportType {
  return (transportTypes as readonly string[]).includes(value);
}
