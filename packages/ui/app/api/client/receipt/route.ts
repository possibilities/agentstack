import { decodeQr, qrTextSchema } from "@stack/access/enrollment-protocol";
import { enrollmentRequestHash } from "@stack/access/enrollment-client";
import { readClientJson } from "@/lib/client/rpc";
import { requireClientSession, ClientSessionError, clientSecurityHeaders } from "@/lib/client/session";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: clientSecurityHeaders });

/** Read-only local decoding. No host mutation or destination/network request.
 * Keep the protocol's runtime schema out of the nonce-only browser bundle. */
export async function POST(request: Request) {
  let session: ReturnType<typeof requireClientSession>;
  try { session = requireClientSession(request.headers, request.method); }
  catch (error) { return json({ error: "client_session_required" }, error instanceof ClientSessionError ? error.status : 401); }
  try {
    if (new URL(request.url).search) return json({ error: "invalid_receipt" }, 400);
    const raw = await readClientJson(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join() !== "receipt,request") return json({ error: "invalid_receipt" }, 400);
    const values = raw as { receipt: unknown; request: unknown };
    const text = { receipt: qrTextSchema.parse(values.receipt), request: qrTextSchema.parse(values.request) };
    const saved = decodeQr(text.request), receipt = decodeQr(text.receipt);
    if (saved.type !== "request" || saved.kind !== "desktop" || receipt.type !== "receipt" || receipt.requestId !== saved.id
      || receipt.requestHash !== await enrollmentRequestHash(text.request) || receipt.expiresAt > saved.expiresAt
      || !receipt.scopes.includes("ui:view") || receipt.scopes.some(scope => !saved.scopes.includes(scope)
        || !["ui:view", "ui:control", "content:read"].includes(scope))) return json({ error: "enrollment_receipt_mismatch" }, 400);
    session!.revalidate();
    return json({ receipt });
  } catch (error) {
    return json({ error: error instanceof Error && error.message === "enrollment_expired_or_clock_skew" ? error.message : "invalid_receipt" }, 400);
  }
}
