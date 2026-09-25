import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import type { AnyOperation, InvocationContext } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";

export type SocketServerInfo = {
  name: string;
  description: string;
  transportDescription: string;
  path: string;
};

export type SocketEvents<Ctx> = {
  topics: Record<string, string>;
  scope?: { description: string; example: string; required?: boolean; valid(ctx: Ctx, scope: string): boolean };
};

export type ServedSocket = {
  path: string;
  publish?: (topic: string, scope?: string) => void;
  close(): Promise<void>;
};

const maxLine = 1_000_000;
const maxClientBuffer = 1_000_000;
const maxTopics = 256;

export async function serveSocket<Ctx>(options: {
  info: SocketServerInfo;
  context: Ctx | Promise<Ctx>;
  operations: readonly AnyOperation<Ctx>[];
  events?: SocketEvents<Ctx>;
}): Promise<ServedSocket> {
  const names = new Set<string>();
  for (const operation of options.operations) {
    if (names.has(operation.name)) throw new Error(`duplicate operation: ${operation.name}`);
    names.add(operation.name);
  }
  const topics = new Map(Object.entries(options.events?.topics ?? {}));
  const subscriptions = new Map<Socket, { topics: Set<string>; scope?: string }>();
  const publish = options.events
    ? (topic: string, scope?: string): void => {
        if (!topics.has(topic)) throw new Error(`unknown topic: ${topic}`);
        for (const [client, subscribed] of subscriptions) {
          if (!subscribed.topics.has(topic) || !client.writable || (subscribed.scope && subscribed.scope !== scope)) continue;
          if (client.writableLength > maxClientBuffer) {
            client.destroy();
            continue;
          }
          write(client, { method: "events/changed", params: { topic } });
        }
      }
    : undefined;
  const handler = { ...options, subscriptions };
  await prepareSocket(options.info.path);
  const clients = new Set<Socket>();
  const active = new Set<Promise<void>>();
  const activeClients = new Map<Socket, number>();
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    clients.add(socket);
    subscriptions.set(socket, { topics: new Set() });
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (closing || buffer.length > maxLine) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const request = handleLine(socket, line, handler);
          active.add(request);
          activeClients.set(socket, (activeClients.get(socket) ?? 0) + 1);
          const finished = () => {
            const count = (activeClients.get(socket) ?? 1) - 1;
            if (count) activeClients.set(socket, count);
            else {
              activeClients.delete(socket);
              if (closing) socket.end();
            }
          };
          void request.then(
            () => { active.delete(request); finished(); },
            (error) => {
              active.delete(request);
              write(socket, { id: null, error: { message: errorMessage(error) } });
              finished();
            },
          );
        }
        newline = buffer.indexOf("\n");
      }
    });
    const drop = () => {
      clients.delete(socket);
      subscriptions.delete(socket);
      activeClients.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  });

  try {
    await listen(server, options.info.path);
    await chmod(options.info.path, 0o600);
  } catch (error) {
    if (server.listening) {
      for (const socket of clients) socket.destroy();
      await closeServer(server);
      await rm(options.info.path, { force: true });
    }
    throw error;
  }
  return {
    path: options.info.path,
    publish,
    close() {
      if (closing) return closing;
      closing = (async () => {
        subscriptions.clear();
        for (const socket of clients) if (!activeClients.has(socket)) socket.destroy();
        await Promise.allSettled([...active]);
        for (const socket of clients) socket.end();
        await closeServer(server);
        await rm(options.info.path, { force: true });
      })();
      return closing;
    },
  };
}

export function socketCall(
  socketPath: string,
  method: string,
  params?: unknown,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<unknown> {
  let request: string;
  try {
    request = `${JSON.stringify({ id: 1, method, params })}\n`;
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = "";
    let settled = false;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timer = setTimeout(() => fail(new Error(`socket call timed out: ${method}`)), timeoutMs);
    const onAbort = () => fail(options.signal?.reason ?? new Error("socket call aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      client.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    if (options.signal?.aborted) {
      fail(options.signal.reason);
      return;
    }
    client.setEncoding("utf8");
    client.once("error", fail);
    client.once("end", () => fail(new Error("socket closed before a complete response")));
    client.once("close", () => fail(new Error("socket closed before a complete response")));
    client.once("connect", () => {
      client.write(request);
    });
    client.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > maxLine) {
        fail(new Error("socket response is too large"));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as { result?: unknown; error?: unknown };
        if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid socket response");
        let rpcError: Error | undefined;
        if (message.error !== undefined) {
          if (!message.error || typeof message.error !== "object" || Array.isArray(message.error)) {
            throw new Error("invalid socket response error");
          }
          const detail = (message.error as { message?: unknown }).message;
          rpcError = new Error(typeof detail === "string" ? detail : "rpc failed");
        }
        settled = true;
        cleanup();
        client.end();
        if (rpcError) reject(rpcError);
        else resolve(message.result);
      } catch (error) {
        fail(error);
      }
    });
  });
}

