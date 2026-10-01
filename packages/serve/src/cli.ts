#!/usr/bin/env node
import { mcpPort, runApi, runMcp, runMcpStdio, runWebSocket, serveApi, serveMcp, socketCall, socketPath, websocketPort, withLocalAuth } from "@stack/api";
import { spawn } from "node:child_process";
import { contentNetworkConfig } from "@stack/content";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { fileURLToPath } from "node:url";
import { accessChild, apiChild, signalChild, authChild, brainChild, xcomChild, browseChild, contentChild, hudChild, inferChild, notifyChild, procChild, rolesChild, scrapeChild, usageChild, workerChild, websocketChild } from "./children.js";
import { botsChild } from "./bots.js";
import { createMcpEventSubscriptions } from "./mcp-delivery.js";
import { serveInspectorCatalog } from "./inspector-catalog.js";
import { inspectorChild, inspectorPort } from "./inspector.js";
import { startServer } from "./server.js";
import { startWithServerSocketRecovery } from "./server-socket.js";
import { statusSource } from "./status.js";
import { uiChild, uiPort } from "./ui.js";

export async function runServeCommand(command: string, args: string[]): Promise<void> {

if (command === "open") {
  const target = args[0] ?? "ui";
  if (!["ui", "inspector"].includes(target) || args.length > 2) throw new Error("usage: stack serve open [ui|inspector] [configured-development-origin]");
  const result = await socketCall(socketPath("serve"), "tools/call", { name: "serve_local_connect", arguments: { target, ...(args[1] ? { origin: args[1] } : {}) } }) as { url: string };
  const child = spawn(process.platform === "darwin" ? "open" : "xdg-open", [result.url], { stdio: "ignore" });
  await new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error("browser opener failed"))); });
  process.exit(0);
}
if (command === "revoke-local") {
  await socketCall(socketPath("serve"), "tools/call", { name: "serve_local_revoke", arguments: {} });
  console.error("Local sessions and operator credentials revoked. Run stack serve open to reconnect.");
  process.exit(0);
}

if (command === "api") {
  await runApi(args);
} else if (command === "mcp") {
  if (args.length === 2 && args[1] === "--stdio") return runMcpStdio(args[0]!);
  if (args.length) throw new Error("usage: stack serve mcp [<name> --stdio]");
  return runMcp();
} else if (command === "websocket") {
  await runWebSocket();
} else if (command !== "serve") {
  console.error("usage: stack serve\nusage: stack serve open [ui|inspector] [configured-development-origin]\nusage: stack serve revoke-local\nusage: stack serve api <package> <transport>\nusage: stack serve mcp [<name> --stdio]\nusage: stack serve websocket");
  process.exit(1);
}

// Check server identity and fixed listeners before creating any
// sockets or starting children. A second invocation must not partially start
// and then fail after trying to claim the first server's ports.
const existing = await socketCall(socketPath("serve"), "tools/call", {
  name: "serve_status", arguments: {},
}, { timeoutMs: 1_000 }).catch(() => null) as { pid?: unknown; indexUrl?: unknown; uiUrl?: unknown } | null;
if (existing && typeof existing.pid === "number") {
  console.error(`Stack is already running (pid ${existing.pid}).${typeof existing.indexUrl === "string" ? ` UI entry: ${existing.indexUrl}` : ""}${typeof existing.uiUrl === "string" ? ` UI canvas: ${existing.uiUrl}` : ""}`);
  process.exit(0);
}

