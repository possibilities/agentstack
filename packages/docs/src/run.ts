import { serveDocs } from "./server.js";

export async function runDocs(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const requestedPort = env.AGENTSTACK_DOCS_PORT;
  const port = requestedPort === undefined ? 0 : Number(requestedPort);
  const server = await serveDocs({ env, port });
  console.error(`AgentStack reference: ${server.url}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void server.close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  return new Promise(() => undefined);
}
