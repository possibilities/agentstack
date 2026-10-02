import type { ClientInput, ClientOutput, ClientOperation } from "@stack/client/contract";

export type BrowserClientOperation = Exclude<ClientOperation, "client_ui_connect">;
/** No tokens, roots, socket paths or destination overrides are accepted here.
 * Both schemas are enforced at the authenticated server boundary. Keep the
 * runtime schema dependency (including its eval probe) out of this nonce-only
 * browser surface; TypeScript keeps the caller input/output contract here. */
export async function clientCall<K extends BrowserClientOperation>(operation: K, input: ClientInput<K>, signal?: AbortSignal): Promise<ClientOutput<K>> {
  const response = await fetch("/api/client/rpc", { method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, input }) });
  if (!response.ok) throw new Error(response.status === 401 ? "Client session expired. Run stack-ui to reconnect." : "Client host unavailable. The last observation is retained.");
  const value = await response.json() as { output: unknown };
  return value.output as ClientOutput<K>;
}
