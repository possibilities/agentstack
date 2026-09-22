#!/usr/bin/env node
import { startDaemon } from "./daemon.js";
import { stateDir } from "./paths.js";

if (process.argv[2] !== "serve") {
  console.error("usage: agentstack serve");
  process.exit(1);
}

let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
let closing = false;
const shutdown = () => {
  if (closing) process.exit(1);
  closing = true;
  const force = setTimeout(() => process.exit(1), 2000);
  force.unref();
  void daemon?.close({ halt: true }).then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const port = process.env.AGENTSTACK_PORT === undefined ? undefined : Number(process.env.AGENTSTACK_PORT);
try {
  daemon = await startDaemon(stateDir(), Number.isInteger(port) ? { port } : undefined);
  console.error(daemon.url);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
