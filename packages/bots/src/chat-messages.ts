import { createHash } from "node:crypto";
import { z } from "zod";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const messageCursor = z.strictObject({ sourceId: z.string(), line: z.number().int().nonnegative(), prefixHash: z.string() });
export const chatMessagePage = z.strictObject({ cursor: messageCursor, reset: z.boolean(), hasMore: z.boolean(), entries: z.array(z.strictObject({
  key: z.string(), revision: z.string(), line: z.number().int(), role: z.enum(["user", "assistant"]),
  text: z.string().nullable(), textChars: z.number().int(), timestamp: z.string().nullable(), phase: z.string().nullable(),
})) });

export function messageText(payload: Record<string, unknown>): string {
  if (!Array.isArray(payload.content)) return "";
  return payload.content.flatMap((part) => {
    const value = object(part);
    return ["input_text", "output_text", "text"].includes(String(value.type)) && typeof value.text === "string" ? [value.text] : [];
  }).join("\n");
}

/** Validate the consumed prefix, not timestamps: newly materialized old data is new input. */
export function pageMessages(content: string, sourceId: string, cursor: z.infer<typeof messageCursor> | undefined, headOnly: boolean, limit: number) {
  const lines = content.split("\n");
  lines.pop(); // Never consume an unfinished JSONL write.
  const prefix = (line: number) => hash(lines.slice(0,line).join("\n"));
  const reset = Boolean(cursor && (cursor.sourceId !== sourceId || cursor.line > lines.length || prefix(cursor.line) !== cursor.prefixHash));
  const meta = object(object(JSON.parse(lines[0] || "{}")).payload);
  const startOrdinal = typeof meta.subagent_history_start_ordinal === "number" ? meta.subagent_history_start_ordinal : 0;
  let at = headOnly ? lines.length : reset ? 0 : cursor?.line ?? 0;
  const entries: z.infer<typeof chatMessagePage>["entries"] = [];
  while (at < lines.length && entries.length < limit) {
    const line = ++at;
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(lines[line-1]!)); } catch { continue; }
    if (value.type !== "response_item") continue;
    if (startOrdinal && !(typeof value.ordinal === "number" && value.ordinal >= startOrdinal)) continue;
    const payload = object(value.payload);
    if (payload.type !== "message" || !["user", "assistant"].includes(String(payload.role)) || payload.channel === "analysis") continue;
    const text = messageText(payload);
    if (!text.trim()) continue;
    if (payload.role === "user" && ["<environment_context>", "<recommended_plugins>", "<user_instructions>", "# AGENTS.md", "<permissions instructions>"].some((marker) => text.startsWith(marker))) continue;
    const key = typeof payload.id === "string" && payload.id ? `item:${payload.id}` : typeof value.ordinal === "number" ? `ordinal:${value.ordinal}` : `${sourceId}:line:${line}`;
    entries.push({ key, revision:hash(text), line, role:payload.role as "user" | "assistant", text:text.length <= 8_000 ? text : null,
      textChars:text.length, timestamp:typeof value.timestamp === "string" ? value.timestamp : null, phase:typeof payload.phase === "string" ? payload.phase : null });
  }
  return { cursor:{sourceId,line:at,prefixHash:prefix(at)}, reset, hasMore:at < lines.length, entries };
}
