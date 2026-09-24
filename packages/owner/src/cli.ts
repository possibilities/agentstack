#!/usr/bin/env node
import { mcpPort, runApi, runMcp, runWebSocket, serveApi, serveMcp, socketCall, socketPath, websocketPort } from "@agentstack/api";
import { connect } from "node:net";
import { runDocs, serveDocs } from "@agentstack/docs";
import { apiChild, authChild, websocketChild } from "./children.js";
import { botsChild } from "./bots.js";
import { codexChild } from "./codex.js";
import { serveInspectorCatalog } from "./inspector-catalog.js";
import { inspectorChild, inspectorPort } from "./inspector.js";
import { startOwner } from "./owner.js";
import { statusSource } from "./status.js";
import { uixChild, uixPort } from "./uix.js";

const command = process.argv[2];

if (command === "api") {
  await runApi(process.argv.slice(3));
} else if (command === "docs") {
  await runDocs();
} else if (command === "mcp") {
  await runMcp();
} else if (command === "websocket") {
  await runWebSocket();
} else if (command !== "serve") {
  console.error("usage: agentstack serve\nusage: agentstack api <package> <transport>\nusage: agentstack mcp\nusage: agentstack websocket\nusage: agentstack docs");
  process.exit(1);
}

// Check owner identity and fixed listeners before creating any
// sockets or starting children. A second invocation must not partially start
// and then fail after trying to claim the first owner's ports.
const existing = await socketCall(socketPath("owner"), "tools/call", {
  name: "owner_status", arguments: {},
}, { timeoutMs: 1_000 }).catch(() => null) as { pid?: unknown; docsUrl?: unknown; uixUrl?: unknown } | null;
if (existing && typeof existing.pid === "number") {
  console.error(`AgentStack is already running (pid ${existing.pid}).${typeof existing.docsUrl === "string" ? ` Reference: ${existing.docsUrl}` : ""}${typeof existing.uixUrl === "string" ? ` UI canvas: ${existing.uixUrl}` : ""}`);
  process.exit(0);
}

const inspectorListenPort = inspectorPort(process.env);
const uixListenPort = uixPort(process.env);
for (const [transport, port, setting] of [
  ["MCP", mcpPort(process.env), "AGENTSTACK_MCP_PORT"],
  ["WebSocket", websocketPort(process.env), "AGENTSTACK_WEBSOCKET_PORT"],
  ["Inspector", inspectorListenPort, "AGENTSTACK_INSPECTOR_PORT"],
  ["UI canvas", uixListenPort, "AGENTSTACK_UIX_PORT"],
] as const) {
  if (port !== 0 && await new Promise<boolean>((resolve) => {
    const probe = connect({ host: "127.0.0.1", port });
    const finish = (listening: boolean) => { probe.destroy(); resolve(listening); };
    probe.setTimeout(1_000, () => finish(false));
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
  })) {
    console.error(`${transport} port ${port} is already in use on 127.0.0.1. An AgentStack owner may already be running; check its owner socket or choose another ${setting}.`);
    process.exit(1);
  }
}

let events: Awaited<ReturnType<typeof serveApi>>;
try {
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
  statusSource.setDocsUrl(docs.url);
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
owner = startOwner([apiChild(), authChild(), codexChild(), botsChild(), websocketChild(), inspectorChild(catalog.path, inspectorListenPort), uixChild(uixListenPort)], process.env, () => {
  statusSource.notify();
  if (!closing && owner.children().some((child) => !child.running)) {
    childFailed = true;
    console.error("a required child stopped; shutting down agentstack");
    shutdown();
  }
});
statusSource.attach(owner);
const uixUrl = `http://127.0.0.1:${uixListenPort}/`;
statusSource.setUixUrl(uixUrl);

if (events.socketPath) console.error(events.socketPath);
console.error(`AgentStack reference: ${docs.url}`);
console.error(`AgentStack UI canvas: ${uixUrl}`);
for (const [name, url] of Object.entries(mcp.urls)) console.error(`${name} MCP: ${url}`);
console.error(`AgentStack Inspector: http://127.0.0.1:${inspectorListenPort}/`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
