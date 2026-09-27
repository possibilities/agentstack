import { z } from "zod";

export const content = z.strictObject({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(16_000),
  subtitle: z.string().trim().max(400).nullable().default(null),
  source: z.string().trim().min(1).max(200).nullable().default(null),
});

export const notification = content.extend({
  id: z.uuid(),
  revision: z.number().int().positive(),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  acknowledgedAt: z.string().datetime().nullable(),
  dismissedAt: z.string().datetime().nullable(),
});

export const page = z.strictObject({
  entries: z.array(notification),
  nextCursor: z.number().int().positive().nullable(),
});

export type Notification = z.infer<typeof notification>;
export type Content = z.infer<typeof content>;
