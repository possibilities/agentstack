import type { Bot, JsonSchema, OperationDoc, VoiceCall } from "./types";

/** Dedicated controls cover these operations; every other Bots operation is in the workbench. */
export const botControlOperations = new Set([
  "bot_list", "bot_start", "bot_stop", "bot_assign", "bot_remove", "bot_defaults_get", "bot_defaults_set",
  "voice_status", "voice_dial", "voice_hangup",
]);

export function inputKind(schema: JsonSchema): string {
  // Publication expands type arrays (including nullable types) into anyOf.
  // Mixed/nullable values use JSON so null stays distinct from the string "null".
  const types = schema.anyOf ? schema.anyOf.map(inputKind) : Array.isArray(schema.type) ? schema.type : [schema.type];
  const unique = [...new Set(types)];
  return unique.length === 1 && unique[0] && unique[0] !== "null" ? unique[0] : "json";
}

export function inputRequired(operation: OperationDoc, key: string): boolean {
  return Boolean(operation.inputSchema.required?.includes(key) && operation.inputSchema.properties?.[key]?.default === undefined);
}

export function connectedVoiceSession(bot: Bot, call: VoiceCall | null): string {
  return call?.botId === bot.id && call.phase === "connected" && call.threadId === bot.mainThreadId ? call.sessionId : "";
}

export function operationNeedsLiveBot(operation: OperationDoc): boolean {
  return operation.annotations.readOnlyHint !== true && !["chat_enqueue", "chat_upload_start", "chat_upload_chunk", "chat_upload_finish", "chat_queue_resolve"].includes(operation.name);
}

/** Revalidate against the latest store snapshot immediately before submission. */
export function operationScopeError(operation: OperationDoc, input: Record<string, unknown>, bot: Bot, call: VoiceCall | null): string | null {
  if (operation.annotations.readOnlyHint === true) return null;
  if (operation.inputSchema.properties?.threadId && (!bot.mainThreadId || input.threadId !== bot.mainThreadId)) return "Actions are limited to this Bot’s current main thread. Descendants are read-only.";
  if (operation.name === "voice_speak" && (!connectedVoiceSession(bot, call) || input.sessionId !== connectedVoiceSession(bot, call))) return "Select this Bot’s exact current connected voice call before speaking.";
  if (operationNeedsLiveBot(operation) && (bot.state !== "running" || bot.recoveryIssue || !bot.runningAccount)) return "This action needs a verified running Bot with a launched account.";
  return null;
}

export function botOperationDraft(operation: OperationDoc, bot: Bot, call: VoiceCall | null): Record<string, string> {
  const fields = operation.inputSchema.properties ?? {};
  const draft: Record<string, string> = {};
  if (fields.botId) draft.botId = bot.id;
  if (fields.threadId) draft.threadId = bot.mainThreadId ?? "";
  if (fields.sessionId) draft.sessionId = connectedVoiceSession(bot, call);
  if (fields.input) draft.input = JSON.stringify([{ type: "text", text: "" }], null, 2);
  for (const key of ["clientUserMessageId", "id"]) {
    if (fields[key]?.format === "uuid" && (key === "clientUserMessageId" || ["chat_enqueue", "chat_upload_start"].includes(operation.name))) draft[key] = crypto.randomUUID();
  }
  return draft;
}

export function parseOperationDraft(operation: OperationDoc, draft: Record<string, string>, botId: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(operation.inputSchema.properties ?? {})) {
    if (key === "botId") { input[key] = botId; continue; }
    const text = draft[key] ?? "";
    if (!text.trim()) {
      if (inputRequired(operation, key)) throw new Error(`${key} is required`);
      continue;
    }
    const kind = inputKind(schema);
    if (kind === "string") input[key] = text;
    else {
      try { input[key] = JSON.parse(text); }
      catch { throw new Error(`${key} must be valid ${kind === "json" ? "JSON" : kind}`); }
      if (kind === "integer" && !Number.isInteger(input[key])) throw new Error(`${key} must be an integer`);
      if (kind === "number" && typeof input[key] !== "number") throw new Error(`${key} must be a number`);
      if (kind === "boolean" && typeof input[key] !== "boolean") throw new Error(`${key} must be true or false`);
      if (kind === "array" && !Array.isArray(input[key])) throw new Error(`${key} must be a JSON array`);
      if (kind === "object" && (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key]))) throw new Error(`${key} must be a JSON object`);
    }
  }
  return input;
}
