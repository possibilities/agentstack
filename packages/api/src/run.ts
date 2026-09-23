import { serveApi } from "./serve.js";

export async function runApi(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [name, transport] = args;
  if (args.length !== 2 || !name || !transport) {
    console.error("usage: agentstack api <package> <transport>");
    process.exit(1);
  }
  let served: Awaited<ReturnType<typeof serveApi>>;
  try {
    served = await serveApi({ name, transport, env });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  if (served.socketPath) console.error(served.socketPath);
  if (served.websocketUrl) console.error(served.websocketUrl);

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    const force = setTimeout(() => process.exit(1), 12_000);
    force.unref();
    void served.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  return new Promise(() => {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });
}
