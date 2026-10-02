import { headers } from "next/headers";
import { clientInputs } from "@stack/client/contract";
import { ManualConnection } from "@/components/client/manual-connection";
import { runtime, requireClientSession } from "@/lib/client/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stack · Connect manually" };
export default async function ManualPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  if (runtime.mode !== "client") return <main className="p-8"><h1>Remote setup requires the independent Client UI</h1><p>Launch stack-ui on this machine. This platform page never reads a Client host.</p><a href="/client">Client launch instructions</a></main>;
  requireClientSession(await headers());
  const { intent } = await searchParams;
  const parsed = clientInputs.client_pair_redeem.safeParse({ id: intent });
  return <ManualConnection scope={runtime.cookieName} intent={parsed.success ? parsed.data.id : null} />;
}
