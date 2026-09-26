import { typeLabel } from "./catalog";
import type { JsonSchema, OperationDoc, PackageDoc, TransportDoc } from "./types";

/** Templates are deliberately not advertised as valid input: every placeholder must be replaced. */
export function inputTemplate(schema: JsonSchema): unknown {
  if (schema.properties) return Object.fromEntries((schema.required ?? []).map((name) => [name, inputTemplate(schema.properties![name] ?? {})]));
  return `<replace: ${typeLabel(schema)}>`;
}

export function requestExample(operation: OperationDoc, transport: TransportDoc): string | null {
  if (!transport.supported || !["socket", "websocket", "mcp"].includes(transport.type)) return null;
  const request = { ...(transport.type === "mcp" ? { jsonrpc: "2.0" } : {}), id: 1, method: "tools/call", params: { name: operation.name, arguments: inputTemplate(operation.inputSchema) } };
  return JSON.stringify(request, null, 2);
}

export function subscriptionExample(doc: PackageDoc, transport: TransportDoc): string | null {
  if (!transport.supported || !transport.subscriptions || !["socket", "websocket"].includes(transport.type) || !Object.keys(doc.events).length) return null;
  return JSON.stringify({ id: 2, method: "events/subscribe", params: { topics: Object.keys(doc.events), ...(doc.eventScope ? { scope: "<replace: subscription scope>" } : {}) } }, null, 2);
}

export function transportInstructions(type: string): string {
  if (type === "socket") return "Send compact JSON followed by a newline on this package's Unix socket. Keep the connection open for subscriptions.";
  if (type === "websocket") return "Send JSON as a text frame on this package's WebSocket connection.";
  if (type === "mcp") return "Use an initialized MCP client and call this tool. This JSON-RPC body is illustrative; the client manages HTTP session, initialization and headers. It is not a standalone HTTP request.";
  return "Consult this transport's description for its request format.";
}