const inspectorListenPort = inspectorPort(process.env);
const uiListenPort = uiPort(process.env);
const contentPort = Number(process.env.STACK_CONTENT_PORT ?? process.env.STACK_WIKI_PORT ?? 8777);
const contentArtifactPort = Number(process.env.STACK_CONTENT_ARTIFACT_PORT ?? process.env.STACK_WIKI_ARTIFACT_PORT ?? 8778);
const accessHost = process.env.STACK_ACCESS_HOST;
const accessPort = Number(process.env.STACK_ACCESS_PORT ?? 8943);
const accessArtifactPort = Number(process.env.STACK_ACCESS_ARTIFACT_PORT ?? 8944);
const accessUiPort = Number(process.env.STACK_ACCESS_UI_PORT ?? 8945);
if (accessHost) {
  const origin = process.env.STACK_ACCESS_UI_ORIGIN;
  let validOrigin = origin === undefined && process.env.STACK_ACCESS_UI_PORT === undefined;
  try {
    if (origin) {
      const parsed = new URL(origin);
      validOrigin = parsed.protocol === "https:" && parsed.origin === origin && Number(parsed.port || 443) === accessUiPort && !parsed.username && !parsed.password;
    }
  } catch { /* fail closed below */ }
  if (!validOrigin || !process.env.STACK_ACCESS_TLS_CERT || !process.env.STACK_ACCESS_TLS_KEY
    || ![accessPort, accessArtifactPort, ...(origin ? [accessUiPort] : [])].every(value => Number.isInteger(value) && value > 0 && value <= 65535)
    || new Set([accessPort, accessArtifactPort, ...(origin ? [accessUiPort] : [])]).size !== (origin ? 3 : 2)) {
    console.error("Access needs distinct valid ports and TLS key/cert; remote UI also needs STACK_ACCESS_UI_ORIGIN matching its port");
    process.exit(1);
  }
}
let contentHost: string;
try { contentHost = contentNetworkConfig(process.env).host; }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
const brainSharePort = Number(process.env.STACK_BRAIN_SHARE_PORT ?? 8877);
const brainShareHost = process.env.STACK_BRAIN_SHARE_HOST ?? "127.0.0.1";
for (const [name, value] of [["STACK_CONTENT_PORT", contentPort], ["STACK_CONTENT_ARTIFACT_PORT", contentArtifactPort], ["STACK_BRAIN_SHARE_PORT", brainSharePort]] as const) {
  if (!Number.isInteger(value) || value < 0 || value > 65535 || process.env[name] === "" || (name === "STACK_CONTENT_PORT" && process.env.STACK_CONTENT_PORT === undefined && process.env.STACK_WIKI_PORT === "") || (name === "STACK_CONTENT_ARTIFACT_PORT" && process.env.STACK_CONTENT_ARTIFACT_PORT === undefined && process.env.STACK_WIKI_ARTIFACT_PORT === "")) {
    console.error(`${name} must be a port from 0 to 65535`);
    process.exit(1);
  }
}
if (brainShareHost !== "127.0.0.1") {
  console.error("Brain backend must bind 127.0.0.1; configure remote clients through Access");
  process.exit(1);
}
let brainShareAddress: string;
try {
  ({ address: brainShareAddress } = await lookup(brainShareHost));
} catch {
  console.error(`STACK_BRAIN_SHARE_HOST could not be resolved: ${brainShareHost}`);
  process.exit(1);
}
if (contentPort !== 0 && contentPort === contentArtifactPort) {
  console.error("content document and artifact ports must differ");
  process.exit(1);
}
const listeners: Array<readonly [string, number, string, string]> = [
  ["MCP", mcpPort(process.env), "STACK_MCP_PORT", "127.0.0.1"],
  ["WebSocket", websocketPort(process.env), "STACK_WEBSOCKET_PORT", "127.0.0.1"],
  ["Inspector", inspectorListenPort, "STACK_INSPECTOR_PORT", "127.0.0.1"],
  ["UI canvas", uiListenPort, "STACK_UI_PORT", "127.0.0.1"],
  ["Content documents", contentPort, "STACK_CONTENT_PORT", contentHost],
  ["Content artifacts", contentArtifactPort, "STACK_CONTENT_ARTIFACT_PORT", contentHost],
  ["Brain share", brainSharePort, "STACK_BRAIN_SHARE_PORT", brainShareHost],
  ...(accessHost ? [
    ["Access documents", accessPort, "STACK_ACCESS_PORT", accessHost],
    ["Access artifacts", accessArtifactPort, "STACK_ACCESS_ARTIFACT_PORT", accessHost],
    ...(process.env.STACK_ACCESS_UI_ORIGIN ? [["Access UI", accessUiPort, "STACK_ACCESS_UI_PORT", accessHost]] as const : []),
  ] as const : []),
];
// Resolve the share host as net.Server.listen does so aliases and wildcard
// binds cannot conceal a collision with the server's IPv4 loopback listeners.
const contentAddress = contentHost === "127.0.0.1" ? contentHost : (await lookup(contentHost).catch(() => {
  console.error("STACK_CONTENT_HOST could not be resolved"); process.exit(1);
})).address;
const bindAddress = (host: string) => host === brainShareHost ? brainShareAddress : host === contentHost ? contentAddress : host;
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
    console.error(`${transport} port ${port} is already in use on ${host}. An Stack server may already be running; check its server socket or choose another ${setting}.`);
    process.exit(1);
  }
}

