import { apiCatalog } from "./actions";
import type { Catalog } from "../src/catalog";
import { cn } from "./lib/utils";

const hints: Array<[string, string]> = [
  ["readOnlyHint", "read-only"],
  ["idempotentHint", "idempotent"],
  ["destructiveHint", "destructive"],
  ["openWorldHint", "open world"],
];

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  anyOf?: Schema[];
  enum?: Array<string | number>;
  description?: string;
};

function typeOf(prop: unknown): string {
  if (!prop || typeof prop !== "object") return "any";
  const schema = prop as Schema;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map(typeOf).filter(Boolean).join(" | ");
  if (Array.isArray(schema.enum)) return schema.enum.join(" | ");
  if (schema.type === "array") return `${typeOf(schema.items)}[]`;
  if (typeof schema.type === "string") return schema.type;
  return "object";
}

type Field = { name: string; type: string; description: string; required: boolean };

function fields(schema: Schema | undefined, prefix = ""): Field[] {
  const rows: Field[] = [];
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);
  for (const [key, prop] of Object.entries(properties)) {
    const name = prefix ? `${prefix}.${key}` : key;
    rows.push({
      name,
      type: typeOf(prop),
      description: typeof prop.description === "string" ? prop.description : "",
      required: required.has(key),
    });
    if (prop.type === "array" && prop.items?.properties) rows.push(...fields(prop.items, `${name}[]`));
    else if (prop.properties) rows.push(...fields(prop, name));
  }
  return rows;
}

function FieldList({ schema }: { schema: Schema }) {
  return (
    <ul className="m-0 list-none p-0">
      {fields(schema).map((field) => (
        <li key={field.name} className="grid grid-cols-[minmax(0,1fr)] gap-0.5 border-t border-border py-2">
          <span className="font-mono text-sm">
            {field.name} {field.required ? "required" : "optional"}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {field.description ? `${field.type} — ${field.description}` : field.type}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SchemaBlock({ title, schema }: { title: string; schema: Schema }) {
  return (
    <section className="mt-3.5">
      <h5 className="mb-2 text-[13px] font-[550] text-muted-foreground">{title}</h5>
      {fields(schema).length ? <FieldList schema={schema} /> : <Quiet>{`${title} has no fields.`}</Quiet>}
    </section>
  );
}

function Quiet({ children }: { children: string }) {
  return <p className="text-muted-foreground">{children}</p>;
}

type OperationItem = Catalog["servers"][number]["operations"][number];

function Operation({ tool }: { tool: OperationItem }) {
  const labels = hints.flatMap(([key, label]) => (tool.annotations?.[key] ? [label] : []));
  return (
    <article className="mt-5 border-t border-border pt-4">
      <h4 className="text-base font-[550]">
        <span className="font-mono font-medium">{tool.name}</span>
      </h4>
      {tool.title || labels.length ? (
        <p className="mt-1 text-[13px] text-muted-foreground">{[tool.title, ...labels].filter(Boolean).join(" · ")}</p>
      ) : null}
      <p className="mt-2">{tool.description}</p>
      <SchemaBlock title="Input" schema={tool.inputSchema as Schema} />
      <SchemaBlock title="Returns" schema={tool.outputSchema as Schema} />
    </article>
  );
}

type TransportItem = Catalog["servers"][number]["transports"][number];

function Transport({ item }: { item: TransportItem }) {
  return (
    <article className="mt-5 border-t border-border pt-4">
      <h4 className="text-base font-[550]">
        <span className="font-mono font-medium">{item.type}</span>
      </h4>
      <p className="mt-2">{item.description}</p>
      <p className={cn("mt-2 text-sm", item.available ? "text-positive" : "text-warning")}>
        {item.available ? "Servable" : "Declared, not implemented"}
      </p>
      {item.endpoint ? <p className="mt-2 font-mono text-[13px] text-foreground [overflow-wrap:anywhere]">{item.endpoint}</p> : null}
    </article>
  );
}

function Server({ item }: { item: Catalog["servers"][number] }) {
  return (
    <section className="mt-9" aria-labelledby={`${item.name}-api`}>
      <h2 id={`${item.name}-api`} className="text-lg font-[550]">{item.name}</h2>
      <p className="mt-1 font-mono text-[13px] text-muted-foreground">{item.packageName}</p>
      <p className="mt-3">{item.description}</p>
      <h3 className="mt-7 text-[13px] font-[550] uppercase tracking-[0.04em] text-muted-foreground">Operations</h3>
      {item.operations?.length
        ? item.operations.map((tool) => <Operation key={tool.name} tool={tool} />)
        : <Quiet>No operations.</Quiet>}
      <h3 className="mt-7 text-[13px] font-[550] uppercase tracking-[0.04em] text-muted-foreground">Transports</h3>
      {item.transports?.length
        ? item.transports.map((itemTransport) => <Transport key={itemTransport.type} item={itemTransport} />)
        : <Quiet>No transports.</Quiet>}
    </section>
  );
}

export default async function ApiPage() {
  let catalog: Catalog | null;
  try {
    catalog = await apiCatalog();
  } catch (error) {
    console.error(error);
    catalog = null;
  }
  return (
    <div className="mx-auto w-[min(760px,100%)] px-[clamp(16px,4vw,40px)] pt-7 pb-16 text-base leading-normal max-[480px]:pt-5">
      <main aria-label="Package APIs">
        {catalog === null ? (
          <p role="status" className="mt-4 text-muted-foreground">Unavailable</p>
        ) : (
          <>
            <h1 className="text-[22px] font-[550] tracking-[-0.02em]">APIs</h1>
            <p className="mt-2 text-muted-foreground">Typed package operations and the transports configured to serve them.</p>
            {catalog.servers.length ? (
              catalog.servers.map((item) => <Server key={item.name} item={item} />)
            ) : (
              <p role="status" className="mt-4 text-muted-foreground">No package APIs</p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
