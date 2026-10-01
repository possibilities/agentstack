import type { Delivery, Filter } from "./schema.js";

export function payloadPointer(payload: unknown, pointer: string): unknown {
  let value = payload;
  if (!pointer) return value;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
export function matches(filter: Filter, record: Delivery, payload: unknown): boolean {
  const has = (list: readonly unknown[] | undefined, value: unknown, fold = false) => !list || list.some(item => fold && typeof item === "string" && typeof value === "string" ? item.toLowerCase() === value.toLowerCase() : item === value);
  if (!has(filter.endpointIds, record.endpointId) || !has(filter.events, record.event) || !has(filter.actions, record.action)
    || !has(filter.repositories, record.repository, true) || !has(filter.organizations, record.organization, true)
    || !has(filter.enterprises, record.enterprise, true) || !has(filter.senders, record.sender, true)
    || !has(filter.installationIds, record.installationId) || !has(filter.repositoryIds, record.repositoryId) || !has(filter.refs, record.ref)) return false;
  return (filter.predicates ?? []).every(predicate => {
    const value = payloadPointer(payload, predicate.path);
    switch (predicate.op) {
      case "exists": return (value !== undefined) === predicate.value;
      case "equals": return value === predicate.value;
      case "one_of": return predicate.values.some(item => item === value);
      case "starts_with": return typeof value === "string" && value.startsWith(predicate.value);
      case "contains": return Array.isArray(value) ? value.some(item => item === predicate.value)
        : typeof value === "string" && typeof predicate.value === "string" && value.includes(predicate.value);
    }
  });
}
