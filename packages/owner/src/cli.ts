#!/usr/bin/env node
import { runApi } from "@agentstack/api";
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

const owner = startOwner([codexChild()]);
setOwnerUiSource(() => ({ pid: process.pid, children: owner.children() }));

console.error(uiPageUrl(ui.port, "owner"));
console.error(uiPageUrl(ui.port, "codex"));
console.error(uiPageUrl(ui.port, "api"));

let closing = false;
const shutdown = () => {
  if (closing) process.exit(1);
  closing = true;
  const force = setTimeout(() => process.exit(1), 3_000);
  force.unref();
  void Promise.allSettled([ui.close(), owner.close()]).then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
