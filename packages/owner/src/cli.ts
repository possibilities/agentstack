#!/usr/bin/env node
import { codexChild } from "./codex.js";
import { startOwner } from "./owner.js";

if (process.argv[2] !== "serve") {
  console.error("usage: agentstack serve");
  process.exit(1);
}

const owner = startOwner([codexChild()]);
let closing = false;
const shutdown = () => {
  if (closing) process.exit(1);
  closing = true;
  const force = setTimeout(() => process.exit(1), 3_000);
  force.unref();
  void owner.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
