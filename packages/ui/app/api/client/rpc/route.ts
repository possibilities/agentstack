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
    const safe = ["trusted_release_required", "trusted_release_changed", "revision_conflict", "job_not_found", "request_conflict"];
    const code = safe.includes(message) ? message : "client_call_failed";
    const definiteRefusal = safe.includes(message);
    return json({ error: code, uncertain: !definiteRefusal && !(error instanceof SocketCallError && !error.dispatched) }, 502);
  }
}
