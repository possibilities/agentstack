import { createHash } from "node:crypto";
import { knownEvent } from "./catalog.js";
import type { Delivery } from "./schema.js";

export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = 1000) => typeof value === "string" ? value.slice(0, max) : null;
const number = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
export type DeliveryHeaders = { event: string; deliveryId: string; contentType: Delivery["contentType"]; hookId: string | null; targetType: string | null; targetId: string | null };
export function summarize(endpointId: string, headers: DeliveryHeaders, raw: Buffer, payload: Record<string, unknown>): Omit<Delivery, "sequence"> {
  // Every top-level object with an identity is discoverable, not just CI/PR special cases.
  const entities = Object.entries(payload).flatMap(([kind, value]) => {
    const entity = object(value);
    const id = number(entity.id) ?? text(entity.id) ?? text(entity.node_id);
    if (id === null && number(entity.number) === null && !text(entity.html_url)) return [];
    return [{ kind: kind.slice(0, 128), id, number: number(entity.number), title: text(entity.title ?? entity.name ?? entity.login, 500),
      url: text(entity.html_url, 2000), state: text(entity.state ?? entity.status, 128), conclusion: text(entity.conclusion, 128) }];
  }).slice(0, 32);
  const repository = object(payload.repository), organization = object(payload.organization), enterprise = object(payload.enterprise);
  const run = object(payload.workflow_run), check = object(payload.check_suite), request = object(payload.pull_request);
  return { endpointId, ...headers, receivedAt: new Date().toISOString(), action: text(payload.action, 128),
    repository: text(repository.full_name, 201), repositoryId: number(repository.id), organization: text(organization.login, 100), enterprise: text(enterprise.slug, 100),
    sender: text(object(payload.sender).login, 100), installationId: number(object(payload.installation).id), ref: text(payload.ref ?? run.head_branch, 1000),
    sha: text(payload.after ?? payload.sha ?? run.head_sha ?? check.head_sha ?? object(request.head).sha, 128), entities,
    payloadBytes: raw.length, payloadSha256: createHash("sha256").update(raw).digest("hex"), payloadClearedAt: null, knownEvent: knownEvent(headers.event) };
}
