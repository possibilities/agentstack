import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { listPackages, socketPath, websocketPort, workspaceRoot } from "./workspace.js";
import { socketCall, socketSubscribe, type SocketSubscription } from "./socket.js";
import { exposeCatalog, socketExposure, type Exposure, type SocketCatalog } from "./exposure.js";

export type ServedWebSocket = { url: string; close(): Promise<void> };
/** An ingress-authenticated connection. The gateway still resolves live socket
 * metadata and intersects this principal's policy with WebSocket exposure. */
export type RemoteWebSocketAdmission = {
  select(pkg: string, exposure: Exposure, catalog: SocketCatalog): Exposure;
  check(): void;
  mutation(pkg: string, operation: string): void;
  onChange(close: () => void): () => void;
  expiresAt: number;
};

// Match the socket's bounded JSON allowance for escaped inline content.
const maxPayload = 4_000_000;
const maxClientBuffer = 4_000_000;
/**
 * Operations whose own bounds exceed the default forwarding timeout. Timing out
 * first would report a failure while the operation continues; for inference that
 * hides a request that may already have been charged.
 */
const forwardTimeouts = new Map([
  ["bots/voice_dial", 75_000],
  // Discovery waits up to 20s for model/list; inference adds one request bounded at 30s.
  ["infer/infer_models", 30_000],
  ["infer/infer_complete", 75_000],
  ["signal/attention_models", 75_000],
  ["bots/chat_message_changes", 30_000],
  // Browser-backed extraction chains several 30s agent-browser steps; links also scroll.
  ["scrape/scrape_fetch", 120_000],
  ["scrape/scrape_links", 180_000],
  // Feed discovery accepts timeoutSeconds up to 300.
  ["scrape/scrape_feed_discover", 310_000],
  ["scrape/scrape_corpus_replay", 120_000],
  // Canaries and queue processing run sequential live extractions.
  ["scrape/scrape_presets_check", 600_000],
  ["scrape/scrape_queue_process", 600_000],
  // Take drains, activates the tab and grants input; finish also closes each bound controller (65s each).
  ["browse/browser_handoff_take", 60_000],
  ["browse/browser_handoff_finish", 180_000],
  ["browse/browser_profile_delete", 60_000],
  // npm install is bounded at 180s; an automatic-policy check may install.
  ["browse/agent_browser_check_updates", 200_000],
  ["browse/agent_browser_install", 200_000],
  ["browse/agent_browser_update_accept", 200_000],
  // Download (180s) plus verification and extraction.
  ["browse/hypeman_install", 300_000],
]);

