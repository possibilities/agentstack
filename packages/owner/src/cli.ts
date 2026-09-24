#!/usr/bin/env node
import { mcpPort, runApi, runMcp, serveApi, socketCall, socketPath } from "@agentstack/api";
import { connect } from "node:net";
import { runDocs, serveDocs } from "@agentstack/docs";
import { apiChild, authChild, mcpChild } from "./children.js";
import { botsChild } from "./bots.js";
import { codexChild } from "./codex.js";
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

// Check both owner identity and the fixed MCP listener before creating any
// sockets or starting children. A second invocation must not partially start
// and then fail after trying to claim the first owner's ports.
const existing = await socketCall(socketPath("owner"), "tools/call", {
  name: "owner_status", arguments: {},
}, { timeoutMs: 1_000 }).catch(() => null) as { pid?: unknown; docsUrl?: unknown } | null;
if (existing && typeof existing.pid === "number") {
  console.error(`AgentStack is already running (pid ${existing.pid}).${typeof existing.docsUrl === "string" ? ` Reference: ${existing.docsUrl}` : ""}`);
  process.exit(0);
}

const port = mcpPort(process.env);
if (port !== 0 && await new Promise<boolean>((resolve) => {
  const probe = connect({ host: "127.0.0.1", port });
  const finish = (listening: boolean) => { probe.destroy(); resolve(listening); };
  probe.setTimeout(1_000, () => finish(false));
  probe.once("connect", () => finish(true));
  probe.once("error", () => finish(false));
})) {
  console.error(`MCP port ${port} is already in use on 127.0.0.1. An AgentStack owner may already be running; check its owner socket or choose another AGENTSTACK_MCP_PORT.`);
  process.exit(1);
}

let events: Awaited<ReturnType<typeof serveApi>>;
try {
  events = await serveApi({ name: "owner", transport: "socket", env: process.env });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let docs: Awaited<ReturnType<typeof serveDocs>>;
try {
  docs = await serveDocs({
    env: process.env,
    port: process.env.AGENTSTACK_DOCS_PORT === undefined ? 0 : Number(process.env.AGENTSTACK_DOCS_PORT),
    basePath: "/docs",
  });
  statusSource.setDocsUrl(docs.url);
} catch (error) {
  await events.close();
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
  void Promise.allSettled([owner.close(), events.close(), docs.close()]).then((results) => {
    const failed = results.some((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status === "rejected") console.error(result.reason);
    }
    process.exit(childFailed || failed ? 1 : 0);
  });
};
owner = startOwner([apiChild(), authChild(), codexChild(), botsChild(), mcpChild()], process.env, () => {
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

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
