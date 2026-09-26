#!/usr/bin/env node
import { mcpPort, runApi, runMcp, runWebSocket, serveApi, serveMcp, socketCall, socketPath, websocketPort } from "@agentstack/api";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { runDocs, serveDocs } from "@agentstack/docs";
import { apiChild, authChild, brainChild, inferChild, rolesChild, usageChild, workersChild, wikiChild, websocketChild } from "./children.js";
import { botsChild } from "./bots.js";
import { createMcpEventSubscriptions } from "./mcp-delivery.js";
import { serveInspectorCatalog } from "./inspector-catalog.js";
import { inspectorChild, inspectorPort } from "./inspector.js";
import { startOwner } from "./owner.js";
import { startWithOwnerSocketRecovery } from "./owner-socket.js";
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
}, { timeoutMs: 1_000 }).catch(() => null) as { pid?: unknown; docsUrl?: unknown; indexUrl?: unknown; uixUrl?: unknown } | null;
if (existing && typeof existing.pid === "number") {
  console.error(`AgentStack is already running (pid ${existing.pid}).${typeof existing.docsUrl === "string" ? ` Reference: ${existing.docsUrl}` : ""}${typeof existing.indexUrl === "string" ? ` Index: ${existing.indexUrl}` : ""}${typeof existing.uixUrl === "string" ? ` UI canvas: ${existing.uixUrl}` : ""}`);
  process.exit(0);
}

const inspectorListenPort = inspectorPort(process.env);
const uixListenPort = uixPort(process.env);
const wikiPort = Number(process.env.AGENTSTACK_WIKI_PORT ?? 8777);
const wikiArtifactPort = Number(process.env.AGENTSTACK_WIKI_ARTIFACT_PORT ?? 8778);
const brainSharePort = Number(process.env.AGENTSTACK_BRAIN_SHARE_PORT ?? 8877);
const brainShareHost = process.env.AGENTSTACK_BRAIN_SHARE_HOST ?? "127.0.0.1";
const docsPort = Number(process.env.AGENTSTACK_DOCS_PORT ?? 0);
for (const [name, value] of [["AGENTSTACK_WIKI_PORT", wikiPort], ["AGENTSTACK_WIKI_ARTIFACT_PORT", wikiArtifactPort], ["AGENTSTACK_BRAIN_SHARE_PORT", brainSharePort], ["AGENTSTACK_DOCS_PORT", docsPort]] as const) {
  if (!Number.isInteger(value) || value < 0 || value > 65535 || process.env[name] === "") {
    console.error(`${name} must be a port from 0 to 65535`);
    process.exit(1);
  }
}
if (!brainShareHost.trim()) {
  console.error("AGENTSTACK_BRAIN_SHARE_HOST must not be empty");
  process.exit(1);
}
let brainShareAddress: string;
try {
  ({ address: brainShareAddress } = await lookup(brainShareHost));
} catch {
  console.error(`AGENTSTACK_BRAIN_SHARE_HOST could not be resolved: ${brainShareHost}`);
  process.exit(1);
}
if (wikiPort !== 0 && wikiPort === wikiArtifactPort) {
  console.error("wiki document and artifact ports must differ");
  process.exit(1);
}
const listeners = [
  ["MCP", mcpPort(process.env), "AGENTSTACK_MCP_PORT", "127.0.0.1"],
  ["WebSocket", websocketPort(process.env), "AGENTSTACK_WEBSOCKET_PORT", "127.0.0.1"],
  ["Inspector", inspectorListenPort, "AGENTSTACK_INSPECTOR_PORT", "127.0.0.1"],
  ["UI canvas", uixListenPort, "AGENTSTACK_UIX_PORT", "127.0.0.1"],
  ["Wiki documents", wikiPort, "AGENTSTACK_WIKI_PORT", "127.0.0.1"],
  ["Wiki artifacts", wikiArtifactPort, "AGENTSTACK_WIKI_ARTIFACT_PORT", "127.0.0.1"],
  ["Docs", docsPort, "AGENTSTACK_DOCS_PORT", "127.0.0.1"],
  ["Brain share", brainSharePort, "AGENTSTACK_BRAIN_SHARE_PORT", brainShareHost],
] as const;
// Resolve the share host as net.Server.listen does so aliases and wildcard
// binds cannot conceal a collision with the owner's IPv4 loopback listeners.
const bindAddress = (host: string) => host === brainShareHost ? brainShareAddress : host;
const loopbackBinds = new Set(["127.0.0.1", "0.0.0.0", "::", "::ffff:127.0.0.1"]);
for (const [index, [, port, setting, host]] of listeners.entries()) {
  const conflict = listeners.slice(0, index).find(([, otherPort, , otherHost]) =>
    port !== 0 && port === otherPort && (bindAddress(host) === bindAddress(otherHost) || loopbackBinds.has(bindAddress(host)) && loopbackBinds.has(bindAddress(otherHost))));
  if (conflict) {
    console.error(`${setting} and ${conflict[2]} must use different ports on ${host} (both use ${port})`);
    process.exit(1);
  }
}
for (const [transport, port, setting, host] of listeners) {
  if (port !== 0 && await new Promise<boolean>((resolve) => {
    const probe = connect({ host: bindAddress(host), port });
    const finish = (listening: boolean) => { probe.destroy(); resolve(listening); };
    probe.setTimeout(1_000, () => finish(false));
    probe.once("connect", () => finish(true));
    probe.once("error", () => finish(false));
  })) {
    console.error(`${transport} port ${port} is already in use on ${host}. An AgentStack owner may already be running; check its owner socket or choose another ${setting}.`);
    process.exit(1);
  }
}

