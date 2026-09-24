import type { JsonSchema, OperationDoc, PackageDoc } from "./types";

type Read = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

export async function loadCatalog(read: Read): Promise<PackageDoc[]> {
  try {
    return (await read<{ packages: PackageDoc[] }>("docs_snapshot")).packages;
  } catch {
    const { packages } = await read<{ packages: { name: string }[] }>("docs_list");
    return Promise.all(packages.map(({ name }) => read<PackageDoc>("docs_get", { package: name })));
  }
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
