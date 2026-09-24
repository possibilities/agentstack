import type { CatalogServer } from "@agentstack/api";

const escape = (value: unknown): string => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char] ?? char);

const id = (value: string): string => value.replace(/[^a-z0-9_-]/gi, "-");

type Schema = Record<string, unknown>;

export function record(value: unknown): Schema {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Schema : {};
}

export function typeOf(schema: Schema): string {
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.anyOf)) return schema.anyOf.map((branch) => typeOf(record(branch))).join(" | ");
  if (Array.isArray(schema.oneOf)) return schema.oneOf.map((branch) => typeOf(record(branch))).join(" | ");
  if (typeof schema.$ref === "string") return schema.$ref.split("/").at(-1) ?? "reference";
  if (schema.type === "array") return `${typeOf(record(schema.items))}[]`;
  return typeof schema.type === "string" ? schema.type : "any";
}

function propertyRows(schema: Schema, depth = 0): string {
  const properties = record(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).map(([name, value]) => {
    const field = record(value);
    const description = typeof field.description === "string" ? field.description : "";
    const row = `<tr><th scope="row" class="depth-${Math.min(depth, 8)}"><code>${escape(name)}</code>${required.has(name) ? '<span class="required">required</span>' : ""}</th><td><code>${escape(typeOf(field))}</code></td><td>${escape(description)}</td></tr>`;
    const nested = field.type === "array" ? record(field.items) : field;
    return row + (depth < 8 ? propertyRows(nested, depth + 1) : "");
  }).join("");
}

