/** Portable Web Crypto client primitives. Persist intent before each network call.
 * No server socket, Node runtime, ambient credentials, storage or camera access. */
import { decodeQr, encodeQr, enrollmentLifetime, enrollmentRequestSchema, secretSchema, originSchema, previewSchema, enrollmentCredentialSchema, redemptionMessage,
  type EnrollmentRequest, type EnrollmentReceipt } from "./enrollment-protocol.js";
export { decodeQr, encodeQr } from "./enrollment-protocol.js";
import { responseJson } from "./client-http.js";

export type EnrollmentIntent = { request: EnrollmentRequest; redemptionSecret: string; privateKey: string };
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unbase64url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
const hash = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
  byte => byte.toString(16).padStart(2, "0")).join("");
/** Full request fingerprint, computed offline for display/comparison on the target. */
export async function enrollmentRequestHash(text: string, now = Date.now()) {
  if (decodeQr(text, now).type !== "request") throw new Error("invalid_enrollment_request");
  return hash(text);
}
export async function createEnrollmentIntent(input: Pick<EnrollmentRequest, "kind" | "label" | "scopes">, now = Date.now()): Promise<EnrollmentIntent> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const redemptionSecret = base64url(bytes);
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]) as CryptoKeyPair;
  const privateKey = base64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  return { redemptionSecret, privateKey, request: enrollmentRequestSchema.parse({ ...input, v: 1, type: "request", id: crypto.randomUUID(),
    expiresAt: now + enrollmentLifetime, commitment: await hash(redemptionSecret), publicKey }) };
}
export async function acceptEnrollmentReceipt(intent: EnrollmentIntent, text: string, now = Date.now()): Promise<EnrollmentReceipt> {
  const request = decodeQr(encodeQr(intent.request), now);
  secretSchema.parse(intent.redemptionSecret);
  if (request.type !== "request" || await hash(intent.redemptionSecret) !== request.commitment) throw new Error("invalid_enrollment_intent");
  const receipt = decodeQr(text, now);
  if (receipt.type !== "receipt" || receipt.requestId !== request.id || receipt.requestHash !== await enrollmentRequestHash(encodeQr(request), now)
    || receipt.expiresAt > request.expiresAt || receipt.scopes.some(scope => !request.scopes.includes(scope))) throw new Error("enrollment_receipt_mismatch");
  return receipt;
}

async function identity(origin: string, serverId: string, send: typeof fetch) {
  const response = await send(`${origin}/v1/access/identity`, { redirect: "error", cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(15_000) });
  const body = await responseJson(response, "enrollment");
  if (!response.ok || !body.ok || body.data?.serverId !== serverId) throw new Error("server_identity_mismatch");
}
async function post(origin: string, serverId: string, path: string, data: unknown, send: typeof fetch, accessToken?: string) {
  originSchema.parse(origin);
  await identity(origin, serverId, send);
  const response = await send(`${origin}${path}`, { method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
    signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/json", "x-stack-server-id": serverId,
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(data) });
  const body = await responseJson(response, "enrollment");
  if (!response.ok || !body.ok) throw new Error(body.error?.code ?? "enrollment_failed");
  return body.data;
}
/** The user must explicitly trust the scanned invitation's origin before this call. */
export async function claimInvitation(intent: EnrollmentIntent, invitationText: string, send: typeof fetch = fetch) {
  const request = decodeQr(encodeQr(intent.request));
  secretSchema.parse(intent.redemptionSecret);
  const invite = decodeQr(invitationText);
  if (request.type !== "request" || invite.type !== "invite" || invite.kind !== request.kind || request.scopes.some(scope => !invite.scopes.includes(scope)))
    throw new Error("invitation_mismatch");
  if (await hash(intent.redemptionSecret) !== intent.request.commitment) throw new Error("invalid_enrollment_intent");
  const data = await post(invite.origin, invite.serverId, "/v1/access/enrollment/claim",
    { inviteId: invite.id, secret: invite.secret, request: encodeQr(request) }, send);
  const receipt = await acceptEnrollmentReceipt(intent, data.qr.text);
  if (receipt.origin !== invite.origin || receipt.serverId !== invite.serverId) throw new Error("server_identity_mismatch");
  return receipt;
}
/** Import the receipt through the trusted phone return channel (QR or paste),
 * confirm its destination, and persist it before redemption. Exact retries recover. */
