#!/usr/bin/env node
import { runApi, serveApi } from "@agentstack/api";
import { botsChild } from "./bots.js";
import { codexChild } from "./codex.js";
import { startOwner } from "./owner.js";
import { setOwnerUiSource } from "./ui-source.js";
import { startUiServer, uiListenPort, uiPageUrl } from "./ui.js";

const command = process.argv[2];

if (command === "api") {
  await runApi(process.argv.slice(3));
} else if (command !== "serve") {
  console.error("usage: agentstack serve\nusage: agentstack api <package> <transport>");
  process.exit(1);
}

let port: number;
try {
  port = uiListenPort();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

// Start Next before children: the dev server exits the process itself when it
// cannot start (for example when its lockfile is held), so nothing can be
// spawned yet at that point.
let ui: Awaited<ReturnType<typeof startUiServer>>;
try {
  ui = await startUiServer(port);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const env = { ...process.env, AGENTSTACK_UI_ORIGIN: `http://127.0.0.1:${ui.port}` };

let events: Awaited<ReturnType<typeof serveApi>>;
try {
  events = await serveApi({ name: "owner", transport: "websocket", env });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await ui.close().catch((closeError) => console.error(closeError));
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
  void Promise.allSettled([ui.close(), owner.close(), events.close()]).then((results) => {
    const failed = results.some((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status === "rejected") console.error(result.reason);
    }
    process.exit(childFailed || failed ? 1 : 0);
  });
};
owner = startOwner([codexChild(), botsChild()], env, () => {
  events.publish?.("pids_changed");
  if (!closing && owner.children().some((child) => !child.running)) {
    childFailed = true;
    console.error("a required child stopped; shutting down agentstack");
    shutdown();
  }
});
setOwnerUiSource(() => ({ pid: process.pid, children: owner.children(), websocketUrl: events.websocketUrl }));

console.error(uiPageUrl(ui.port, "owner", ui.token));
console.error(uiPageUrl(ui.port, "codex", ui.token));
console.error(uiPageUrl(ui.port, "bots", ui.token));
console.error(uiPageUrl(ui.port, "api", ui.token));

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
