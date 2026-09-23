import { apiCatalog } from "./actions";
import type { Catalog } from "../src/catalog";
import "./style.css";

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
    <ul className="fields">
      {fields(schema).map((field) => (
        <li key={field.name}>
          <span className="field-name">
            {field.name} {field.required ? "required" : "optional"}
          </span>
          <span className="field-type">
            {field.description ? `${field.type} — ${field.description}` : field.type}
          </span>
        </li>
      ))}
    </ul>
  );
}

function SchemaBlock({ title, schema }: { title: string; schema: Schema }) {
  return (
    <section className="schema">
      <h5>{title}</h5>
      {fields(schema).length ? <FieldList schema={schema} /> : <Quiet>{`${title} has no fields.`}</Quiet>}
    </section>
  );
}

function Quiet({ children }: { children: string }) {
  return <p className="quiet">{children}</p>;
}

type OperationItem = Catalog["servers"][number]["operations"][number];

function Operation({ tool }: { tool: OperationItem }) {
  const labels = hints.flatMap(([key, label]) => (tool.annotations?.[key] ? [label] : []));
  return (
    <article className="operation">
      <h4>
        <span>{tool.name}</span>
      </h4>
      {tool.title || labels.length ? (
        <p className="hint">{[tool.title, ...labels].filter(Boolean).join(" · ")}</p>
      ) : null}
      <p>{tool.description}</p>
      <SchemaBlock title="Input" schema={tool.inputSchema as Schema} />
      <SchemaBlock title="Returns" schema={tool.outputSchema as Schema} />
    </article>
  );
}

type TransportItem = Catalog["servers"][number]["transports"][number];

function Transport({ item }: { item: TransportItem }) {
  return (
    <article className="transport">
      <h4>
        <span>{item.type}</span>
      </h4>
      <p>{item.description}</p>
      <p className={item.available ? "status status-ready" : "status status-later"}>
        {item.available ? "Servable" : "Declared, not implemented"}
      </p>
      {item.endpoint ? <p className="endpoint">{item.endpoint}</p> : null}
    </article>
  );
}

function Server({ item }: { item: Catalog["servers"][number] }) {
  return (
    <section className="server" aria-labelledby={`${item.name}-api`}>
      <h2 id={`${item.name}-api`}>{item.name}</h2>
      <p className="package-name">{item.packageName}</p>
      <p>{item.description}</p>
      <h3>Operations</h3>
      {item.operations?.length
        ? item.operations.map((tool) => <Operation key={tool.name} tool={tool} />)
        : <Quiet>No operations.</Quiet>}
      <h3>Transports</h3>
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
    <div className="app-shell">
      <main aria-label="Package APIs">
        {catalog === null ? (
          <p role="status">Unavailable</p>
        ) : (
          <>
            <h1>APIs</h1>
            <p className="lede">Typed package operations and the transports configured to serve them.</p>
            {catalog.servers.length ? (
              catalog.servers.map((item) => <Server key={item.name} item={item} />)
            ) : (
              <p role="status">No package APIs</p>
            )}
          </>
        )}
      </main>
    </div>
  );
}