export async function serveWebSocket(options: { env?: NodeJS.ProcessEnv; root?: string; port?: number;
  server?: Server; authenticate?: (request: IncomingMessage) => Promise<RemoteWebSocketAdmission> } = {}): Promise<ServedWebSocket> {
  if (options.server && !options.authenticate) throw new Error("An attached WebSocket server requires authenticated admission");
  const env = options.env ?? process.env;
  const port = options.port ?? websocketPort(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("WebSocket port must be an integer from 0 to 65535");
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  if ((await listPackages(root)).every((item) => !item.config.websocket)) throw new Error("no Package APIs configure websocket");

  const clients = new Set<WebSocket>();
  const admitted = new WeakMap<WebSocket, { operations: Map<string, Exposure>; remote?: RemoteWebSocketAdmission }>();
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  let closing: Promise<void> | undefined;
  wss.on("connection", (client) => {
    const admission = admitted.get(client);
    const operations = admission?.operations;
    clients.add(client);
    if (!operations) { client.terminate(); return; }
    const controller = new AbortController();
    const subscriptions = new Map<string, { name: string; current?: SocketSubscription; chain: Promise<void>; tasks: number }>();
    let stopped = false;
    const unsubscribe = admission.remote?.onChange(() => { try { admission.remote?.check(); } catch { client.terminate(); } });
    const expiry = admission.remote ? setTimeout(() => client.terminate(), Math.max(0, admission.remote.expiresAt - Date.now())) : null;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe?.();
      if (expiry) clearTimeout(expiry);
      clients.delete(client);
      controller.abort();
      for (const entry of subscriptions.values()) void entry.current?.close();
      subscriptions.clear();
    };
    client.on("close", stop);
    client.on("error", stop);
    client.on("message", (raw, binary) => {
      try { admission.remote?.check(); } catch { client.terminate(); return; }
      if (binary) { send(client, { id: null, error: { message: "binary frames are not supported" } }); return; }
      let message: { id?: unknown; method?: unknown; params?: unknown };
      try {
        const parsed: unknown = JSON.parse(String(raw));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid frame");
        message = parsed as typeof message;
      } catch {
        send(client, { id: null, error: { message: "invalid json or frame" } });
        return;
      }
      const id = message.id ?? null;
      const respond = (result: unknown) => send(client, { id, result });
      const fail = (error: unknown) => send(client, { id, error: { message: error instanceof Error ? error.message : String(error) } });
      const params = message.params as Record<string, unknown> | undefined;
      const name = params?.package;
      if (typeof name !== "string" || !operations.has(name)) {
        fail(new Error(`package ${String(name)} is not available over websocket`));
        return;
      }
      if (message.method === "events/subscribe" || message.method === "events/unsubscribe") {
        if (message.method === "events/subscribe" && (!params || !Array.isArray(params.topics) || params.topics.length > 256
          || (params.scope !== undefined && typeof params.scope !== "string"))) {
          fail(new Error("invalid event subscription"));
          return;
        }
        const topics = params?.topics as string[];
        if (message.method === "events/subscribe" && topics.some((topic) => !operations.get(name)!.events.includes(topic))) {
          fail(new Error("event topic is not available over websocket"));
          return;
        }
        const scope = params?.scope as string | undefined;
        const key = params?.subscription;
        if (typeof key !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(key)) {
          fail(new Error("invalid subscription id"));
          return;
        }
        let entry = subscriptions.get(key);
        if (entry && entry.name !== name) { fail(new Error("subscription belongs to another package")); return; }
        if (!entry && message.method === "events/subscribe") {
          if (subscriptions.size >= 256) { fail(new Error("too many subscriptions")); return; }
          entry = { name, chain: Promise.resolve(), tasks: 0 };
          subscriptions.set(key, entry);
        }
        if (!entry) { respond({ subscription: key }); return; }
        // Free the identifier now: a subscribe queued behind this unsubscribe
        // must create a new entry, not resurrect an entry already being removed.
        if (message.method === "events/unsubscribe") subscriptions.delete(key);
        const selected = entry;
        selected.tasks++;
        selected.chain = selected.chain.catch(() => undefined).then(async () => {
          if (stopped) return;
          if (message.method === "events/unsubscribe") {
            const previous = selected.current;
            selected.current = undefined;
            await previous?.close();
            respond({ subscription: key });
            return;
          }
          // The socket may deliver a notice in the same read as its acknowledgement.
          // Keep the WebSocket acknowledgement ahead of those notices.
          let acknowledged = false;
          const pending: string[] = [];
          const envelope = { package: name, subscription: key };
          const notice = (topic: string) => send(client, { method: "events/changed", params: { ...envelope, topic } });
          const next = await socketSubscribe(socketPath(name, env), topics, (topic) => {
            if (acknowledged) notice(topic);
            else pending.push(topic);
          }, { scope, signal: controller.signal });
          if (stopped) { await next.close(); return; }
          const previous = selected.current;
          selected.current = next;
          await previous?.close();
          respond({ ...envelope, topics: [...next.topics], ...(next.scope === undefined ? {} : { scope: next.scope }) });
          acknowledged = true;
          for (const topic of pending) notice(topic);
          void next.closed.then(() => {
            if (!stopped && selected.current === next) {
              selected.current = undefined;
              send(client, { method: "events/disconnected", params: envelope });
            }
          });
        }).catch(fail).finally(() => {
          selected.tasks--;
          if (selected.tasks === 0 && !selected.current && subscriptions.get(key) === selected) subscriptions.delete(key);
        });
      } else if (message.method === "tools/list" || message.method === "tools/call") {
        const operation = message.method === "tools/call" ? params?.name : undefined;
        const timeoutMs = typeof operation === "string" ? forwardTimeouts.get(`${name}/${operation}`) : undefined;
        void (async () => {
          if (message.method === "tools/call") {
            const allowedOperations = operations.get(name)!.operations;
            if (typeof operation !== "string" || !allowedOperations.includes(operation))
              throw new Error(`operation ${String(operation)} is not available over websocket`);
            if (message.params && typeof message.params === "object" && "resultFormat" in message.params)
              throw new Error("MCP result presentation is not available over websocket");
            admission.remote?.mutation(name, operation);
          }
          const result = await socketCall(socketPath(name, env), message.method as "tools/list" | "tools/call", message.params, { signal: controller.signal, timeoutMs });
          admission.remote?.check();
          if (message.method === "tools/list") return exposeCatalog(result as SocketCatalog, operations.get(name)!);
          return result;
        })().then(respond, fail);
      } else {
        fail(new Error(`unknown method: ${String(message.method)}`));
      }
    });
  });

  const http = options.server ?? createServer((_req, res) => res.writeHead(404).end());
  const upgrade = (request: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) => {
    const address = http.address();
    if (request.url !== "/websocket") { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    if (!options.server && (!address || typeof address === "string" || ![`127.0.0.1:${address.port}`, `localhost:${address.port}`].includes(request.headers.host ?? "")
      || !originAllowed(request.headers.origin, env.AGENTSTACK_WEBSOCKET_ORIGIN))) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
    }
    void (async () => {
      let operations: Map<string, Exposure>;
      let remote: RemoteWebSocketAdmission | undefined;
      try {
        remote = await options.authenticate?.(request);
        const configured = await listPackages(root);
        operations = new Map(await Promise.all(configured.filter((item) => item.config.websocket).map(async (item) =>
          { const { exposure, catalog } = await socketExposure(item.config, "websocket", env);
            return [item.config.name, remote ? remote.select(item.config.name, exposure, catalog) : exposure] as const; })));
        // Access may revoke or narrow the grant while live metadata is loading.
        remote?.check();
      } catch (error) {
        console.error(`WebSocket configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
        if (!socket.destroyed) { socket.write(`HTTP/1.1 ${options.server ? "403 Forbidden" : "503 Service Unavailable"}\r\n\r\n`); socket.destroy(); }
        return;
      }
      if (closing || socket.destroyed) { socket.destroy(); return; }
      if (operations.size === 0) { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); return; }
      try {
        wss.handleUpgrade(request, socket, head, (client) => {
          admitted.set(client, { operations, remote });
          wss.emit("connection", client, request);
        });
      } catch (error) {
        console.error("WebSocket upgrade failed:", error);
        socket.destroy();
      }
    })();
  };
  http.on("upgrade", upgrade);
  if (!options.server) await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("WebSocket server has no TCP address");
  return {
    url: `ws://127.0.0.1:${address.port}/websocket`,
    close() {
      closing ??= (async () => {
        for (const client of clients) client.terminate();
        await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
        http.off("upgrade", upgrade);
        if (!options.server) await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      })();
      return closing;
    },
  };
}

function originAllowed(header: string | undefined, configured: string | undefined): boolean {
  if (header === undefined || header === "") return true;
  if (configured) return header === configured;
  try {
    const hostname = new URL(header).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function send(client: WebSocket, message: unknown): void {
  if (client.readyState !== client.OPEN) return;
  if (client.bufferedAmount > maxClientBuffer) { client.terminate(); return; }
  client.send(JSON.stringify(message));
}
