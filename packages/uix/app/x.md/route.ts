import { renderCanvasMarkdown } from "@/lib/stack/markdown";
import { loadSnapshot } from "@/lib/stack/snapshot";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(renderCanvasMarkdown(await loadSnapshot()), {
    headers: { "cache-control": "no-store", "content-type": "text/markdown; charset=utf-8" },
  });
}
