import type { ClientInput, ClientOutput } from "@stack/client/contract";
import { clientCall } from "./channel";

export type RemoteOperation = "client_pair_begin" | "client_enrollment_begin" | "client_connection_open";
export type RemoteRequest = { [K in RemoteOperation]: { version: 1; operation: K; destination: string; input: ClientInput<K> } }[RemoteOperation];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefix = (scope: string) => `stack.client.${scope}.remote.v1.`;
const keyFor = (scope: string, record: RemoteRequest) => `${prefix(scope)}${encodeURIComponent(record.destination)}.${record.operation}.${record.input.requestId}`;

export function remoteDestination(record: Pick<RemoteRequest, "operation" | "input">): string {
  if (record.operation === "client_pair_begin") {
    const input = record.input as ClientInput<"client_pair_begin">;
    return `${input.connection.serverId}@${input.connection.deviceOrigin}`;
  }
  if (record.operation === "client_enrollment_begin") return `offline:${record.input.requestId}`;
  throw new Error("An Open requires its observed destination identity.");
}

function parse(text: string): RemoteRequest {
  const record = JSON.parse(text) as RemoteRequest;
  if (!record || record.version !== 1 || Object.keys(record).sort().join() !== "destination,input,operation,version"
    || typeof record.destination !== "string" || !record.destination || !uuid.test(record.input?.requestId)) throw new Error();
  if (record.operation === "client_connection_open") {
    if (Object.keys(record.input).sort().join() !== "id,requestId" || !uuid.test(record.input.id)) throw new Error();
  } else if (record.operation === "client_pair_begin" || record.operation === "client_enrollment_begin") {
    if (Object.keys(record.input).sort().join() !== (record.operation === "client_pair_begin" ? "connection,label,requestId,scopes" : "label,requestId,scopes")
      || typeof record.input.label !== "string" || !record.input.label.trim() || record.input.label.length > 80
      || !Array.isArray(record.input.scopes) || !record.input.scopes.includes("ui:view")
      || record.input.scopes.some(scope => !["ui:view", "ui:control", "content:read"].includes(scope))
      || new Set(record.input.scopes).size !== record.input.scopes.length || record.destination !== remoteDestination(record)) throw new Error();
  } else throw new Error();
  return record;
}

/** Exact, secret-free input journals. Host-owned secrets and one-use URLs never
 * enter browser storage. Every dispatch (including a retry) verifies storage. */
export function retainRemoteRequest(scope: string, record: RemoteRequest) {
  const text = JSON.stringify(record);
  parse(text);
  const key = keyFor(scope, record), previous = localStorage.getItem(key);
  if (previous !== null && previous !== text) throw new Error("Saved input changed. Nothing was dispatched.");
  localStorage.setItem(key, text);
  if (localStorage.getItem(key) !== text) throw new Error("Could not persist the exact input. Nothing was dispatched.");
}

export function readRemoteRequest(scope: string, operation: RemoteOperation, requestId: string): RemoteRequest | null {
  let result: RemoteRequest | null = null;
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index)!;
    if (!key.startsWith(prefix(scope)) || !key.endsWith(`.${operation}.${requestId}`)) continue;
    const record = parse(localStorage.getItem(key)!);
    if (key !== keyFor(scope, record) || record.operation !== operation || record.input.requestId !== requestId || result) throw new Error();
    result = record;
  }
  return result;
}

export function clearRemoteRequest(scope: string, record: RemoteRequest) {
  const key = keyFor(scope, record), saved = localStorage.getItem(key);
  if (saved !== null && saved !== JSON.stringify(record)) throw new Error();
  localStorage.removeItem(key);
  if (localStorage.getItem(key) !== null) throw new Error();
}

export async function dispatchRemote<K extends RemoteOperation>(scope: string, record: Extract<RemoteRequest, { operation: K }>): Promise<ClientOutput<K>> {
  try { retainRemoteRequest(scope, record); }
  catch { throw new Error("Recovery storage is unavailable or changed. Nothing was dispatched. Preserve the saved input; storage must work before retrying."); }
  return clientCall(record.operation, record.input as ClientInput<K>);
}

export const connectionDestination = (connection: { serverId: string; deviceOrigin: string }) => `${connection.serverId}@${connection.deviceOrigin}`;
