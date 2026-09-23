const hints = [
  ["readOnlyHint", "read-only"],
  ["idempotentHint", "idempotent"],
  ["destructiveHint", "destructive"],
  ["openWorldHint", "open world"],
];

function typeOf(prop) {
  if (!prop || typeof prop !== "object") return "any";
  if (Array.isArray(prop.anyOf)) return prop.anyOf.map(typeOf).filter(Boolean).join(" | ");
  if (Array.isArray(prop.enum)) return prop.enum.join(" | ");
  if (prop.type === "array") return `${typeOf(prop.items)}[]`;
  if (typeof prop.type === "string") return prop.type;
  return "object";
}

function fields(schema, prefix = "") {
  const rows = [];
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

function fieldList(schema) {
  const list = document.createElement("ul");
  list.className = "fields";
  for (const field of fields(schema)) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.className = "field-name";
    name.textContent = field.required ? `${field.name} required` : `${field.name} optional`;
    const meta = document.createElement("span");
    meta.className = "field-type";
    meta.textContent = field.description ? `${field.type} — ${field.description}` : field.type;
    item.append(name, meta);
    list.append(item);
  }
  return list;
}

function schemaBlock(title, schema) {
  const block = document.createElement("section");
  block.className = "schema";
  const heading = document.createElement("h5");
  heading.textContent = title;
  block.append(heading);
  const rows = fields(schema);
  block.append(rows.length ? fieldList(schema) : empty(`${title} has no fields.`));
  return block;
}

function operation(tool) {
  const section = document.createElement("article");
  section.className = "operation";
  const heading = document.createElement("h4");
  const name = document.createElement("span");
  name.textContent = tool.name;
  heading.append(name);
  section.append(heading);
  const labels = hints.flatMap(([key, label]) => (tool.annotations?.[key] ? [label] : []));
  if (tool.title || labels.length) {
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = [tool.title, ...labels].filter(Boolean).join(" · ");
    section.append(hint);
  }
  const description = document.createElement("p");
  description.textContent = tool.description;
  section.append(description, schemaBlock("Input", tool.inputSchema), schemaBlock("Returns", tool.outputSchema));
  return section;
}

function transport(item) {
  const section = document.createElement("article");
  section.className = "transport";
  const heading = document.createElement("h4");
  const name = document.createElement("span");
  name.textContent = item.type;
  heading.append(name);
  const description = document.createElement("p");
  description.textContent = item.description;
  const status = document.createElement("p");
  status.className = item.available ? "status status-ready" : "status status-later";
  status.textContent = item.available ? "Servable" : "Declared, not implemented";
  section.append(heading, description, status);
  if (item.endpoint) {
    const endpoint = document.createElement("p");
    endpoint.className = "endpoint";
    endpoint.textContent = item.endpoint;
    section.append(endpoint);
  }
  return section;
}

function server(item) {
  const section = document.createElement("section");
  section.className = "server";
  const heading = document.createElement("h2");
  heading.id = `${item.name}-api`;
  heading.textContent = item.name;
  section.setAttribute("aria-labelledby", heading.id);
  const packageName = document.createElement("p");
  packageName.className = "package-name";
  packageName.textContent = item.packageName;
  const description = document.createElement("p");
  description.textContent = item.description;
  const operations = document.createElement("h3");
  operations.textContent = "Operations";
  const transports = document.createElement("h3");
  transports.textContent = "Transports";
  section.append(heading, packageName, description, operations);
  for (const tool of item.operations ?? []) section.append(operation(tool));
  if (!(item.operations ?? []).length) section.append(empty("No operations."));
  section.append(transports);
  for (const itemTransport of item.transports ?? []) section.append(transport(itemTransport));
  if (!(item.transports ?? []).length) section.append(empty("No transports."));
  return section;
}

function empty(text) {
  const node = document.createElement("p");
  node.className = "quiet";
  node.textContent = text;
  return node;
}

function status(text) {
  const node = document.createElement("p");
  node.role = "status";
  node.textContent = text;
  return node;
}

async function paint() {
  const main = document.querySelector("main");
  try {
    const response = await fetch("data", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    const intro = document.createElement("p");
    intro.className = "lede";
    intro.textContent = "Typed package operations and the transports configured to serve them.";
    const heading = document.createElement("h1");
    heading.textContent = "APIs";
    const servers = data.servers ?? [];
    main.replaceChildren(heading, intro, ...(servers.length ? servers.map(server) : [status("No package APIs")]));
  } catch {
    main.replaceChildren(status("Unavailable"));
  }
}

paint();
