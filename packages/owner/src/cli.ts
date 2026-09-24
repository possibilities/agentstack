#!/usr/bin/env node
import { runApi, serveApi } from "@agentstack/api";
import { apiChild, authChild } from "./children.js";
import { botsChild } from "./bots.js";
import { codexChild } from "./codex.js";
import { startOwner } from "./owner.js";
import { statusSource } from "./status.js";

const command = process.argv[2];

if (command === "api") {
  await runApi(process.argv.slice(3));
} else if (command !== "serve") {
  console.error("usage: agentstack serve\nusage: agentstack api <package> <transport>");
  process.exit(1);
}

let events: Awaited<ReturnType<typeof serveApi>>;
try {
  events = await serveApi({ name: "owner", transport: "socket", env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let owner: ReturnType<typeof startOwner>;
let closing = false;
let childFailed = false;
const shutdown = () => {
  if (closing) process.exit(1);
  closing = true;
  const force = setTimeout(() => process.exit(1), 16_000);
  force.unref();
  void Promise.allSettled([owner.close(), events.close()]).then((results) => {
    const failed = results.some((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status === "rejected") console.error(result.reason);
    }
    process.exit(childFailed || failed ? 1 : 0);
  });
};
owner = startOwner([apiChild(), authChild(), codexChild(), botsChild()], process.env, () => {
  statusSource.notify();
  if (!closing && owner.children().some((child) => !child.running)) {
    childFailed = true;
    console.error("a required child stopped; shutting down agentstack");
    shutdown();
  }
});
statusSource.attach(owner);

if (events.socketPath) console.error(events.socketPath);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
