import { chmod, mkdir, rm } from "node:fs/promises";
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
};

export type ServedSocket = {
  path: string;
  close(): Promise<void>;
};

const maxLine = 1_000_000;

export async function serveSocket<Ctx>(options: {
  info: SocketServerInfo;
  context: Ctx;
  operations: readonly AnyOperation<Ctx>[];
}): Promise<ServedSocket> {
  const names = new Set<string>();
  for (const operation of options.operations) {
    if (names.has(operation.name)) throw new Error(`duplicate operation: ${operation.name}`);
    names.add(operation.name);
  }
  await prepareSocket(options.info.path);
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > maxLine) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) void handleLine(socket, line, options);
        newline = buffer.indexOf("\n");
      }
    });
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });

  await listen(server, options.info.path);
  await chmod(options.info.path, 0o600);
  return {
    path: options.info.path,
    async close() {
      for (const socket of clients) socket.destroy();
      await closeServer(server);
      await rm(options.info.path, { force: true });
    },
  };
}

export function socketCall(socketPath: string, method: string, params?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = connect(socketPath);
    let buffer = "";
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      client.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    client.setEncoding("utf8");
    client.once("error", fail);
    client.once("connect", () => {
      client.write(`${JSON.stringify({ id: 1, method, params })}\n`);
    });
    client.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      settled = true;
      client.end();
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as { result?: unknown; error?: { message?: string } };
        if (message.error) reject(new Error(message.error.message || "rpc failed"));
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
  if (await socketListening(socketPath)) {
    throw new Error(`socket is already listening at ${socketPath}`);
  }
  await rm(socketPath, { force: true });
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
  options: { info: SocketServerInfo; context: Ctx; operations: readonly AnyOperation<Ctx>[] },
): Promise<void> {
  let message: { id?: unknown; method?: unknown; params?: unknown };
  try {
    message = JSON.parse(line) as { id?: unknown; method?: unknown; params?: unknown };
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
  options: { info: SocketServerInfo; context: Ctx; operations: readonly AnyOperation<Ctx>[] },
): Promise<unknown> {
  if (method === "tools/list") return describeServer(options);
  if (method === "tools/call") return callTool(params, options);
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
