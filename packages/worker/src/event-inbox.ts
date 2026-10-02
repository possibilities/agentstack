import { z } from "zod";

export const workerEventInput = z.strictObject({ id: z.uuid(), sessionId: z.string().min(1).max(256), instance: z.uuid(),
  deliveryId: z.uuid(), package: z.string().min(1).max(32), eventId: z.string().min(1).max(512), name: z.string().min(1).max(64),
  text: z.string().min(1).max(16_000), policy: z.enum(["native", "interrupt"]) });
export type WorkerEventInput = z.infer<typeof workerEventInput>;
export const workerEventReceipt = z.strictObject({ deliveryId: z.uuid(), workerId: z.uuid(), sessionId: z.string(),
  state: z.enum(["queued", "interrupting", "dispatched", "unknown", "cancelled"]), turnId: z.uuid().nullable(),
  issue: z.string().nullable(), createdAt: z.number(), updatedAt: z.number() });
export type WorkerEventReceipt = z.infer<typeof workerEventReceipt>;
export type WorkerEvent = WorkerEventReceipt & { input: WorkerEventInput };