export type SocketSubscription = {
  topics: readonly string[];
  scope?: string;
  closed: Promise<void>;
  close(): Promise<void>;
};

export function socketSubscribe(
  socketPath: string,
  topics: readonly string[],
  onEvent: (topic: string) => void,
  options: { timeoutMs?: number; signal?: AbortSignal; scope?: string } = {},
): Promise<SocketSubscription> {
  if (topics.length === 0) return Promise.reject(new Error("socket subscription needs at least one topic"));
  if (new Set(topics).size !== topics.length) return Promise.reject(new Error("socket subscription repeats a topic"));
  let request: string;
  try {
    request = `${JSON.stringify({ id: 1, method: "events/subscribe", params: { topics: [...topics], ...(options.scope === undefined ? {} : { scope: options.scope }) } })}\n`;
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    const wanted = new Set(topics);
    let buffer = "";
    let acknowledged = false;
    let rejected = false;
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolveClosedPromise) => {
      resolveClosed = resolveClosedPromise;
    });
    const timeoutMs = options.timeoutMs ?? 10_000;
    const timer = setTimeout(() => fail(new Error("socket subscribe timed out")), timeoutMs);
    const onAbort = () => {
      if (acknowledged) client.destroy();
      else fail(options.signal?.reason ?? new Error("socket subscribe aborted"));
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const subscription: SocketSubscription = {
      topics,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      closed,
      close() {
        client.destroy();
        return closed;
      },
    };
    const fail = (error?: unknown) => {
      if (rejected || acknowledged) return;
      rejected = true;
      client.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    if (options.signal?.aborted) {
      fail(options.signal.reason);
      return;
    }
    client.setEncoding("utf8");
    client.once("error", (error) => {
      if (!acknowledged) fail(error);
    });
    client.once("close", () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (!acknowledged) fail(new Error("socket closed before the subscription was acknowledged"));
      resolveClosed();
    });
    client.once("connect", () => {
      client.write(request);
    });
    client.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      if ((newline === -1 && buffer.length > maxLine) || newline > maxLine) {
        if (!acknowledged) fail(new Error("socket response is too large"));
        else client.destroy();
        return;
      }
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let message: { id?: unknown; result?: unknown; error?: unknown; method?: unknown; params?: unknown };
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid socket message");
            message = parsed as typeof message;
          } catch (error) {
            if (!acknowledged) fail(error);
            else client.destroy();
            return;
          }
          if (!acknowledged) {
            if (message.id === 1 || message.id === null) {
              if (message.error !== undefined) {
                const detail =
                  message.error && typeof message.error === "object"
                    ? (message.error as { message?: unknown }).message
                    : undefined;
                fail(new Error(typeof detail === "string" ? detail : "socket subscribe failed"));
                return;
              }
              const result = message.result as { topics?: unknown; scope?: unknown } | undefined;
              const granted = result?.topics;
              if (
                !Array.isArray(granted)
                || granted.length !== wanted.size
                || new Set(granted).size !== granted.length
                || !granted.every((topic) => typeof topic === "string" && wanted.has(topic))
                || result?.scope !== options.scope
              ) {
                fail(new Error("subscribe acknowledgement did not match the requested topics"));
                return;
              }
              acknowledged = true;
              clearTimeout(timer);
              resolve(subscription);
            }
          } else if (message.method === "events/changed") {
            const topic = (message.params as { topic?: unknown } | undefined)?.topic;
            if (typeof topic !== "string" || !wanted.has(topic)) {
              client.destroy();
              return;
            }
            onEvent(topic);
          } else {
            client.destroy();
            return;
          }
        }
        newline = buffer.indexOf("\n");
        if ((newline === -1 && buffer.length > maxLine) || newline > maxLine) {
          client.destroy();
          return;
        }
      }
    });
  });
}

