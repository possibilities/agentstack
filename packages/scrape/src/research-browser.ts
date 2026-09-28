import { randomUUID } from "node:crypto";
import { socketCall, socketPath } from "@agentstack/api";
import { z } from "zod";
import { currentEgress, EgressRefused } from "./egress.js";

const receipt = z.strictObject({ cdpUrl: z.string().url(), enforcement: z.literal("guest-output-v1"),
  cleanup: z.strictObject({ session: z.string(), lease: z.string(), backend: z.literal("local"), browserTarget: z.string(), browserProfile: z.string() }) });
type Receipt = z.infer<typeof receipt>;
const sessions = new WeakMap<object, Promise<Receipt>>();
const call = (name: string, args: object) => socketCall(socketPath("browse", currentEgress()?.env), "tools/call", { name, arguments: args }, { timeoutMs: 100_000 });

export async function researchBrowser(scope: object): Promise<string> {
  const egress = currentEgress();
  if (!egress) throw new EgressRefused("browser_egress_unverifiable");
  egress.check();
  let pending = sessions.get(scope);
  if (!pending) {
    const session = randomUUID();
    pending = (async () => {
      try {
        const value = receipt.parse(await call("browser_research_acquire", { session, policy: egress.policy }));
        const url = new URL(value.cdpUrl);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) throw new Error("invalid research relay");
        return value;
      } catch {
        // A failed launch can leave a fenced reservation. Reconcile only its exact lease.
        try {
          const found = await call("browser_session_get", { session: `research-${session}` }) as { session: { session: string; lease: string; state: string } | null };
          if (found.session?.state === "reserved") await call("browser_session_reconcile", { session: found.session.session, lease: found.session.lease });
        } catch { /* Retained for explicit reconciliation; the guest firewall expires. */ }
        throw new EgressRefused("browser_egress_unverifiable");
      }
    })();
    sessions.set(scope, pending);
  }
  const value = await pending;
  egress.check();
  return value.cdpUrl;
}

export async function closeResearchBrowser(scope: object): Promise<void> {
  const pending = sessions.get(scope);
  if (!pending) return;
  sessions.delete(scope);
  try { const value = await pending; await call("browser_session_close", { cleanup: value.cleanup }); }
  catch { /* Guest-wide egress expiry bounds abandoned sessions; receipts remain inspectable. */ }
}