// Browser configuration is issued per Bot launch, not inherited as a global
// provider selection by account-level Worker processes.

let events: Awaited<ReturnType<typeof serveApi>>;
try {
  events = await startWithServerSocketRecovery(socketPath("serve"), () => serveApi({ name: "serve", transport: "socket", env: process.env }));
  // Rotate only after successfully claiming the server socket; duplicate starts
  // must never invalidate the live server's sessions.
  withLocalAuth(process.env, auth => auth.rotate());
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let mcp: Awaited<ReturnType<typeof serveMcp>> | undefined;
let catalog: Awaited<ReturnType<typeof serveInspectorCatalog>> | undefined;
const subscriptions = createMcpEventSubscriptions(process.env);
statusSource.subscriptions = subscriptions;
subscriptions.onChange = () => statusSource.onStateChange?.();
try {
  mcp = await serveMcp({ env: process.env, subscriptions });
  statusSource.setMcpUrls(mcp.urls);
  catalog = await serveInspectorCatalog({ env: process.env, mcpPort: mcp.port });
} catch (error) {
  await Promise.allSettled([subscriptions.close(), catalog?.close(), mcp?.close(), events.close()]);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

let server: ReturnType<typeof startServer>;
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
    const ingress = await Promise.allSettled([subscriptions.close(), server.stop(["access", "websocket", "inspector", "ui"]), events.close(), mcp?.close(), catalog?.close()]);
    const children = await Promise.allSettled([server.close()]);
    return [...ingress, ...children];
  })().then((results) => {
    const failed = results.some((result) => result.status === "rejected");
    for (const result of results) {
      if (result.status === "rejected") console.error(result.reason);
    }
    process.exit(childFailed || failed ? 1 : 0);
  });
};
server = startServer([apiChild(), accessChild(), authChild(), rolesChild(), browseChild(), botsChild(mcp.port), hudChild(), workerChild(), usageChild(), inferChild(), signalChild(), notifyChild(), contentChild(), scrapeChild(), brainChild(), xcomChild(), procChild(), websocketChild(), inspectorChild(catalog.path, inspectorListenPort), uiChild(uiListenPort)], process.env, () => {
  statusSource.notify();
  if (!closing && server.children().some((child) => !child.running)) {
    childFailed = true;
    console.error("a required child stopped; shutting down stack");
    shutdown();
  }
}, [["access"], ["proc"], ["signal"], ["infer"], ["auth"], ["worker"], ["hud"], ["bots"], ["usage"], ["brain"], ["xcom"], ["scrape"], ["browse"], ["content"], ["roles"], ["notify"], ["api"]]);
statusSource.attach(server);
subscriptions.resume();
const indexUrl = `http://127.0.0.1:${uiListenPort}/`;
const uiUrl = `http://127.0.0.1:${uiListenPort}/`;
statusSource.setIndexUrl(indexUrl);
statusSource.setUiUrl(uiUrl);
statusSource.setInspectorUrl(`http://127.0.0.1:${inspectorListenPort}/`);

if (events.socketPath) console.error(events.socketPath);
console.error(`Stack UI entry: ${indexUrl}`);
console.error(`Stack UI canvas: ${uiUrl}`);
for (const [name, url] of Object.entries(mcp.urls)) console.error(`${name} MCP: ${url}`);
console.error(`Stack Inspector: http://127.0.0.1:${inspectorListenPort}/`);

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await runServeCommand(process.argv[2] ?? "", process.argv.slice(3));
}
