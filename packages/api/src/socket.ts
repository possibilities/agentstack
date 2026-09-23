import { chmod, lstat, mkdir, rm } from "node:fs/promises";
import { createServer, connect, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { z } from "zod";
import type { AnyOperation } from "./operation.js";
import { publishedJsonSchema } from "./schema.js";

export type SocketServerInfo = {
  name: string;
  description: string;
  transportDescription: string;
  path: string;
  websocket?: { url: string; topics: Record<string, string> };
};

export type ServedSocket = {
  path: string;
  close(): Promise<void>;
};

const maxLine = 1_000_000;

export async function serveSocket<Ctx>(options: {
  info: SocketServerInfo;
  context: Ctx | Promise<Ctx>;
  operations: readonly AnyOperation<Ctx>[];
}): Promise<ServedSocket> {
  const names = new Set<string>();
  for (const operation of options.operations) {
    if (names.has(operation.name)) throw new Error(`duplicate operation: ${operation.name}`);
    names.add(operation.name);
  }
  await prepareSocket(options.info.path);
  const clients = new Set<Socket>();
  const active = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const server = createServer((socket) => {
    if (closing) {
      socket.destroy();
      return;
    }
    clients.add(socket);
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
          const request = handleLine(socket, line, options);
          active.add(request);
          void request.then(
            () => active.delete(request),
            (error) => {
              active.delete(request);
              write(socket, { id: null, error: { message: errorMessage(error) } });
            },
          );
        }
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
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
    close() {
      if (closing) return closing;
      closing = (async () => {
        for (const socket of clients) socket.destroy();
        await Promise.allSettled([...active]);
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
  options: { info: SocketServerInfo; context: Ctx | Promise<Ctx>; operations: readonly AnyOperation<Ctx>[] },
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
    const result = await dispatch(message.method, message.params, options);
    write(socket, { id, result });
  } catch (error) {
    write(socket, { id, error: { message: errorMessage(error) } });
  }
}

async function dispatch<Ctx>(
  method: string,
  params: unknown,
  options: { info: SocketServerInfo; context: Ctx | Promise<Ctx>; operations: readonly AnyOperation<Ctx>[] },
): Promise<unknown> {
  if (method === "tools/list") return describeServer(options);
  if (method === "tools/call") return callTool(params, { context: await options.context, operations: options.operations });
  throw new Error(`unknown method: ${method}`);
}

function describeServer<Ctx>(options: {
  info: SocketServerInfo;
  operations: readonly AnyOperation<Ctx>[];
}): unknown {
  return {
    server: { name: options.info.name, description: options.info.description },
    transport: {
      type: "socket",
      description: options.info.transportDescription,
      path: options.info.path,
    },
    websocket: options.info.websocket ? { url: options.info.websocket.url, topics: options.info.websocket.topics } : null,
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
  const record = params && typeof params === "object" ? (params as { name?: unknown; arguments?: unknown }) : {};
  if (typeof record.name !== "string") throw new Error("missing operation name");
  const operation = options.operations.find((item) => item.name === record.name);
  if (!operation) throw new Error(`unknown operation: ${record.name}`);
  const input = operation.input.parse(record.arguments ?? {});
  const output = await operation.call(options.context, input);
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
