import { Index } from "@/components/index";
import { loadSnapshot } from "@/lib/stack/snapshot";

export const dynamic = "force-dynamic";

export default async function Page() {
  return <Index snapshot={await loadSnapshot()} />;
}
