import { join } from "node:path";
import { socketSubscribe, type SocketSubscription } from "@stack/api";
import { runtime, requireClientSession, ClientSessionError, clientSecurityHeaders } from "@/lib/client/session";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  let session: ReturnType<typeof requireClientSession>;
  try { session = requireClientSession(request.headers, "GET"); }
  catch (error) { return new Response(null, { status: error instanceof ClientSessionError ? error.status : 401, headers: clientSecurityHeaders }); }
  if (new URL(request.url).search) return new Response(null, { status: 400, headers: clientSecurityHeaders });
  let subscription: SocketSubscription | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let finish = () => {};
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      finish = () => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        request.signal.removeEventListener("abort", finish);
        void subscription?.close();
        controller.close();
      };
      const send = (event: string) => {
        if (closed) return;
        try {
          session!.revalidate();
          if ((controller.desiredSize ?? 0) <= 0) { finish(); return; }
          controller.enqueue(encoder.encode(`event: ${event}\ndata: {}\n\n`));
        } catch {
          controller.enqueue(encoder.encode("event: session_expired\ndata: {}\n\n"));
          finish();
        }
      };
      request.signal.addEventListener("abort", finish, { once: true });
      try {
        // Readiness is emitted ONLY after the private subscription acknowledges.
        // The browser snapshots on ready, so no subscribe/snapshot race exists.
        subscription = await socketSubscribe(join(runtime.root!, "client.sock"), ["client_changed"], () => send("client_changed"), { signal: request.signal });
        if (closed || request.signal.aborted) { await subscription.close(); finish(); return; }
        send("ready");
        if (closed) return;
        let ticks = 0;
        interval = setInterval(() => {
          try {
            session!.revalidate();
            if (++ticks % 60 === 0 && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch { send("session_expired"); }
        }, 250);
        void subscription.closed.then(() => { if (!closed) send("unavailable"); finish(); });
      } catch { if (!closed) send("unavailable"); finish(); }
    },
    cancel() { finish(); },
  });
  return new Response(stream, { headers: { ...clientSecurityHeaders, "content-type": "text/event-stream", "x-accel-buffering": "no" } });
}
