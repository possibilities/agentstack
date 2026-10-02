import type { JsonSchema, OperationDoc, PackageDoc } from "./types";

type Read = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

export async function loadCatalog(read: Read): Promise<PackageDoc[]> {
  try {
    return validateCatalog((await read<{ packages: PackageDoc[] }>("docs_snapshot")).packages);
  } catch {
    const { packages } = await read<{ packages: { name: string }[] }>("docs_list");
    return validateCatalog(await Promise.all(packages.map(({ name }) => read<PackageDoc>("docs_get", { package: name }))));
  }
}

/** Fail the resource read before incompatible discovery metadata reaches render.
 * Missing exposure selections are not equivalent to an empty selection. */
function validateCatalog(packages: PackageDoc[]): PackageDoc[] {
  if (!Array.isArray(packages) || packages.some((doc) => !doc || !Array.isArray(doc.operations) || !Array.isArray(doc.transports)
    || doc.transports.some((transport) => !transport || !Array.isArray(transport.operations)
       || !Array.isArray(transport.events) || !Array.isArray(transport.routes)
       || transport.type === "mcp" && (!Array.isArray(transport.workerOperations)
         || transport.workerOperations.some(name => typeof name !== "string" || !transport.operations.includes(name))
         || !Array.isArray(transport.workerEvents)
         || transport.workerEvents.some(name => typeof name !== "string" || !transport.events.includes(name)
           || !doc.operations.some(operation => operation.eventSource?.name === name && transport.operations.includes(operation.name))))))) {
    throw new Error("Incompatible API catalog: transport operation, Worker, event and route selections are required. Restart matching package and UI versions.");
  }
  return packages;
}

export type Field = {
  name: string;
  type: string;
  description: string | null;
  required: boolean;
  children: Field[];
};

export function typeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return "unknown";
  if (schema.enum) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (schema.anyOf) return schema.anyOf.map(typeLabel).join(" | ");
  if (Array.isArray(schema.oneOf)) return (schema.oneOf as JsonSchema[]).map(typeLabel).join(" | ");
  if (Array.isArray(schema.allOf)) return (schema.allOf as JsonSchema[]).map(typeLabel).join(" & ");
  if (typeof schema.$ref === "string") return schema.$ref;
  if (schema.type === "array") return `${typeLabel(schema.items)}[]`;
  if (Array.isArray(schema.type)) return schema.type.join(" | ");
  return schema.type ?? "unknown";
}

function describe(schema: JsonSchema): string | null {
  return schema.description ?? schema.anyOf?.find((option) => option.description)?.description ?? null;
}

function objectOf(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (!schema) return undefined;
  if (schema.properties) return schema;
  if (schema.type === "array") return objectOf(schema.items);
  return schema.anyOf?.map(objectOf).find(Boolean);
}

export function fieldsOf(schema: JsonSchema | undefined): Field[] {
  const object = objectOf(schema);
  if (!object?.properties) return [];
  const required = new Set(object.required ?? []);
  return Object.entries(object.properties).map(([name, property]) => ({
    name,
    type: typeLabel(property),
    description: describe(property),
    required: required.has(name),
    children: fieldsOf(property),
  }));
}

export function findOperation(catalog: PackageDoc[] | null, pkg: string, name: string): OperationDoc | undefined {
  return catalog?.find((doc) => doc.name === pkg)?.operations.find((operation) => operation.name === name);
}

/** Field descriptions for the records returned by a list operation, keyed by field name. */
export function recordFields(catalog: PackageDoc[] | null, pkg: string, list: string): Map<string, Field> {
  const [collection] = fieldsOf(findOperation(catalog, pkg, list)?.outputSchema);
  const fields = collection?.children.length ? collection.children : fieldsOf(findOperation(catalog, pkg, list)?.outputSchema);
  return new Map(fields.map((field) => [field.name, field]));
}

/** Operations in a package that act on one record, identified by an `id` input. */
export function recordOperations(catalog: PackageDoc[] | null, pkg: string): OperationDoc[] {
  return catalog?.find((doc) => doc.name === pkg)?.operations.filter((operation) => operation.inputSchema.properties?.id) ?? [];
}

const annotationLabels: Record<string, string> = {
  readOnlyHint: "Read only",
  destructiveHint: "Destructive",
  idempotentHint: "Idempotent",
  openWorldHint: "Open world",
};

export function annotationBadges(operation: OperationDoc): { key: string; label: string }[] {
  return Object.entries(operation.annotations)
    .filter(([key, value]) => value === true && annotationLabels[key])
    .map(([key]) => ({ key, label: annotationLabels[key] }));
}

export function operationTitle(operation: OperationDoc): string {
  return operation.title ?? (typeof operation.annotations.title === "string" ? operation.annotations.title : operation.name);
}

/** Owner capability is independent of read-only hints, service health and caller authority. */
export function standaloneCapability(operation: OperationDoc, doc: PackageDoc): "standalone" | "service" | "unknown" | null {
  if (!doc.transports.some((transport) => transport.type === "mcp" && transport.operations.includes(operation.name))) return null;
  return typeof operation.standalone === "boolean" ? operation.standalone ? "standalone" : "service" : "unknown";
}