export async function redeemEnrollment(intent: EnrollmentIntent, receiptText: string, send: typeof fetch = fetch) {
  const receipt = await acceptEnrollmentReceipt(intent, receiptText);
  const signature = await signEnrollmentRedemption(intent, receipt);
  const data = enrollmentCredentialSchema.parse(await post(receipt.origin, receipt.serverId, "/v1/access/enrollment/redeem",
    { id: receipt.id, requestHash: receipt.requestHash, redemptionSecret: intent.redemptionSecret, signature }, send));
  if (data.serverId !== receipt.serverId) throw new Error("server_identity_mismatch");
  return data;
}

/** Portable proof for clients implementing their own durable HTTP transport. */
export async function signEnrollmentRedemption(intent: EnrollmentIntent, receipt: EnrollmentReceipt) {
  await acceptEnrollmentReceipt(intent, encodeQr(receipt));
  if (!/^[A-Za-z0-9_-]{64}$/.test(intent.privateKey)) throw new Error("invalid_enrollment_key");
  const key = await crypto.subtle.importKey("pkcs8", unbase64url(intent.privateKey), "Ed25519", false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, redemptionMessage(receipt, intent.request.commitment)));
  const publicKey = await crypto.subtle.importKey("raw", unbase64url(intent.request.publicKey), "Ed25519", false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", publicKey, signature, redemptionMessage(receipt, intent.request.commitment))) throw new Error("invalid_enrollment_key");
  return base64url(signature);
}

export type EnrollmentSponsor = { origin: string; serverId: string; accessToken: string };
/** Uses only the phone's already-pinned destination, never any address from a scan. */
export async function inspectEnrollmentRequest(sponsor: EnrollmentSponsor, requestText: string, send: typeof fetch = fetch) {
  if (decodeQr(requestText).type !== "request") throw new Error("invalid_enrollment_request");
  secretSchema.parse(sponsor.accessToken);
  const preview = previewSchema.parse(await post(sponsor.origin, sponsor.serverId, "/v1/access/enrollment/inspect",
    { request: requestText }, send, sponsor.accessToken));
  if (preview.requestHash !== await hash(requestText) || encodeQr(preview.request) !== requestText) throw new Error("enrollment_preview_mismatch");
  return preview;
}
/** Call only after the human has reviewed the request and chosen permissions. */
export async function approveEnrollmentRequest(sponsor: EnrollmentSponsor, requestText: string, scopes: EnrollmentRequest["scopes"], send: typeof fetch = fetch) {
  const request = decodeQr(requestText);
  if (request.type !== "request" || !scopes.length || scopes.some(scope => scope === "access:enroll" || !request.scopes.includes(scope))) throw new Error("delegation_scope_refused");
  secretSchema.parse(sponsor.accessToken);
  const data = await post(sponsor.origin, sponsor.serverId, "/v1/access/enrollment/approve", { request: requestText, scopes }, send, sponsor.accessToken);
  const receipt = decodeQr(data.qr.text);
  if (receipt.type !== "receipt" || receipt.requestHash !== await hash(requestText) || receipt.requestId !== request.id
    || receipt.origin !== sponsor.origin || receipt.serverId !== sponsor.serverId || receipt.expiresAt > request.expiresAt
    || JSON.stringify([...receipt.scopes].sort()) !== JSON.stringify([...scopes].sort())) throw new Error("enrollment_receipt_mismatch");
  return receipt;
}
export async function cancelEnrollment(sponsor: EnrollmentSponsor, id: string, send: typeof fetch = fetch) {
  secretSchema.parse(sponsor.accessToken);
  return post(sponsor.origin, sponsor.serverId, "/v1/access/enrollment/cancel", { id }, send, sponsor.accessToken);
}
