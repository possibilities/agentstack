import { headers } from "next/headers";
import { LocalPlatform } from "@/components/client/local-platform";
import { runtime, requireClientSession } from "@/lib/client/session";

export const dynamic = "force-dynamic";
export const metadata = { title: "Stack · Run locally" };
export default async function LocalPlatformPage() {
  if (runtime.mode !== "client") return <main className="mx-auto flex max-w-xl flex-col gap-4 p-8">
    <h1 className="text-2xl font-semibold">Local platform controls require the independent Client UI</h1>
    <p>Launch <code>stack-ui</code> on this machine. This platform page never reads a Client host.</p><a href="/client" className="underline">Client launch instructions</a>
  </main>;
  requireClientSession(await headers());
  return <LocalPlatform release={runtime.release} scope={runtime.cookieName} />;
}
