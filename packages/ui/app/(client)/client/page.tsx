import { headers } from "next/headers";
import { ConnectionsHome } from "@/components/client/connections-home";
import { runtime, requireClientSession } from "@/lib/client/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stack · Connections" };
export default async function ClientPage() {
  if (runtime.mode !== "client") return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <h1 className="text-2xl font-semibold">Stack Client UI runs independently</h1>
    <p>This is the platform-served Canvas. To manage connections without a running platform, launch the separately built Client UI with <code>stack-ui</code> on this machine.</p>
    <p className="text-muted-foreground">This foundation is not a published npm package. It does not install or connect to a Client host from this page.</p>
    <a href="/" className="underline">Return to HUD</a>
  </main>;
  requireClientSession(await headers());
  return <ConnectionsHome />;
}
