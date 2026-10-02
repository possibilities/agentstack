import { clientInputs } from "@stack/client/contract";
import { SocketCallError } from "@stack/api";
import { callClient, isClientRpcOperation, readClientJson } from "@/lib/client/rpc";
import { requireClientSession, ClientSessionError, clientSecurityHeaders } from "@/lib/client/session";

export const dynamic = "force-dynamic";
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: clientSecurityHeaders });
export async function POST(request: Request) {
  let session: ReturnType<typeof requireClientSession>;
  try { session = requireClientSession(request.headers, request.method); }
  catch (error) { return json({ error: "client_session_required" }, error instanceof ClientSessionError ? error.status : 401); }
  let operation: unknown, input: unknown;
  try {
    if (new URL(request.url).search) return json({ error: "query_refused" }, 400);
    const raw = await readClientJson(request);
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).sort().join(",") !== "input,operation") return json({ error: "invalid_request" }, 400);
    ({ operation, input } = raw as { operation: unknown; input: unknown });
    if (!isClientRpcOperation(operation)) return json({ error: "operation_refused" }, 403);
    input = clientInputs[operation].parse(input);
  } catch { return json({ error: "invalid_input" }, 400); }
  // Recheck after body admission and again before returning the result.
  try {
    session!.revalidate();
    const output = await callClient(operation, input as never, request.signal);
    session!.revalidate();
    return json({ output });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const definite = ["trusted_release_required", "trusted_release_changed", "revision_conflict", "job_not_found", "request_conflict"];
    // These bounded owner codes carry no URL, credential or arbitrary remote
    // text. A known reason does NOT imply that preceding host writes had no effect.
    const remote = ["unauthorized", "approval_pending", "pairing_denied", "pairing_expired_or_invalid", "connection_host_refused", "server_destination_mismatch", "server_connection_changed",
      "server_identity_mismatch", "ui_destination_mismatch", "credential_revoked", "credential_expired", "insufficient_scope", "grant_changed",
      "refresh_reused_repair_required", "refresh_superseded", "refresh_recovery_required", "ui_handoff_expired", "ui_not_configured",
      "enrollment_expired_or_clock_skew", "enrollment_authority_changed", "enrollment_invalid", "enrollment_receipt_mismatch"];
    const code = [...definite, ...remote].includes(message) ? message : "client_call_failed";
    const definiteRefusal = definite.includes(message);
    return json({ error: code, uncertain: !definiteRefusal && !(error instanceof SocketCallError && !error.dispatched) }, 502);
  }
}
