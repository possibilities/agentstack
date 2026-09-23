import { z } from "zod";

export function publishedJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  expandTypeArrays(json);
  return json;
}

function expandTypeArrays(schema: unknown): void {
  if (Array.isArray(schema)) {
    for (const item of schema) expandTypeArrays(item);
    return;
  }
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.type) && record.type.every((item) => typeof item === "string")) {
    const types = record.type;
    delete record.type;
    record.anyOf = types.map((type) => ({ type }));
  }
  for (const value of Object.values(record)) expandTypeArrays(value);
}
