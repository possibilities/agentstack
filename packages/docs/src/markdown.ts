import type { CatalogServer } from "@agentstack/api";
import { record, typeOf } from "./render.js";

type Schema = Record<string, unknown>;

const text = (value: unknown): string => String(value ?? "").replace(/[\\<>[\]]/g, "\\$&");

const code = (value: unknown): string => {
  const s = String(value ?? "");
  const padded = s.startsWith("`") || s.endsWith("`") ? ` ${s} ` : s;
  for (const ticks of ["`", "``", "```"]) {
    if (!s.includes(ticks)) return `${ticks}${padded}${ticks}`;
  }
  return s;
};

function propertyLines(schema: Schema, depth = 0): string[] {
  const properties = record(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return Object.entries(properties).flatMap(([name, value]) => {
    const field = record(value);
    const description = typeof field.description === "string" ? field.description : "";
    const head = `${"  ".repeat(depth)}- ${code(name)} ${code(typeOf(field))}${required.has(name) ? " — required" : ""}${description ? `: ${text(description)}` : ""}`;
    const nested = field.type === "array" ? record(field.items) : field;
    return [head, ...(depth < 8 ? propertyLines(nested, depth + 1) : [])];
  });
}

function schemaMarkdown(label: string, schemaValue: Schema): string[] {
  const schema = record(schemaValue);
  const fields = propertyLines(schema);
  return [`**${label}**`, "", ...(fields.length ? [...fields, ""] : ["No fields.", ""]), "```json", JSON.stringify(schema, null, 2), "```", ""];
}

function operationMarkdown(item: CatalogServer["operations"][number]): string[] {
  const title = item.title || item.name.replaceAll("_", " ");
  const flags = [
    item.annotations.readOnlyHint === true ? "Read only" : "",
    item.annotations.destructiveHint === true ? "Destructive" : "",
    item.annotations.idempotentHint === true ? "Idempotent" : "",
  ].filter(Boolean);
  return [
    `#### ${text(title)} (${code(item.name)})`, "",
    text(item.description), "",
    ...(flags.length ? [`_${flags.join(" · ")}_`, ""] : []),
    ...schemaMarkdown("Input", item.inputSchema),
    ...schemaMarkdown("Output", item.outputSchema),
  ];
}

function packageMarkdown(server: CatalogServer): string[] {
  const topics = Object.entries(server.events);
  const lines = [
    `## ${server.name}`, "",
    `${code(server.packageName)} · ${server.operations.length} operations${topics.length ? ` · ${topics.length} events` : ""}`, "",
    text(server.description), "",
    "### Connection", "",
    ...(server.transports.length
      ? server.transports.map((transport) => `- **${text(transport.type)}** — ${text(transport.description)}${transport.endpoint ? ` — ${code(transport.endpoint)}` : ""}`)
      : ["No supported transport configured."]),
    "",
  ];
  if (topics.length) {
    const request = { id: 1, method: "events/subscribe", params: {
      topics: topics.map(([name]) => name),
      ...(server.eventScope?.required ? { scope: server.eventScope.example } : {}),
    } };
    lines.push(
      "### Subscriptions", "",
      "Notices carry a topic name only; read the current state after subscribing or reconnecting.", "",
      ...(server.eventScope ? [`${server.eventScope.required ? "Required" : "Optional"} ${code("scope")}: ${text(server.eventScope.description)}`, ""] : []),
      ...topics.map(([name, description]) => `- ${code(name)} — ${text(description)}`), "",
    );
    if (server.transports.some((transport) => transport.type === "socket" && transport.subscriptions)) {
      lines.push(
        "#### Subscribe on the socket", "",
        `Send one JSON line to this package's socket. The acknowledgement returns the accepted topics${server.eventScope?.required ? " and scope" : ""}; subsequent notices use ${code("events/changed")}.`, "",
        "```json", JSON.stringify(request, null, 2), "```", "",
      );
    }
  }
  lines.push("### Operations", "");
  for (const item of server.operations) lines.push(...operationMarkdown(item));
  return lines;
}

export function renderMarkdown(servers: CatalogServer[]): string {
  const operations = servers.reduce((count, server) => count + server.operations.length, 0);
  const events = servers.reduce((count, server) => count + Object.keys(server.events).length, 0);
  const lines = [
    "# Package API reference", "",
    "The local operations and change events that make up AgentStack. Browse the current contract, including fields, types, socket paths, and MCP URLs.", "",
    `${servers.length} packages · ${operations} operations · ${events} events`, "",
  ];
  for (const server of servers) lines.push(...packageMarkdown(server));
  lines.push("---", "", "AgentStack · Generated from the running discovery API", "");
  return lines.join("\n");
}

export function renderUnavailableMarkdown(): string {
  return "# Discovery API unavailable\n\nCheck that `agentstack serve` is running and the packages are built, then reload.\n";
}
