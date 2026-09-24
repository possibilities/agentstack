import { serveWebSocket } from "./websocket.js";

export async function runWebSocket(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let orphaned = false;
  let disconnect: (() => void) | undefined;
  if (process.channel) {
    process.on("disconnect", () => {
      if (disconnect) disconnect();
      else orphaned = true;
    });
  }
  let served: Awaited<ReturnType<typeof serveWebSocket>>;
  try {
    served = await serveWebSocket({ env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  for (const [name, url] of Object.entries(served.urls)) console.error(`${name} WebSocket: ${url}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void served.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  disconnect = shutdown;
  if (orphaned) shutdown();
  return new Promise(() => undefined);
}
