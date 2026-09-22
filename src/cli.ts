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
  if (closing) return;
  closing = true;
  void daemon?.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  daemon = await startDaemon(stateDir());
  console.error(daemon.url);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
