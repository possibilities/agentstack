import { createServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { listPackages, socketPath, websocketPort, workspaceRoot } from "./workspace.js";
import { socketCall, socketSubscribe, type SocketSubscription } from "./socket.js";

export type ServedWebSocket = { urls: Record<string, string>; close(): Promise<void> };

const maxPayload = 1_000_000;
const maxClientBuffer = 1_000_000;

export async function serveWebSocket(options: { env?: NodeJS.ProcessEnv; root?: string; port?: number } = {}): Promise<ServedWebSocket> {
  const env = options.env ?? process.env;
  const port = options.port ?? websocketPort(env);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("WebSocket port must be an integer from 0 to 65535");
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  const names = await configuredWebSocketNames(root);
  if (names.size === 0) throw new Error("no Package APIs configure websocket");

  const clients = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  let closing: Promise<void> | undefined;
  wss.on("connection", (client, request) => {
    clients.add(client);
    const name = /^\/websocket\/([a-z][a-z0-9-]{0,31})$/.exec(request.url ?? "")?.[1];
    if (!name) { client.terminate(); return; }
    const controller = new AbortController();
    let subscription: SocketSubscription | undefined;
    let subscriptions = Promise.resolve();
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clients.delete(client);
      controller.abort();
      void subscription?.close();
    };
    client.on("close", stop);
    client.on("error", stop);
    client.on("message", (raw, binary) => {
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
      if (message.method === "events/subscribe") {
        subscriptions = subscriptions.then(async () => {
          if (stopped) return;
          const params = message.params as { topics?: unknown; scope?: unknown } | undefined;
          if (!params || !Array.isArray(params.topics) || params.topics.length > 256
            || (params.scope !== undefined && typeof params.scope !== "string")) {
            throw new Error("invalid event subscription");
          }
          // The socket may deliver a notice in the same read as its acknowledgement.
          // Keep the WebSocket acknowledgement ahead of those notices.
          let acknowledged = false;
          const pending: string[] = [];
          const notice = (topic: string) => send(client, { method: "events/changed", params: { topic } });
          const next = await socketSubscribe(socketPath(name, env), params.topics, (topic) => {
            if (acknowledged) notice(topic);
            else pending.push(topic);
          }, { scope: params.scope as string | undefined, signal: controller.signal });
          if (stopped) { await next.close(); return; }
          const previous = subscription;
          subscription = next;
          await previous?.close();
          respond({ topics: [...next.topics], ...(next.scope === undefined ? {} : { scope: next.scope }) });
          acknowledged = true;
          for (const topic of pending) notice(topic);
          void next.closed.then(() => {
            if (!stopped && subscription === next) {
              subscription = undefined;
              send(client, { method: "events/disconnected", params: {} });
            }
          });
        }).catch(fail);
      } else if (message.method === "tools/list" || message.method === "tools/call") {
        const voiceDial = name === "codex" && message.method === "tools/call"
          && (message.params as { name?: unknown } | undefined)?.name === "voice_dial";
        void socketCall(socketPath(name, env), message.method, message.params, { signal: controller.signal, timeoutMs: voiceDial ? 75_000 : undefined }).then(respond, fail);
      } else {
        fail(new Error(`unknown method: ${String(message.method)}`));
      }
    });
  });

  const http = createServer((_req, res) => res.writeHead(404).end());
  http.on("upgrade", (request, socket, head) => {
    const address = http.address();
    const name = /^\/websocket\/([a-z][a-z0-9-]{0,31})$/.exec(request.url ?? "")?.[1];
    if (!name) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
    if (!address || typeof address === "string" || ![`127.0.0.1:${address.port}`, `localhost:${address.port}`].includes(request.headers.host ?? "")
      || !originAllowed(request.headers.origin, env.AGENTSTACK_WEBSOCKET_ORIGIN)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
    }
    void (async () => {
      let current: Set<string>;
      try {
        current = await configuredWebSocketNames(root);
      } catch (error) {
        console.error(`WebSocket configuration unavailable: ${error instanceof Error ? error.message : String(error)}`);
        if (!socket.destroyed) { socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n"); socket.destroy(); }
        return;
      }
      if (closing || socket.destroyed) { socket.destroy(); return; }
      if (!current.has(name)) { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return; }
      try {
        wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request));
      } catch (error) {
        console.error("WebSocket upgrade failed:", error);
        socket.destroy();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => { http.off("error", reject); resolve(); });
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("WebSocket server has no TCP address");
  return {
    urls: Object.fromEntries([...names].map((name) => [name, `ws://127.0.0.1:${address.port}/websocket/${name}`])),
    close() {
      closing ??= (async () => {
        for (const client of clients) client.terminate();
        await new Promise<void>((resolve, reject) => wss.close((error) => error ? reject(error) : resolve()));
        await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
      })();
      return closing;
    },
  };
}

async function configuredWebSocketNames(root: string): Promise<Set<string>> {
  return new Set((await listPackages(root)).filter((item) => item.config.websocket).map((item) => item.config.name));
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
