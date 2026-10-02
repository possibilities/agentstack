import type { ClientInput, ClientOutput, ClientOperation } from "@stack/client/contract";

export type BrowserClientOperation = Exclude<ClientOperation, "client_ui_connect">;
export class ClientCallError extends Error {
  constructor(readonly code: string, readonly uncertain: boolean) {
    super(code === "client_session_required" ? "Client session expired. Run stack-ui to reconnect."
      : code === "revision_conflict" ? "Configuration revision conflict. Your draft is retained; inspect the current configuration before saving again."
      : code === "trusted_release_required" ? "No trusted release configured for this Client."
      : code === "trusted_release_changed" ? "The trusted release changed. This saved request cannot install a different release."
      : "Client host unavailable. The last observation is retained.");
  }
}
/** No tokens, roots, socket paths or destination overrides are accepted here.
 * Both schemas are enforced at the authenticated server boundary. Keep the
 * runtime schema dependency (including its eval probe) out of this nonce-only
 * browser surface; TypeScript keeps the caller input/output contract here. */
export async function clientCall<K extends BrowserClientOperation>(operation: K, input: ClientInput<K>, signal?: AbortSignal): Promise<ClientOutput<K>> {
  let response: Response;
  try { response = await fetch("/api/client/rpc", { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) }); }
  catch { throw new ClientCallError("client_transport_unknown", true); }
  if (!response.ok) {
    const failure = await response.json().catch(() => ({})) as { error?: string; uncertain?: boolean };
    throw new ClientCallError(failure.error ?? "client_call_failed", failure.uncertain ?? response.status >= 500);
  }
  try {
    const value = await response.json() as { output: unknown };
    return value.output as ClientOutput<K>;
  } catch { throw new ClientCallError("client_result_unknown", true); }
}
