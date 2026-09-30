import { typeLabel } from "./catalog";
import type { JsonSchema, OperationDoc, PackageDoc, TransportDoc } from "./types";

/** Templates are deliberately not advertised as valid input: every placeholder must be replaced. */
export function inputTemplate(schema: JsonSchema): unknown {
  if (schema.properties) return Object.fromEntries((schema.required ?? []).map((name) => [name, inputTemplate(schema.properties![name] ?? {})]));
  return `<replace: ${typeLabel(schema)}>`;
}

export function requestExample(operation: OperationDoc, transport: TransportDoc, pkg: string): string | null {
  if (!transport.supported || !["socket", "websocket", "mcp"].includes(transport.type) || !transport.operations.includes(operation.name)) return null;
  const request = { ...(transport.type === "mcp" ? { jsonrpc: "2.0" } : {}), id: 1, method: "tools/call", params: { ...(transport.type === "websocket" ? { package: pkg } : {}), name: operation.name, arguments: inputTemplate(operation.inputSchema) } };
  return JSON.stringify(request, null, 2);
}

export function subscriptionExample(doc: PackageDoc, transport: TransportDoc): string | null {
  if (!transport.supported || !transport.subscriptions || !["socket", "websocket"].includes(transport.type) || !transport.events.length) return null;
  return JSON.stringify({ id: 2, method: "events/subscribe", params: { ...(transport.type === "websocket" ? { package: doc.name, subscription: "<replace: subscription id>" } : {}), topics: transport.events, ...(doc.eventScope ? { scope: "<replace: subscription scope>" } : {}) } }, null, 2);
}

export function transportInstructions(type: string): string {
  if (type === "socket") return "Send compact JSON followed by a newline on this package's Unix socket. Keep the connection open for subscriptions.";
  if (type === "websocket") return "Send JSON as a text frame on the shared WebSocket connection. Address each Package API with params.package; use distinct subscription IDs for independent event watches.";
  if (type === "mcp") return "Use an initialized MCP client and call this tool. Internal Stack launches use stdio; external consumers use HTTP. This JSON-RPC body is illustrative; the client manages transport and initialization.";
  return "Consult this transport's description for its request format.";
}
