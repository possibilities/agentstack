import { z } from "zod";

const label = z.string().trim().min(1).max(60);

export const content = z.strictObject({
  title: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(16_000),
  subtitle: z.string().trim().max(400).nullable().default(null),
  source: z.string().trim().min(1).max(200).nullable().default(null),
  group: z.string().trim().min(1).max(200).nullable().default(null)
    .describe("Replacement key: sending replaces the open notification with the same group."),
  open: z.url({ protocol: /^https?$/ }).max(2_000).nullable().default(null)
    .describe("http(s) URL the notification clicks through to."),
  actions: z.array(label).max(8).refine((items) => new Set(items).size === items.length, "actions must be unique").default([])
    .describe("Answer buttons, in display order."),
  reply: z.string().trim().min(1).max(200).nullable().default(null)
    .describe("Placeholder for a free-text reply; null offers no reply."),
});

export const outcome = z.enum(["closed", "opened", "action", "replied", "replaced"]);

export const notification = content.extend({
  id: z.uuid(),
  sequence: z.number().int().positive(),
  createdAt: z.string().datetime(),
  dismissedAt: z.string().datetime().nullable(),
  outcome: outcome.nullable().describe("How it was dismissed; null while open."),
  response: z.string().nullable().describe("The chosen action label or reply text; otherwise null."),
});

export const page = z.strictObject({
  entries: z.array(notification),
  nextCursor: z.number().int().positive().nullable(),
});

export type Notification = z.infer<typeof notification>;
export type Content = z.infer<typeof content>;
export type Outcome = z.infer<typeof outcome>;