function schemaPanel(label: string, schemaValue: Schema): string {
  const schema = record(schemaValue);
  const rows = propertyRows(schema);
  return `<section class="schema"><h5>${label}</h5>${rows
    ? `<div class="table-scroll"><table><thead><tr><th scope="col">Field</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<p class="empty-schema">No fields.</p>'}
    <details class="raw-schema"><summary>JSON Schema</summary><pre><code>${escape(JSON.stringify(schema, null, 2))}</code></pre></details></section>`;
}

function operation(server: CatalogServer, item: CatalogServer["operations"][number]): string {
  const anchor = `operation-${id(server.name)}-${id(item.name)}`;
  const title = item.title || item.name.replaceAll("_", " ");
  const flags = [
    item.annotations.readOnlyHint === true ? "Read only" : "",
    item.annotations.destructiveHint === true ? "Destructive" : "",
    item.annotations.idempotentHint === true ? "Idempotent" : "",
  ].filter(Boolean);
  return `<article class="operation" id="${anchor}">
    <div class="operation-heading"><div><h4>${escape(title)}</h4><code class="operation-name">${escape(item.name)}</code></div><a class="permalink" href="#${anchor}" aria-label="Link to ${escape(item.name)}">#</a></div>
    <p>${escape(item.description)}</p>${flags.length ? `<p class="flags">${flags.map(escape).join(" · ")}</p>` : ""}
    <div class="schema-grid">${schemaPanel("Input", item.inputSchema)}${schemaPanel("Output", item.outputSchema)}</div>
  </article>`;
}

function packageSection(server: CatalogServer): string {
  const anchor = `package-${id(server.name)}`;
  const topics = Object.entries(server.events);
  const transports = server.transports.map((transport) => `<div class="transport"><div><strong>${escape(transport.type)}</strong><p>${escape(transport.description)}</p></div>${transport.endpoint ? `<code>${escape(transport.endpoint)}</code>` : ""}</div>`).join("");
  const socketSubscription = server.transports.some((transport) => transport.type === "socket" && transport.subscriptions);
  const request = { id: 1, method: "events/subscribe", params: {
    topics: topics.map(([name]) => name),
    ...(server.eventScope?.required ? { scope: server.eventScope.example } : {}),
  } };
  const scope = server.eventScope ? `<p>${server.eventScope.required ? "Required" : "Optional"} <code>scope</code>: ${escape(server.eventScope.description)}</p>` : "";
  const events = topics.length ? `<section class="events" id="events-${id(server.name)}"><h3>Subscriptions</h3><p>Notices carry a topic name only; read the current state after subscribing or reconnecting.</p>${scope}<div class="event-list">${topics.map(([name, description]) => `<div class="event"><code>${escape(name)}</code><span>${escape(description)}</span></div>`).join("")}</div>${socketSubscription ? `<div class="subscription"><h4>Subscribe on the socket</h4><p>Send one JSON line to this package's socket. The acknowledgement returns the accepted topics${server.eventScope?.required ? " and scope" : ""}; subsequent notices use <code>events/changed</code>.</p><pre><code>${escape(JSON.stringify(request, null, 2))}</code></pre></div>` : ""}</section>` : "";
  return `<section class="package" id="${anchor}"><header class="package-heading"><div><p class="package-id">${escape(server.packageName)}</p><h2>${escape(server.name)}</h2><p>${escape(server.description)}</p></div><span class="package-count">${server.operations.length} operations${topics.length ? ` · ${topics.length} events` : ""}</span></header>
    <section class="transport-section"><h3>Connection</h3>${transports || '<p>No supported transport configured.</p>'}</section>
    ${events}<div class="operations-heading"><h3>Operations</h3><p>Typed inputs and outputs from the Package API.</p></div>
    ${server.operations.map((item) => operation(server, item)).join("")}</section>`;
}

export function renderDocs(servers: CatalogServer[], revision: string, basePath = ""): string {
  const operations = servers.reduce((count, server) => count + server.operations.length, 0);
  const events = servers.reduce((count, server) => count + Object.keys(server.events).length, 0);
  const navigation = servers.map((server) => `<div class="nav-group"><a class="nav-package" href="#package-${id(server.name)}">${escape(server.name)}</a><div class="nav-operations">${server.operations.map((item) => `<a href="#operation-${id(server.name)}-${id(item.name)}" data-search="${escape(`${server.name} ${item.name} ${item.title ?? ""} ${item.description}`.toLowerCase())}">${escape(item.title || item.name.replaceAll("_", " "))}</a>`).join("")}${Object.keys(server.events).length ? `<a href="#events-${id(server.name)}" data-search="${escape(`${server.name} subscriptions events`)}">Subscriptions</a>` : ""}</div></div>`).join("");
  return `<!doctype html><html lang="en" data-revision="${escape(revision)}" data-base-path="${basePath}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>Package API reference · AgentStack</title><link rel="stylesheet" href="${basePath}/site.css"><link rel="alternate" type="text/markdown" href="${basePath}/index.md"><script src="${basePath}/site.js" defer></script></head><body>
    <a class="skip" href="#main">Skip to content</a><div class="layout"><aside class="sidebar"><a class="brand" href="#main">AgentStack <span class="brand-kind">/ Reference</span></a><label class="search-label" for="search">Find an operation</label><input id="search" type="search" placeholder="Search operations" autocomplete="off"><nav aria-label="Package APIs"><a class="nav-overview" href="#main">Overview</a>${navigation}<p id="no-results" hidden>No matching operations.</p></nav><p class="sidebar-foot">Generated from <code>api.docs_list</code> and <code>api.docs_get</code>.<br><a href="${basePath}/index.md">Markdown</a></p></aside>
    <main id="main"><header class="topline"><span>Developer reference</span><span id="source-status">Live from the api socket</span></header><div class="content"><div class="opening"><div><h1>Package API reference</h1><p class="lede">The local operations and change events that make up AgentStack. Browse the current contract, including fields, types, socket paths, and MCP URLs.</p></div><div class="figures"><div><strong>${servers.length}</strong><span>Packages</span></div><div><strong>${operations}</strong><span>Operations</span></div><div><strong>${events}</strong><span>Events</span></div></div></div>
    ${servers.map(packageSection).join("")}</div><footer>AgentStack · Generated from the running discovery API</footer></main></div></body></html>`;
}

export function renderUnavailable(basePath = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><title>API reference unavailable · AgentStack</title><link rel="stylesheet" href="${basePath}/site.css"></head><body><main class="unavailable"><p>AgentStack / Reference</p><h1>Discovery API unavailable</h1><p>Check that <code>agentstack serve</code> is running and the packages are built, then reload this page.</p></main></body></html>`;
}
