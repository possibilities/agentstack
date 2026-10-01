/** Client-only primitives. The host owns persistence, confirmation and serialization. */
import { z } from "zod";
import { connectionSchema, uiHandoffSchema, type ConnectionDescriptor } from "./connection-schema.js";
import { enrollmentCredentialSchema, originSchema, secretSchema, scopeSelection } from "./enrollment-protocol.js";
import { responseJson } from "./client-http.js";

export { connectionSchema, uiHandoffSchema, type ConnectionDescriptor } from "./connection-schema.js";
const options = { redirect: "error", cache: "no-store", credentials: "omit" } as const;
const pairingSchema = z.object({ id: z.uuid(), code: z.string().regex(/^[A-F0-9]{16}$/), expiresAt: z.number().int(), serverId: z.uuid() });
const refreshSchema = z.strictObject({ accessToken: secretSchema, refreshToken: secretSchema,
  audience: z.enum(["brain", "content", "access", "ui"]), expiresAt: z.number().int(), credentialId: z.uuid(), serverId: z.uuid() });
export type ManualPairingIntent = { requestId: string; label: string; kind: "desktop" | "browser";
  scopes: z.infer<typeof scopeSelection>; redemptionSecret: string };

export function createManualPairingIntent(label: string, scopes: ManualPairingIntent["scopes"], kind: ManualPairingIntent["kind"] = "desktop"): ManualPairingIntent {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { requestId: crypto.randomUUID(), label: z.string().trim().min(1).max(80).parse(label), kind,
    scopes: scopeSelection.parse(scopes), redemptionSecret: btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") };
}
async function request(origin: string, path: string, send: typeof fetch, data?: unknown, headers?: Record<string, string>) {
  originSchema.parse(origin);
  const response = await send(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(15_000),
    ...(data === undefined ? {} : { method: "POST", body: JSON.stringify(data) }),
    headers: { ...(data === undefined ? {} : { "content-type": "application/json" }), ...headers } });
  const body = await responseJson(response);
  if (!response.ok || !body.ok) throw new Error(body.error?.code ?? "access_request_failed");
  return body.data;
}
/** Inspect without credentials; caller must confirm the result before retaining it. */
export async function inspectConnection(origin: string, send: typeof fetch = fetch): Promise<ConnectionDescriptor> {
  const descriptor = connectionSchema.parse(await request(origin, "/v1/access/connection", send));
  if (descriptor.deviceOrigin !== origin) throw new Error("server_destination_mismatch");
  return descriptor;
}
async function pinned(connection: ConnectionDescriptor, send: typeof fetch) {
  connectionSchema.parse(connection);
  const observed = await inspectConnection(connection.deviceOrigin, send);
  // A changed advertised UI must be explicitly reviewed, not silently navigated.
  if (JSON.stringify(observed) !== JSON.stringify(connection)) throw new Error("server_connection_changed");
}
export async function requestManualPairing(connection: ConnectionDescriptor, intent: ManualPairingIntent, send: typeof fetch = fetch) {
  await pinned(connection, send);
  secretSchema.parse(intent.redemptionSecret); scopeSelection.parse(intent.scopes);
  const result = pairingSchema.parse(await request(connection.deviceOrigin, "/v1/access/pair", send, intent));
  if (result.serverId !== connection.serverId) throw new Error("server_identity_mismatch");
  return result;
}
export async function redeemManualPairing(connection: ConnectionDescriptor, id: string, intent: ManualPairingIntent, send: typeof fetch = fetch) {
  await pinned(connection, send);
  const result = enrollmentCredentialSchema.parse(await request(connection.deviceOrigin, "/v1/access/redeem", send,
    { id: z.uuid().parse(id), redemptionSecret: secretSchema.parse(intent.redemptionSecret) }, { "x-stack-server-id": connection.serverId }));
  if (result.serverId !== connection.serverId) throw new Error("server_identity_mismatch");
  return result;
}
export async function refreshConnection(connection: ConnectionDescriptor, input: { refreshToken: string; requestId: string; audience: "brain" | "content" | "access" | "ui" }, send: typeof fetch = fetch) {
  await pinned(connection, send);
  secretSchema.parse(input.refreshToken); z.uuid().parse(input.requestId);
  const result = refreshSchema.parse(await request(connection.deviceOrigin, "/v1/access/refresh", send, input,
    { "x-stack-server-id": connection.serverId }));
  if (result.serverId !== connection.serverId || result.audience !== input.audience) throw new Error("server_identity_mismatch");
  return result;
}
/** Persist the request UUID first. The resulting one-use URL is sensitive navigation authority. */
export async function openRemoteUi(connection: ConnectionDescriptor, accessToken: string, requestId: string, send: typeof fetch = fetch) {
  await pinned(connection, send);
  const result = uiHandoffSchema.parse(await request(connection.deviceOrigin, "/v1/access/ui-handoff", send,
    { requestId: z.uuid().parse(requestId) }, { "x-stack-server-id": connection.serverId, authorization: `Bearer ${secretSchema.parse(accessToken)}` }));
  const url = new URL(result.url);
  if (result.serverId !== connection.serverId || url.origin !== connection.uiOrigin || url.pathname !== "/connect/device"
    || url.search || !secretSchema.safeParse(url.hash.slice(1)).success) throw new Error("ui_destination_mismatch");
  return result;
}
