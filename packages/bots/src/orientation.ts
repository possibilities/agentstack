import { randomUUID } from "node:crypto";
import { z } from "zod";
import { chatRpc } from "./chats.js";

export const orientationState = z.strictObject({
  admissionId: z.uuid(),
  state: z.enum(["pending", "creating", "ready", "submitting", "running", "completed", "failed", "interrupted", "unknown", "retired"]),
  threadId: z.string().nullable(), turnId: z.string().nullable(), issue: z.string().nullable(), updatedAt: z.number().int(),
});
export type Orientation = z.infer<typeof orientationState>;
export const orientationSettled = (orientation: Orientation | null | undefined): boolean => !orientation || ["completed", "failed", "interrupted", "retired"].includes(orientation.state);
export const pendingOrientation = (): Orientation => ({ admissionId: randomUUID(), state: "pending", threadId: null, turnId: null, issue: null, updatedAt: Date.now() });

export function orientationPrompt(botId: string, admissionId: string): string {
  return `[Stack orientation ${admissionId}]\n\nThis is a one-time initialization request from Stack, not a message or authorization from the human.
You are Bot ${botId}. Read your captured Role instructions and its bot.md personality, then orient yourself to the available workspace and capabilities.
Keep this bounded: use only the context already supplied and a few local read-only inspections if useful. Do not modify files, start work, dispatch agents, use mutating tools, browse or research online, contact anyone, or create schedules or goals. Tool availability is not permission.
Then briefly introduce yourself in your Role's voice and offer one or two concrete ways you can help, grounded in what you actually know. Do not invent memories, claim completed work, ask an onboarding questionnaire, or present a menu of personality choices. Leave room for the human's next message. This introduction should happen only once.`;
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
function matchesPrompt(turn: Record<string, unknown>, marker: string): boolean {
  return Array.isArray(turn.items) && turn.items.some((value) => {
    const item = object(value);
    return item.type === "userMessage" && Array.isArray(item.content) && item.content.some((part) => {
      const input = object(part);
      return input.type === "text" && typeof input.text === "string" && input.text.startsWith(marker);
    });
  });
}

/** Read exact native evidence, never infer orientation completion from thread idle or another turn. */
export async function readOrientationTurn(url: string, orientation: Orientation): Promise<{ threadId: string; turnId: string; state: Orientation["state"] } | null> {
  if (!orientation.threadId) return null; // An uncertain thread/start is not permission to adopt an arbitrary root.
  let cursor: string | null = null;
  const marker = `[Stack orientation ${orientation.admissionId}]`;
  for (let page = 0; page < 20; page++) {
    const result = await chatRpc(url, "thread/turns/list", { threadId: orientation.threadId, cursor, limit: 100, sortDirection: "asc", itemsView: "full" });
    if (!Array.isArray(result.data)) throw new Error("Invalid native orientation history");
    for (const value of result.data) {
      const turn = object(value);
      if (orientation.turnId ? turn.id !== orientation.turnId : !matchesPrompt(turn, marker)) continue;
      if (typeof turn.id !== "string") throw new Error("Invalid native orientation turn ID");
      const state = turn.status === "inProgress" ? "running" : turn.status;
      if (!["running", "completed", "failed", "interrupted"].includes(String(state))) throw new Error("Unknown native orientation outcome");
      return { threadId: orientation.threadId, turnId: turn.id, state: state as Orientation["state"] };
    }
    if (result.nextCursor === null) return null;
    if (typeof result.nextCursor !== "string" || !result.nextCursor || result.nextCursor === cursor) throw new Error("Invalid native orientation cursor");
    cursor = result.nextCursor;
  }
  throw new Error("Orientation history exceeds the reconciliation bound");
}
