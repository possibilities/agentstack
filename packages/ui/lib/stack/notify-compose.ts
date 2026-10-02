import type { JsonSchema, OperationDoc, PackageDoc } from "./types";

export type NotificationKind = "notice" | "question" | "reply";
export const composeFields = ["title", "message", "subtitle", "source", "group", "open", "actions", "reply"] as const;
export type ComposeField = typeof composeFields[number];
export type NotificationInput = { id: string; title: string; message: string; subtitle?: string; source?: string; group?: string; open?: string; actions?: string[]; reply?: string };
export type ComposeValues = { kind: NotificationKind; title: string; message: string; subtitle: string; source: string; group: string; open: string; actions: string[]; reply: string };
export type NotificationDraft = { version: 1; id: string; values: ComposeValues; input: NotificationInput | null; sent: boolean };
export const emptyCompose = (): ComposeValues => ({ kind: "notice", title: "", message: "", subtitle: "", source: "", group: "", open: "", actions: [], reply: "" });

/** Discovery is already intersected with the viewer's live exposure. Scope alone never grants a send. */
export function notificationSendAccess(state: { catalog: { data: PackageDoc[] | null }; remote?: { scope: "view" | "control" } }): { operation: OperationDoc | null; exposed: boolean; reason: string | null } {
  const doc = state.catalog.data?.find(item => item.name === "notify");
  const operation = doc?.operations.find(item => item.name === "notification_send") ?? null;
  const exposed = Boolean(operation && doc?.transports.some(transport => transport.type === "websocket" && transport.supported && transport.operations.includes("notification_send")));
  return { operation, exposed, reason: !state.catalog.data ? "Reading API discovery…" : !exposed ? "Notification sending is not exposed on this server’s WebSocket." : state.remote?.scope === "view" ? "Sending requires ui:control." : null };
}

/** Nullable strings carry their bounds on the string branch, not on the nullable wrapper. */
export function composeSchema(schema: JsonSchema | undefined): JsonSchema | undefined {
  return schema?.anyOf?.find(item => item.type !== "null") ?? schema;
}

export function notificationInput(id: string, values: ComposeValues, schema: JsonSchema): NotificationInput {
  const fields = schema.properties ?? {};
  const input: NotificationInput = { id, title: values.title.trim(), message: values.message.trim() };
  for (const key of ["subtitle", "source", "group", "open"] as const) if (fields[key] && values[key].trim()) input[key] = values[key].trim();
  if (values.kind === "question" && fields.actions) input.actions = values.actions.map(item => item.trim());
  if (values.kind === "reply" && fields.reply) input.reply = values.reply.trim();
  // No subscribe field: these are operator sends, never Bot-watch admission.
  return input;
}

export function composeErrors(input: NotificationInput, kind: NotificationKind, schema: JsonSchema): Partial<Record<ComposeField, string>> {
  const errors: Partial<Record<ComposeField, string>> = {};
  const fields = schema.properties ?? {};
  for (const key of composeFields) {
    const rule = composeSchema(fields[key]);
    const value = input[key];
    if (!rule) { if (value !== undefined || key === "title" || key === "message") errors[key] = "This field is not declared by the live send schema."; continue; }
    if (typeof value === "string") {
      if (!value && (schema.required?.includes(key) || key === "title" || key === "message" || key === "reply")) errors[key] = "Enter a value.";
      if (typeof rule.minLength === "number" && value.length < rule.minLength) errors[key] = `Use at least ${rule.minLength} characters.`;
      if (typeof rule.maxLength === "number" && value.length > rule.maxLength) errors[key] = `Use at most ${rule.maxLength} characters.`;
    } else if (schema.required?.includes(key) && value === undefined) errors[key] = "Enter a value.";
  }
  if (kind === "question") {
    const actions = input.actions ?? [];
    const rule = composeSchema(fields.actions);
    const item = composeSchema(rule?.items);
    if (!actions.length || actions.some(value => !value)) errors.actions = "Enter each answer choice.";
    else if (new Set(actions).size !== actions.length) errors.actions = "Answer choices must be unique.";
    else if (typeof rule?.maxItems === "number" && actions.length > rule.maxItems) errors.actions = `Offer at most ${rule.maxItems} choices.`;
    else if (actions.some(value => typeof item?.maxLength === "number" && value.length > item.maxLength)) errors.actions = `Use at most ${item?.maxLength} characters per choice.`;
  }
  if (kind === "reply" && !input.reply) errors.reply = "Enter a reply placeholder.";
  if (input.open) {
    try { if (!["http:", "https:"].includes(new URL(input.open).protocol)) throw new Error(); }
    catch { errors.open = "Enter an absolute http(s) URL."; }
  }
  return errors;
}

/** Endpoint-pinned like the connection itself; origin separates servers using the same relative gateway path. */
export const notificationDraftKey = (origin: string, endpoint: string): string => `stack.uix.notify-compose.v1.${encodeURIComponent(origin)}.${encodeURIComponent(endpoint)}`;

/** A malformed recovery slot must not silently become a new intent. The UI offers explicit discard instead. */
export function readNotificationDraft(raw: string | null): NotificationDraft | null {
  if (raw === null) return null;
  const draft = JSON.parse(raw) as NotificationDraft;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!draft || draft.version !== 1 || !uuid.test(draft.id) || typeof draft.sent !== "boolean" || !draft.values || !["notice", "question", "reply"].includes(draft.values.kind)
    || composeFields.filter(key => key !== "actions").some(key => typeof draft.values[key] !== "string")
    || !Array.isArray(draft.values.actions) || draft.values.actions.some(item => typeof item !== "string")) throw new Error("The saved notification draft is invalid. Discard it explicitly before creating another intent.");
  if (draft.input !== null && (!draft.input || draft.input.id !== draft.id || typeof draft.input.title !== "string" || typeof draft.input.message !== "string"
    || Object.keys(draft.input).some(key => key !== "id" && !composeFields.includes(key as ComposeField))
    || composeFields.filter(key => key !== "actions").some(key => draft.input![key] !== undefined && typeof draft.input![key] !== "string")
    || (draft.input.actions !== undefined && (!Array.isArray(draft.input.actions) || draft.input.actions.some(item => typeof item !== "string"))))) throw new Error("The saved send input is invalid. Discard it explicitly before creating another intent.");
  if (draft.sent && !draft.input) throw new Error("The saved send receipt is invalid. Discard it explicitly before creating another intent.");
  return draft;
}
