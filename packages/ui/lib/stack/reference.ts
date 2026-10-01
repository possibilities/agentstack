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

/** Resolve illustrative identifiers only, never live Bot identity or admission results. */
export function admissionWatchReference(operation: OperationDoc, doc: PackageDoc) {
  const watch = operation.completionWatch;
  if (!watch) return null;
  const mcp = doc.transports.find((transport) => transport.type === "mcp");
  const exposure = {
    admission: mcp?.operations.includes(operation.name) ?? false,
    read: mcp?.operations.includes(watch.readOperation) ?? false,
    topic: mcp?.events.includes(watch.topic) ?? false,
  };
  const bindings = watch.readArguments ?? { [watch.idArgument]: { input: watch.idArgument } };
  const identifier = (name: string) => name === watch.idArgument ? "<replace: new UUID>" : `<replace: input ${name}>`;
  const readArguments = Object.fromEntries(Object.entries(bindings).map(([name, source]) => [name,
    "input" in source ? identifier(source.input) : `<replace: invoking ${source.invocation}>`]));
  const args = { ...(inputTemplate(operation.inputSchema) as Record<string, unknown>), [watch.idArgument]: identifier(watch.idArgument) };
  delete args.subscribe;
  const call = (name: string, arguments_: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: arguments_ } });
  return { bindings, exposure, scope: watch.scope ? `${watch.scope.prefix ?? ""}${identifier(watch.scope.input)}` : null,
    admissionExample: exposure.admission ? call(operation.name, args) : null,
    readExample: exposure.read ? call(watch.readOperation, readArguments) : null };
}

// Domain facts beyond the declaration: brain/src/admission-watches.ts, worker/src/observation.ts,
// proc/src/schema.ts and proc/api.ts. Keep these tied to the exact admission, not package-wide availability.
export const admissionWatchCaveats: Record<string, string[]> = {
  "brain.submit": ["Watched Brain admission rejects wait:true; completion covers the exact job, not transitive fanout indexing.", "Brain requestId is a correlation UUID, separate from idempotency-key and numeric job IDs."],
  "brain.sources_sync": ["Watched Brain admission rejects wait:true; one aggregate watch covers the frozen admitted Run set, not fanout indexing.", "Brain requestId is a correlation UUID, separate from idempotency-key and numeric Run/job IDs."],
  "worker.worker_start": ["Worker scope is request:<UUID>, not a Worker ID; Worker-ID progress is separate."],
  "worker.worker_send": ["Worker scope is request:<UUID>, not a Worker ID; Worker-ID progress is separate."],
  "proc.proc_run_start": ["Proc requestId is the run ID; output is read separately by cursor."],
};
