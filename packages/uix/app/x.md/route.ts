export const dynamic = "force-dynamic";

export async function GET() {
  return new Response("# AgentStack UI canvas\n\nBlank experiment canvas; no content is served here.\n", {
    headers: { "cache-control": "no-store", "content-type": "text/markdown; charset=utf-8" },
  });
}
