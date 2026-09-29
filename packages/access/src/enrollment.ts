import { AccessError } from "./store.js";
import { encodeQr, originSchema, type Invitation, type EnrollmentReceipt } from "./enrollment-protocol.js";
import { renderQr } from "./qr.js";

/** Operator configuration is the only source of the advertised destination.
 * Never derive it from a caller's Host/Origin or a scanned request. */
export function enrollmentOrigin(env: NodeJS.ProcessEnv) {
  let origin = env.STACK_ACCESS_ORIGIN;
  if (!origin && env.STACK_ACCESS_UI_ORIGIN) {
    const url = new URL(env.STACK_ACCESS_UI_ORIGIN);
    url.port = env.STACK_ACCESS_PORT ?? "8943";
    origin = url.origin;
  }
  if (!env.STACK_ACCESS_HOST || !origin || !originSchema.safeParse(origin).success) throw new AccessError("enrollment_origin_not_configured", 503);
  if (Number(new URL(origin).port || 443) !== Number(env.STACK_ACCESS_PORT ?? 8943)) throw new AccessError("enrollment_origin_port_mismatch", 503);
  return origin;
}
export function invitationResponse(invitation: Invitation, now = Date.now()) {
  return { invitation, qr: renderQr(encodeQr(invitation), now) };
}
export function enrollmentResponse(receipt: EnrollmentReceipt, now = Date.now()) {
  return { receipt, qr: renderQr(encodeQr(receipt), now) };
}
