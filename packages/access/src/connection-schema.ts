import { z } from "zod";
import { originSchema, secretSchema } from "./enrollment-protocol.js";

export const connectionSchema = z.strictObject({
  version: z.literal(1), serverId: z.uuid(), deviceOrigin: originSchema,
  documentOrigin: originSchema, artifactOrigin: originSchema, uiOrigin: originSchema.nullable(),
  pairing: z.array(z.enum(["manual", "invitation", "sponsor"])),
});
export type ConnectionDescriptor = z.infer<typeof connectionSchema>;
export const uiHandoffInput = z.strictObject({ requestId: z.uuid() });
export const uiHandoffSchema = z.strictObject({ url: z.string().url(), expiresAt: z.number().int().positive(), serverId: z.uuid() });
export const uiExchangeInput = z.strictObject({ handoff: secretSchema });
