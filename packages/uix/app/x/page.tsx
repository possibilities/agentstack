import type { Metadata } from "next";
import { Workbench } from "@/components/canvas/workbench";
import { loadSnapshot } from "@/lib/stack/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AgentStack canvas",
  alternates: { types: { "text/markdown": "/x.md" } },
};

export default async function Page() {
  return <Workbench snapshot={await loadSnapshot()} />;
}
