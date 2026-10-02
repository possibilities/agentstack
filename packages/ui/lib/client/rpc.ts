import "server-only";
import { socketCall, SocketCallError } from "@stack/api";
import { join } from "node:path";
import { clientInputs, clientOutputs, type ClientInput, type ClientOutput, type ClientOperation } from "@stack/client/contract";
import { runtime } from "./session";

// Explicit HTTP exposure, never a socket method/package supplied by a caller.
// Bootstrap minting is private to the parent, even for an authenticated viewer.
export const clientRpcOperations = [
  "client_snapshot", "client_connection_list", "client_prerequisites", "client_job_get", "client_qr_render",
  "client_install_plan", "client_install", "client_platform_start", "client_platform_stop", "client_login_set",
  "client_platform_configure", "client_local_open", "client_tailnet_peers", "client_connection_inspect",
  "client_pair_begin", "client_pair_redeem", "client_enrollment_begin", "client_enrollment_accept",
  "client_enrollment_redeem", "client_connection_open", "client_connection_forget", "client_intent_forget",
] as const satisfies readonly ClientOperation[];
export type ClientRpcOperation = typeof clientRpcOperations[number];
export function isClientRpcOperation(name: unknown): name is ClientRpcOperation {
  return typeof name === "string" && (clientRpcOperations as readonly string[]).includes(name);
}

export async function callClient<K extends ClientRpcOperation>(name: K, raw: ClientInput<K>, signal?: AbortSignal): Promise<ClientOutput<K>> {
  if (runtime.mode !== "client") throw new Error("client_mode_required");
  const input = clientInputs[name].parse(raw);
  const value = await socketCall(join(runtime.root!, "client.sock"), "tools/call", { name, arguments: input }, { signal, timeoutMs: 30_000 });
  // Output failure is an uncertain result AFTER dispatch, not permission to retry.
  try { return clientOutputs[name].parse(value) as ClientOutput<K>; }
  catch { throw new SocketCallError("client_output_invalid", true); }
}

export async function readClientJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type") !== "application/json") throw new Error("json_required");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > 65_536) { await reader.cancel(); throw new Error("payload_too_large"); }
    chunks.push(next.value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
