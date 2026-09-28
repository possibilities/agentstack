import { AsyncLocalStorage } from "node:async_hooks";
import { isIP } from "node:net";
import { z } from "zod";

// Numeric endpoints deliberately avoid giving a hostname a durable DNS wildcard.
export const privateDestination = z.strictObject({
  address: z.string().max(64).refine((value) => isIP(value) !== 0 && !value.includes("%"), "must be an IP address without a zone ID")
    .overwrite((value) => isIP(value) === 6 ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value),
  port: z.number().int().min(1).max(65535),
});
export const egressPolicy = z.strictObject({ privateDestinations: z.array(privateDestination).max(32) });
export type EgressPolicy = z.infer<typeof egressPolicy>;
export const publicEgress: EgressPolicy = { privateDestinations: [] };
export class EgressRefused extends Error {
  constructor(readonly code: "egress_grant_revoked" | "egress_policy_changed" | "browser_egress_unverifiable") { super(code); }
}
type Context = { policy: EgressPolicy; check: () => void; signal: AbortSignal; env: NodeJS.ProcessEnv };
const context = new AsyncLocalStorage<Context>();
export const currentEgress = () => context.getStore();

/** Internal engine capability, never accepted from a share or extraction input. */
export async function withEgressPolicy<T>(policy: EgressPolicy, check: () => void, fn: () => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const controller = new AbortController();
  const captured = egressPolicy.parse(policy);
  const verify = () => { controller.signal.throwIfAborted(); check(); };
  verify();
  const timer = setInterval(() => { try { verify(); } catch (error) { controller.abort(error); } }, 250);
  timer.unref();
  try {
    return await context.run({ policy: captured, check: verify, signal: controller.signal, env }, async () => {
      let result: T;
      try { result = await fn(); } catch (error) { verify(); throw error; }
      verify();
      return result;
    });
  } finally { clearInterval(timer); }
}

export function privateEndpointAllowed(policy: EgressPolicy, address: string, port: number): boolean {
  const normalized = privateDestination.parse({ address, port });
  return policy.privateDestinations.some((entry) => entry.address === normalized.address && entry.port === port);
}