let events: Awaited<ReturnType<typeof serveApi>>;
try {
  events = await startWithOwnerSocketRecovery(socketPath("owner"), () => serveApi({ name: "owner", transport: "socket", env: process.env }));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let docs: Awaited<ReturnType<typeof serveDocs>> | undefined;
let mcp: Awaited<ReturnType<typeof serveMcp>> | undefined;
let catalog: Awaited<ReturnType<typeof serveInspectorCatalog>> | undefined;
const subscriptions = createMcpEventSubscriptions(process.env);
try {
  docs = await serveDocs({
    env: process.env,
    port: docsPort,
    basePath: "/docs",
  });
  statusSource.setDocsUrl(docs.url);
  mcp = await serveMcp({ env: process.env, subscriptions });
  statusSource.setMcpUrls(mcp.urls);
  catalog = await serveInspectorCatalog({ env: process.env, mcpPort: mcp.port });
} catch (error) {
  await Promise.allSettled([subscriptions.close(), catalog?.close(), mcp?.close(), docs?.close(), events.close()]);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let owner: ReturnType<typeof startOwner>;
let closing = false;
let childFailed = false;
const shutdown = () => {
  if (closing) process.exit(1);
  closing = true;
  const force = setTimeout(() => process.exit(1), 240_000);
  force.unref();
  void (async () => {
    // Refuse new requests first. The remaining socket Servers drain their
    // active calls while the dependencies they call are still running.
    const ingress = await Promise.allSettled([subscriptions.close(), owner.stop(["websocket", "inspector", "uix"]), events.close(), docs?.close(), mcp?.close(), catalog?.close()]);
    const children = await Promise.allSettled([owner.close()]);
    return [...ingress, ...children];
  })().then((results) => {
    const failed = results.some((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status === "rejected") console.error(result.reason);
    }
    process.exit(childFailed || failed ? 1 : 0);
  });
};
owner = startOwner([apiChild(), authChild(), rolesChild(), botsChild(mcp.port), workersChild(), usageChild(), inferChild(), wikiChild(), brainChild(), websocketChild(), inspectorChild(catalog.path, inspectorListenPort), uixChild(uixListenPort)], process.env, () => {
  statusSource.notify();
  if (!closing && owner.children().some((child) => !child.running)) {
    childFailed = true;
    console.error("a required child stopped; shutting down agentstack");
    shutdown();
  }
}, [["infer"], ["auth"], ["workers"], ["bots"], ["usage"], ["brain"], ["wiki"], ["roles"], ["api"]]);
statusSource.attach(owner);
subscriptions.resume();
const indexUrl = `http://127.0.0.1:${uixListenPort}/`;
const uixUrl = `http://127.0.0.1:${uixListenPort}/x`;
statusSource.setIndexUrl(indexUrl);
statusSource.setUixUrl(uixUrl);
statusSource.setInspectorUrl(`http://127.0.0.1:${inspectorListenPort}/`);

if (events.socketPath) console.error(events.socketPath);
console.error(`AgentStack reference: ${docs.url}`);
console.error(`AgentStack index: ${indexUrl}`);
console.error(`AgentStack UI canvas: ${uixUrl}`);
for (const [name, url] of Object.entries(mcp.urls)) console.error(`${name} MCP: ${url}`);
console.error(`AgentStack Inspector: http://127.0.0.1:${inspectorListenPort}/`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
