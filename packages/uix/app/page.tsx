import type { Metadata } from "next";
import { Index } from "@/components/index";
import { loadSnapshot } from "@/lib/stack/snapshot";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  alternates: { types: { "text/markdown": "/index.md" } },
};

export default async function Page() {
  return <Index snapshot={await loadSnapshot()} />;
}