async function prepareSocket(socketPath: string): Promise<void> {
  const directory = dirname(socketPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  // A probe followed by unlink can remove a socket another process just bound.
  // Refuse an existing path until its owner has been checked and it is removed.
  if (await lstat(socketPath).then(() => true, () => false)) {
    const detail = (await socketListening(socketPath)) ? "already listening" : "already exists (possibly stale)";
    throw new Error(`socket ${detail} at ${socketPath}`);
  }
}

function socketListening(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = connect(socketPath);
    const finish = (listening: boolean) => {
      client.destroy();
      resolve(listening);
    };
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") reject(new Error(`socket is already listening at ${socketPath}`));
      else reject(error);
    };
    server.once("error", fail);
    server.listen(socketPath, () => {
      server.off("error", fail);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function handleLine<Ctx>(
  socket: Socket,
  line: string,
  options: {
    info: SocketServerInfo;
    context: Ctx | Promise<Ctx>;
    operations: readonly AnyOperation<Ctx>[];
    events?: SocketEvents<Ctx>;
    subscriptions?: Map<Socket, { topics: Set<string>; scope?: string }>;
  },
): Promise<void> {
  let message: { id?: unknown; method?: unknown; params?: unknown };
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid request");
    message = parsed as { id?: unknown; method?: unknown; params?: unknown };
  } catch {
    write(socket, { id: null, error: { message: "invalid json" } });
    return;
  }
  const id = message.id ?? null;
  if (typeof message.method !== "string") {
    write(socket, { id, error: { message: "missing method" } });
    return;
  }
  try {
    const result = await dispatch(socket, message.method, message.params, options);
    write(socket, { id, result });
  } catch (error) {
    write(socket, { id, error: { message: errorMessage(error) } });
  }
}

async function dispatch<Ctx>(
  socket: Socket,
  method: string,
  params: unknown,
  options: {
    info: SocketServerInfo;
    context: Ctx | Promise<Ctx>;
    operations: readonly AnyOperation<Ctx>[];
    events?: SocketEvents<Ctx>;
    subscriptions?: Map<Socket, { topics: Set<string>; scope?: string }>;
  },
): Promise<unknown> {
  if (method === "tools/list") return describeServer(options);
  if (method === "tools/call") return callTool(params, { context: await options.context, operations: options.operations });
  if (method === "events/subscribe") return subscribeEvents(socket, params, options);
  throw new Error(`unknown method: ${method}`);
}

async function subscribeEvents<Ctx>(
  socket: Socket,
  params: unknown,
  options: { info: SocketServerInfo; context: Ctx | Promise<Ctx>; events?: SocketEvents<Ctx>; subscriptions?: Map<Socket, { topics: Set<string>; scope?: string }> },
): Promise<unknown> {
  if (!options.events || !options.subscriptions) {
    throw new Error(`${options.info.name} does not serve events on this socket`);
  }
  const requested = (params as { topics?: unknown } | undefined)?.topics;
  if (!Array.isArray(requested) || requested.length === 0 || requested.length > maxTopics) {
    throw new Error("events/subscribe needs a non-empty topics array");
  }
  const next = new Set<string>();
  for (const topic of requested) {
    if (typeof topic !== "string" || options.events.topics[topic] === undefined) {
      throw new Error(`unknown topic: ${String(topic)}`);
    }
    if (next.has(topic)) throw new Error(`duplicate topic: ${topic}`);
    next.add(topic);
  }
  const scope = (params as { scope?: unknown }).scope;
  if (scope !== undefined && (typeof scope !== "string" || !options.events.scope || !options.events.scope.valid(await options.context, scope))) {
    throw new Error(`invalid event scope: ${String(scope)}`);
  }
  if (scope === undefined && options.events.scope?.required) throw new Error("events/subscribe needs a scope");
  if (socket.destroyed) return { topics: [...next], ...(scope === undefined ? {} : { scope }) };
  options.subscriptions.set(socket, { topics: next, ...(scope === undefined ? {} : { scope }) });
  return { topics: [...next], ...(scope === undefined ? {} : { scope }) };
}

function describeServer<Ctx>(options: {
  info: SocketServerInfo;
  operations: readonly AnyOperation<Ctx>[];
  events?: SocketEvents<Ctx>;
}): unknown {
  return {
    server: { name: options.info.name, description: options.info.description },
    transport: {
      type: "socket",
      description: options.info.transportDescription,
      path: options.info.path,
    },
    websocket: null,
    events: options.events ? { topics: options.events.topics, subscribe: "events/subscribe", ...(options.events.scope ? { scope: {
      description: options.events.scope.description, example: options.events.scope.example, required: options.events.scope.required ?? false,
    } } : {}) } : null,
    tools: options.operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: publishedJsonSchema(operation.input),
      outputSchema: publishedJsonSchema(operation.output),
      annotations: operation.annotations ?? {},
    })),
  };
}

async function callTool<Ctx>(
  params: unknown,
  options: { context: Ctx; operations: readonly AnyOperation<Ctx>[] },
): Promise<unknown> {
  const record = params && typeof params === "object" ? (params as { name?: unknown; arguments?: unknown; invocation?: unknown }) : {};
  if (typeof record.name !== "string") throw new Error("missing operation name");
  const operation = options.operations.find((item) => item.name === record.name);
  if (!operation) throw new Error(`unknown operation: ${record.name}`);
  const input = operation.input.parse(record.arguments ?? {});
  const invocation = record.invocation === undefined ? undefined : z.strictObject({
    transport: z.literal("mcp"), botId: z.string().nullable(), instance: z.string().nullable(),
    threadId: z.string().nullable(), sessionId: z.string().nullable(),
    workerId: z.string().nullable().optional(), workerInstance: z.string().nullable().optional(),
  }).parse(record.invocation) as InvocationContext;
  const output = await operation.call(options.context, input, invocation);
  return operation.output.parse(output);
}

function write(socket: Socket, message: unknown): void {
  if (!socket.writable) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
