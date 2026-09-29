import { z } from "zod";
import { clientKinds, scopes } from "./policy.js";

export const enrollmentLifetime = 600_000;
export const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const scopeSelection = z.array(z.enum(scopes)).min(1).max(scopes.length)
  .refine(values => new Set(values).size === values.length, "Duplicate scopes");
export const originSchema = z.string().max(300).refine(value => {
  try {
    const url = new URL(value), host = url.hostname.toLowerCase();
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && host !== "localhost" && !host.endsWith(".localhost") && !host.startsWith("127.")
      && !["0.0.0.0", "[::]", "[::1]"].includes(host);
  } catch { return false; }
}, "Use an exact non-loopback HTTPS origin");
const base = { v: z.literal(1), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
export const enrollmentRequestSchema = z.strictObject({ ...base, type: z.literal("request"), id: z.uuid(),
  kind: z.enum(clientKinds), label: z.string().trim().min(1).max(80), scopes: scopeSelection, commitment: digest, publicKey: secretSchema });
export const invitationSchema = z.strictObject({ ...base, type: z.literal("invite"), id: z.uuid(),
  serverId: z.uuid(), origin: originSchema, secret: secretSchema, kind: z.enum(clientKinds), scopes: scopeSelection });
export const enrollmentReceiptSchema = z.strictObject({ ...base, type: z.literal("receipt"), id: z.uuid(),
  serverId: z.uuid(), origin: originSchema, requestId: z.uuid(), requestHash: digest, scopes: scopeSelection });
export const qrPayloadSchema = z.discriminatedUnion("type", [enrollmentRequestSchema, invitationSchema, enrollmentReceiptSchema]);
export type EnrollmentRequest = z.infer<typeof enrollmentRequestSchema>;
export type Invitation = z.infer<typeof invitationSchema>;
export type EnrollmentReceipt = z.infer<typeof enrollmentReceiptSchema>;
export type QrPayload = z.infer<typeof qrPayloadSchema>;
export const qrTextSchema = z.string().min(1).max(2048);

/** Canonical, bounded, versioned data. A scanner must parse this, never navigate it. */
export function encodeQr(payload: QrPayload): string {
  const value = qrPayloadSchema.parse(payload);
  value.scopes = [...value.scopes].sort();
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const encoded = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return qrTextSchema.parse(`stack-access://v1/${value.type}#${encoded}`);
}

export function decodeQr(text: string, now = Date.now()): QrPayload {
  qrTextSchema.parse(text);
  const match = /^stack-access:\/\/v1\/(request|invite|receipt)#([A-Za-z0-9_-]+)$/.exec(text);
  if (!match) throw new Error("invalid_enrollment_qr");
  let value: QrPayload;
  try {
    const bytes = Uint8Array.from(atob(match[2]!.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    value = qrPayloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch { throw new Error("invalid_enrollment_qr"); }
  if (value.type !== match[1] || encodeQr(value) !== text) throw new Error("noncanonical_enrollment_qr");
  if (value.expiresAt <= now || value.expiresAt > now + enrollmentLifetime) throw new Error("enrollment_expired_or_clock_skew");
  return value;
}

export const inviteCreateInput = z.strictObject({ requestId: z.uuid(), secret: secretSchema,
  kind: z.enum(clientKinds), scopes: scopeSelection, expiresAt: base.expiresAt });
export const approvalInput = z.strictObject({ request: qrTextSchema, scopes: scopeSelection });
export const claimInput = z.strictObject({ inviteId: z.uuid(), secret: secretSchema, request: qrTextSchema });
export const enrollmentRedeemInput = z.strictObject({ id: z.uuid(), redemptionSecret: secretSchema, requestHash: digest,
  signature: z.string().regex(/^[A-Za-z0-9_-]{85}[AQgw]$/) });
export const qrRenderSchema = z.object({ text: qrTextSchema, size: z.number().int(), rows: z.array(z.string()), quietZone: z.literal(4) });
export const enrollmentResponseSchema = z.object({ receipt: enrollmentReceiptSchema, qr: qrRenderSchema });
export const invitationResponseSchema = z.object({ invitation: invitationSchema, qr: qrRenderSchema });
export const previewSchema = z.object({ request: enrollmentRequestSchema, requestHash: digest, allowedScopes: z.array(z.enum(scopes)) });
export const enrollmentCredentialSchema = z.strictObject({ clientId: z.uuid(), credentialId: z.uuid(), refreshToken: secretSchema,
  expiresAt: base.expiresAt, serverId: z.uuid() });

/** Domain-separated Ed25519 proof. Binding origin prevents a hostile return
 * receipt from harvesting a signature usable against the legitimate server. */
export function redemptionMessage(receipt: Pick<EnrollmentReceipt, "origin" | "serverId" | "id" | "requestHash">, commitment: string) {
  return new TextEncoder().encode(["stack-access-enrollment-redeem-v1", receipt.origin, receipt.serverId, receipt.id, receipt.requestHash, commitment].join("\n"));
}
