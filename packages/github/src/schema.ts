import { z } from "zod";

export const sequence = z.number().int().nonnegative();
export const revision = z.number().int().positive();
export const eventName = z.string().regex(/^[a-z][a-z0-9_]{0,127}$/);
const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
const repository = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/);
export const target = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("repository"), repository }),
  z.strictObject({ kind: z.literal("organization"), organization: name }),
  z.strictObject({ kind: z.literal("enterprise"), enterprise: name }),
  z.strictObject({ kind: z.literal("app"), appId: z.number().int().positive().optional() }),
  z.strictObject({ kind: z.literal("marketplace") }),
  z.strictObject({ kind: z.literal("sponsors_listing"), account: name }),
]);
export const publicOrigin = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash
    && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}, "Use an externally reachable HTTPS origin without path, credentials, query or fragment");
export const githubHost = z.string().max(253).regex(/^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/);
export const endpointCreate = z.strictObject({ id: z.uuid(), label: z.string().trim().min(1).max(200), target, githubHost: githubHost.default("github.com"), publicOrigin: publicOrigin.nullable().default(null) });
export const endpoint = z.strictObject({ id: z.uuid(), label: z.string(), target, githubHost: z.string(), publicOrigin: z.string().nullable(), path: z.string(),
  webhookUrl: z.string().nullable(), enabled: z.boolean(), revision, secretVersion: revision, previousSecretExpiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), lastDeliveryAt: z.iso.datetime().nullable(), lastPingAt: z.iso.datetime().nullable(),
  accepted: sequence, duplicates: sequence, rejected: sequence, lastFailure: z.string().nullable(), managedHookId: z.number().int().positive().nullable(), boundTargetId: z.number().int().positive().nullable() });
export type Endpoint = z.infer<typeof endpoint>;
export const scalar = z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]);
const pointer = z.string().max(1000).regex(/^(?:\/(?:[^~]|~[01])*)*$/).refine(value => value.split("/").length <= 33, "At most 32 pointer segments");
export const predicate = z.discriminatedUnion("op", [
  z.strictObject({ path: pointer, op: z.literal("equals"), value: scalar }),
  z.strictObject({ path: pointer, op: z.literal("one_of"), values: z.array(scalar).min(1).max(50) }),
  z.strictObject({ path: pointer, op: z.literal("contains"), value: scalar }),
  z.strictObject({ path: pointer, op: z.literal("starts_with"), value: z.string().max(1000) }),
  z.strictObject({ path: pointer, op: z.literal("exists"), value: z.boolean() }),
]);
const strings = (item: z.ZodString) => z.array(item).min(1).max(50);
export const filter = z.strictObject({
  endpointIds: z.array(z.uuid()).min(1).max(50).optional(), events: strings(eventName).optional(),
  actions: strings(z.string().min(1).max(128)).optional(), repositories: strings(repository).optional(),
  organizations: strings(name).optional(), enterprises: strings(name).optional(), senders: strings(name).optional(),
  installationIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  repositoryIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
  refs: strings(z.string().min(1).max(1000)).optional(), predicates: z.array(predicate).max(32).optional(),
}).refine(value => JSON.stringify(value).length <= 12_000, "Watch/query filter must fit 12,000 characters");
export type Filter = z.infer<typeof filter>;
export const entity = z.strictObject({ kind: z.string(), id: z.union([z.number(), z.string()]).nullable(), number: z.number().nullable(),
  title: z.string().nullable(), url: z.string().nullable(), state: z.string().nullable(), conclusion: z.string().nullable() });
export const delivery = z.strictObject({ sequence: sequence.refine(value => value > 0), endpointId: z.uuid(), deliveryId: z.string(), event: z.string(), action: z.string().nullable(),
  receivedAt: z.iso.datetime(), contentType: z.enum(["application/json", "application/x-www-form-urlencoded"]), hookId: z.string().nullable(), targetType: z.string().nullable(), targetId: z.string().nullable(),
  repository: z.string().nullable(), repositoryId: z.number().nullable(), organization: z.string().nullable(), enterprise: z.string().nullable(), sender: z.string().nullable(),
  installationId: z.number().nullable(), ref: z.string().nullable(), sha: z.string().nullable(), entities: z.array(entity),
  payloadBytes: sequence, payloadSha256: z.string(), payloadClearedAt: z.iso.datetime().nullable(), knownEvent: z.boolean() });
export type Delivery = z.infer<typeof delivery>;
export const watch = z.strictObject({ id: z.uuid(), label: z.string(), filter, enabled: z.boolean(), revision, startAfter: sequence, acknowledgedThrough: sequence,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), scope: z.string() });
export type Watch = z.infer<typeof watch>;
export const watchCreate = z.strictObject({ id: z.uuid(), label: z.string().trim().min(1).max(200), filter: filter.default({}),
  start: z.union([z.literal("now"), sequence]).default("now") });
export const deliveryPageInput = z.strictObject({ after: sequence.default(0), through: sequence.optional(), limit: z.number().int().min(1).max(50).default(25), filter: filter.default({}) });
export const deliveryPage = z.strictObject({ entries: z.array(delivery), after: sequence, through: sequence, nextCursor: sequence.nullable() });
export const watchRead = z.strictObject({ watch, entries: z.array(delivery), pending: sequence, through: sequence, nextCursor: sequence.nullable() });
export const chunkInput = z.strictObject({ sequence: sequence.refine(value => value > 0), offset: sequence.default(0), limit: z.number().int().min(1).max(100_000).default(32_000) });
export const chunk = z.strictObject({ sequence, text: z.string(), encoding: z.literal("utf8"), totalChars: sequence, nextOffset: sequence.nullable(), sha256: z.string(), cleared: z.boolean() });
export const catalogVariant = z.enum(["api.github.com", "ghec", "ghes-3.14", "ghes-3.15", "ghes-3.16", "ghes-3.17", "ghes-3.18", "ghes-3.19"]);
export const catalogEntry = z.strictObject({ event: z.string(), summary: z.string(), documentationUrl: z.string(), supportedWebhookTypes: z.array(z.string()), customActions: z.boolean(),
  actions: z.array(z.strictObject({ action: z.string().nullable(), description: z.string(), schemaRef: z.string() })), cloudOnly: z.boolean() });
export const hook = z.strictObject({ id: z.number().int().positive(), active: z.boolean(), events: z.array(z.string()), url: z.string(),
  contentType: z.string().nullable(), insecureSsl: z.string().nullable(), updatedAt: z.string().nullable() });
export type Hook = z.infer<typeof hook>;
export const hookPlan = z.strictObject({ id: z.uuid(), endpointId: z.uuid(), endpointRevision: revision, action: z.enum(["create", "update"]),
  hookId: z.number().int().positive().nullable(), webhookUrl: z.string(), events: z.array(z.string()), observedRevision: z.string(), expiresAt: z.iso.datetime(),
  consequences: z.array(z.string()) });
export const remoteReceipt = z.strictObject({ requestId: z.uuid(), endpointId: z.uuid(), action: z.string(), status: z.enum(["running", "succeeded", "failed", "unknown"]),
  hookId: z.number().int().positive().nullable(), startedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable(), error: z.string().nullable() });
export type RemoteReceipt = z.infer<typeof remoteReceipt>;
export const ingressResponse = z.strictObject({ accepted: z.literal(true), duplicate: z.boolean(), sequence, deliveryId: z.string() });
export const ingressError = z.strictObject({ error: z.string() });
