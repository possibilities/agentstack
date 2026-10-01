import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { catalogEntry, catalogVariant } from "./schema.js";

type Variant = z.infer<typeof catalogVariant>;
type Schema = Record<string, any>;
const root = dirname(createRequire(import.meta.url).resolve("@octokit/openapi-webhooks/package.json"));
const cached = new Map<Variant, { document: Schema; entries: z.infer<typeof catalogEntry>[] }>();
function actionInfo(document: Schema, schema: Schema): { values: string[]; custom: boolean } {
  const values = new Set<string>(); let custom = false;
  const visited = new Set<Schema>();
  const visit = (value: Schema) => {
    if (visited.has(value)) return; visited.add(value);
    const action = value.properties?.action;
    if (action) { if (action.enum) for (const name of action.enum) values.add(name); else custom = true; }
    if (value.$ref) visit(document.components.schemas[value.$ref.split("/").at(-1)]);
    for (const key of ["oneOf", "allOf", "anyOf"]) for (const item of value[key] ?? []) visit(item);
  };
  visit(schema); return { values: [...values], custom };
}

/** Load only the selected provider document, not the dependency's entire 37 MB ESM graph. */
function load(variant: Variant) {
  const old = cached.get(variant); if (old) return old;
  const document = JSON.parse(readFileSync(join(root, "generated", `${variant}.json`), "utf8")) as Schema;
  const grouped = new Map<string, z.infer<typeof catalogEntry>>();
  for (const value of Object.values(document.webhooks) as Schema[]) {
    const op = value.post;
    const event = op["x-github"].subcategory.replace(/-/g, "_");
    let entry = grouped.get(event);
    if (!entry) {
      entry = { event, summary: op.summary ?? "", documentationUrl: op.externalDocs.url,
        supportedWebhookTypes: [], actions: [], customActions: false, cloudOnly: !!op["x-github"].githubCloudOnly };
      grouped.set(event, entry);
    }
    for (const upstream of op["x-github"]["supported-webhook-types"] ?? []) {
      const kind = upstream === "business" ? "enterprise" : upstream;
      if (!entry.supportedWebhookTypes.includes(kind)) entry.supportedWebhookTypes.push(kind);
    }
    const schemaRef = op.requestBody.content["application/json"].schema.$ref;
    const schema = document.components.schemas[schemaRef.split("/").at(-1)];
    const actions = actionInfo(document, schema);
    entry.customActions ||= actions.custom;
    for (const action of actions.values.length ? actions.values : [null]) entry.actions.push({ action, description: op.description ?? "", schemaRef });
  }
  const result = { document, entries: [...grouped.values()].sort((a, b) => a.event.localeCompare(b.event)).map(item => catalogEntry.parse(item)) };
  cached.set(variant, result); return result;
}
export function eventCatalog(variant: Variant, event?: string, kind?: string) {
  const { document, entries } = load(variant);
  return { source: "https://github.com/octokit/openapi-webhooks", version: document.info.version as string, variant,
    variants: catalogVariant.options, entries: entries.filter(item => (!event || item.event === event) && (!kind || item.supportedWebhookTypes.includes(kind === "business" ? "enterprise" : kind))),
    futureEventsAccepted: true as const };
}
export function knownEvent(event: string): boolean { return load("api.github.com").entries.some(item => item.event === event); }

/** A self-contained schema bundle: retain every reachable component, including recursive references. */
export function eventSchema(variant: Variant, event: string, action?: string) {
  const { document, entries } = load(variant);
  const entry = entries.find(item => item.event === event);
  if (!entry) throw new Error("github_event_not_in_catalog: intake still accepts unknown event names");
  const choices = entry.actions.filter(item => action === undefined || entry.customActions || item.action === action);
  if (!choices.length) throw new Error("github_action_not_in_catalog");
  const components: Schema = {};
  const queue = choices.map(item => item.schemaRef);
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string") queue.push(child);
      else visit(child);
    }
  };
  while (queue.length) {
    const ref = queue.pop()!;
    if (!ref.startsWith("#/components/schemas/")) throw new Error("github_catalog_reference_unsupported");
    const name = ref.slice("#/components/schemas/".length);
    if (Object.hasOwn(components, name)) continue;
    const value = document.components.schemas[name];
    if (!value) throw new Error("github_catalog_reference_missing");
    components[name] = value; visit(value);
  }
  return JSON.stringify({ openapi: document.openapi, event, actions: choices, schema: { oneOf: choices.map(item => ({ $ref: item.schemaRef })) }, components: { schemas: components } });
}
