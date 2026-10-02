import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { clientInputs } from "@stack/client/contract";
import { ConnectionDetail } from "@/components/client/connection-detail";
import { runtime, requireClientSession } from "@/lib/client/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stack · Saved connection" };
export default async function ConnectionPage({ params }: { params: Promise<{ id: string }> }) {
  if (runtime.mode !== "client") return <main className="p-8"><h1>Connections require the independent Client UI</h1><p>Launch stack-ui on this machine. This platform page never reads a Client host.</p><a href="/client">Client launch instructions</a></main>;
  requireClientSession(await headers());
  const parsed = clientInputs.client_pair_redeem.safeParse(await params);
  if (!parsed.success) notFound();
  return <ConnectionDetail scope={runtime.cookieName} id={parsed.data.id} />;
}
