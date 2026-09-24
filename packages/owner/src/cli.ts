#!/usr/bin/env node
import { runApi, runMcp, serveApi, serveMcp } from "@agentstack/api";
import { runDocs, serveDocs } from "@agentstack/docs";
import { apiChild, authChild } from "./children.js";
import { botsChild } from "./bots.js";
import { codexChild } from "./codex.js";
import { serveInspectorCatalog } from "./inspector-catalog.js";
import { inspectorChild, inspectorPort } from "./inspector.js";
import { startOwner } from "./owner.js";
import { statusSource } from "./status.js";

const command = process.argv[2];

if (command === "api") {
  await runApi(process.argv.slice(3));
} else if (command === "docs") {
  await runDocs();
} else if (command === "mcp") {
  await runMcp();
} else if (command !== "serve") {
  console.error("usage: agentstack serve\nusage: agentstack api <package> <transport>\nusage: agentstack mcp\nusage: agentstack docs");
  process.exit(1);
}

let events: Awaited<ReturnType<typeof serveApi>>;
let port: number;
try {
  port = inspectorPort(process.env);
  events = await serveApi({ name: "owner", transport: "socket", env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let docs: Awaited<ReturnType<typeof serveDocs>> | undefined;
let mcp: Awaited<ReturnType<typeof serveMcp>> | undefined;
let catalog: Awaited<ReturnType<typeof serveInspectorCatalog>> | undefined;
try {
  docs = await serveDocs({
    env: process.env,
    port: process.env.AGENTSTACK_DOCS_PORT === undefined ? 0 : Number(process.env.AGENTSTACK_DOCS_PORT),
    basePath: "/docs",
  });
  mcp = await serveMcp({ env: process.env });
  catalog = await serveInspectorCatalog({ env: process.env, mcpPort: mcp.port });
} catch (error) {
  await Promise.allSettled([catalog?.close(), mcp?.close(), docs?.close(), events.close()]);
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
  void Promise.allSettled([owner.close(), events.close(), docs?.close(), mcp?.close(), catalog?.close()]).then((results) => {
    const failed = results.some((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status === "rejected") console.error(result.reason);
    }
    process.exit(childFailed || failed ? 1 : 0);
  });
};
owner = startOwner([apiChild(), authChild(), codexChild(), botsChild(), inspectorChild(catalog.path, port)], process.env, () => {
  statusSource.notify();
  if (!closing && owner.children().some((child) => !child.running)) {
    childFailed = true;
    console.error("a required child stopped; shutting down agentstack");
    shutdown();
  }
});
statusSource.attach(owner);

if (events.socketPath) console.error(events.socketPath);
console.error(`AgentStack reference: ${docs.url}`);
for (const [name, url] of Object.entries(mcp.urls)) console.error(`${name} MCP: ${url}`);
console.error(`AgentStack Inspector: http://127.0.0.1:${port}/`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
