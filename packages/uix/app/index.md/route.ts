import { renderIndexMarkdown } from "@/lib/markdown";
import { loadIndex } from "@/lib/status";

export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(renderIndexMarkdown(await loadIndex()), {
    headers: { "cache-control": "no-store", "content-type": "text/markdown; charset=utf-8" },
  });
}
