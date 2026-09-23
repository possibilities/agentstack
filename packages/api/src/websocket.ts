import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

export type ServedWebSocket = {
  url: string;
  publish(topic: string): void;
  close(): Promise<void>;
};

export type WebSocketSource = (
  publish: (topic: string) => void,
  info: { url: string },
) => (() => void) | void | Promise<(() => void) | void>;

const defaultMaxPayload = 16 * 1024;

export async function serveWebSocket(options: {
  topics: Record<string, string>;
  origin?: string;
  maxPayload?: number;
  subscribe?: WebSocketSource;
}): Promise<ServedWebSocket> {
  const topics = new Map(Object.entries(options.topics));
  const subscriptions = new Map<WebSocket, Set<string>>();
  const server = new WebSocketServer({ noServer: true, maxPayload: options.maxPayload ?? defaultMaxPayload });

  const publish = (topic: string): void => {
    if (!topics.has(topic)) throw new Error(`unknown topic: ${topic}`);
    const frame = JSON.stringify({ type: "event", topic });
    for (const [client, subscribed] of subscriptions) {
      if (subscribed.has(topic) && client.readyState === client.OPEN) client.send(frame);
    }
  };

  server.on("connection", (client) => {
    const subscribed = new Set<string>();
    subscriptions.set(client, subscribed);
    client.on("message", (raw, binary) => handleMessage(client, subscribed, topics, raw, binary));
    const drop = () => subscriptions.delete(client);
    client.on("close", drop);
    client.on("error", drop);
  });

  const http = createServer((_req, res) => {
    res.writeHead(400).end();
  });
  http.on("upgrade", (request, socket, head) => {
    if (!originAllowed(request.headers.origin, options.origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    server.handleUpgrade(request, socket, head, (client) => server.emit("connection", client, request));
  });

  await listen(http);
  const address = http.address();
  if (address === null || typeof address === "string") {
    await closeHttp(http);
    throw new Error("failed to listen");
  }
  const url = `ws://127.0.0.1:${address.port}`;

  let unsubscribe: (() => void) | void;
  try {
    unsubscribe = await options.subscribe?.(publish, { url });
  } catch (error) {
    await shutdown(subscriptions, server, http).catch(() => undefined);
    throw error;
  }

  let closed = false;
  return {
    url,
    publish,
    async close() {
      if (closed) return;
      closed = true;
      let failure: unknown;
      try {
        await unsubscribe?.();
      } catch (error) {
        failure = error;
      }
      await shutdown(subscriptions, server, http);
      if (failure !== undefined) throw failure;
    },
  };
}

function handleMessage(
  client: WebSocket,
  subscribed: Set<string>,
  topics: Map<string, string>,
  raw: unknown,
  binary: boolean,
): void {
  if (binary) {
    send(client, { type: "error", message: "binary frames are not supported" });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    send(client, { type: "error", message: "invalid json" });
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    send(client, { type: "error", message: "invalid frame" });
    return;
  }
  const message = parsed as { type?: unknown; topic?: unknown };
  switch (message.type) {
    case "subscribe": {
      if (typeof message.topic !== "string" || !topics.has(message.topic)) {
        send(client, { type: "error", message: `unknown topic: ${String(message.topic)}` });
        return;
      }
      subscribed.add(message.topic);
      send(client, { type: "subscribed", topic: message.topic });
      return;
    }
    case "unsubscribe": {
      if (typeof message.topic !== "string") {
        send(client, { type: "error", message: "missing topic" });
        return;
      }
      subscribed.delete(message.topic);
      send(client, { type: "unsubscribed", topic: message.topic });
      return;
    }
    default:
      send(client, { type: "error", message: `unknown message type: ${String(message.type)}` });
  }
}

function originAllowed(header: string | undefined, configured: string | undefined): boolean {
  if (header === undefined || header === "") return true;
  if (configured) return header === configured;
  try {
    const hostname = new URL(header).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function send(client: WebSocket, message: unknown): void {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}

async function shutdown(subscriptions: Map<WebSocket, Set<string>>, server: WebSocketServer, http: Server): Promise<void> {
  for (const client of subscriptions.keys()) client.terminate();
  subscriptions.clear();
  await closeWebsocket(server);
  await closeHttp(http);
}

function listen(http: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", () => {
      http.off("error", reject);
      resolve();
    });
  });
}

function closeWebsocket(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function closeHttp(http: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    http.close((error) => (error ? reject(error) : resolve()));
  });
}
