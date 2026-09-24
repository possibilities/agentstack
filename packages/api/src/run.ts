import { serveApi } from "./serve.js";

export async function runApi(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [name, transport] = args;
  if (args.length !== 2 || !name || !transport) {
    console.error("usage: agentstack api <package> <transport>");
    process.exit(1);
  }
  let orphaned = false;
  let disconnect: (() => void) | undefined;
  if (process.channel) {
    process.on("disconnect", () => {
      if (disconnect) disconnect();
      else orphaned = true;
    });
  }
  let served: Awaited<ReturnType<typeof serveApi>>;
  try {
    served = await serveApi({ name, transport, env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (served.socketPath) console.error(served.socketPath);

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    const force = setTimeout(() => process.exit(1), 60_000);
    force.unref();
    void served.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  disconnect = () => {
    if (closing) return;
    shutdown();
  };
  return new Promise(() => {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    if (orphaned) shutdown();
  });
}
