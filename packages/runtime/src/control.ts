import { chmod, lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect } from "node:net";
import type {
  ChildId,
  ErrorResponse,
  RestartAdmission,
  StatusResponse,
} from "@agentstack/contracts";
import { CONTROL_SCHEMA, isChildId } from "@agentstack/contracts";
import { log } from "./log.js";

export interface ControlHandlers {
  status(): StatusResponse;
  restart(id: ChildId): Promise<void>;
}

export interface RoutedControlResponse {
  status: number;
  body: StatusResponse | ErrorResponse | RestartAdmission;
}

export interface ControlTransport {
  request<T>(method: "GET" | "POST", path: string): Promise<T>;
}

export async function routeControlRequest(
  method: string | undefined,
  path: string | undefined,
  handlers: ControlHandlers,
): Promise<RoutedControlResponse> {
  if (method === "GET" && path === "/v1/status") {
    return { status: 200, body: handlers.status() };
  }
  const match =
    method === "POST"
      ? /^\/v1\/children\/([^/]+)\/restart$/.exec(path ?? "")
      : null;
  if (match?.[1] && isChildId(match[1])) {
    const child = match[1];
    const requestId = randomUUID();
    void Promise.resolve()
      .then(async () => await handlers.restart(child))
      .catch(() => {
        log({
          level: "error",
          component: "control",
          event: "restart_failed",
          requestId,
          child,
        });
      });
    return {
      status: 202,
      body: {
        schema: CONTROL_SCHEMA,
        accepted: true,
        outcome: "admitted",
        child,
        requestId,
        next: "/v1/status",
      } satisfies RestartAdmission,
    };
  }
  return {
    status: 404,
    body: {
      schema: CONTROL_SCHEMA,
      error: { code: "not_found", message: "unknown control operation" },
    } satisfies ErrorResponse,
  };
}

async function socketResponds(path: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const client = connect(path);
    const done = (value: boolean): void => {
      client.destroy();
      resolve(value);
    };
    client.once("connect", () => done(true));
    client.once("error", () => done(false));
    setTimeout(() => done(false), 250).unref();
  });
}

async function prepareSocket(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isSocket())
      throw new Error("unsafe existing control path");
    if (typeof info.uid === "number" && info.uid !== process.getuid?.())
      throw new Error("foreign-owned control socket");
    if (await socketResponds(path))
      throw new Error("another AgentStack daemon is already listening");
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  let body = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(body) > 1024 * 1024) {
    status = 500;
    body = `${JSON.stringify({ schema: CONTROL_SCHEMA, error: { code: "response_too_large", message: "control response exceeded 1 MiB" } } satisfies ErrorResponse)}\n`;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    connection: "close",
  });
  res.end(body);
}

export async function startControlServer(
  path: string,
  handlers: ControlHandlers,
): Promise<Server> {
  await prepareSocket(path);
  const server = createServer((req, res) => {
    const requestId = randomUUID();
    void routeControlRequest(req.method, req.url, handlers).then((response) => {
      if (response.status === 404) {
        const method = /^[A-Z]{1,16}$/.test(req.method ?? "")
          ? req.method
          : "UNKNOWN";
        log({
          level: "warn",
          component: "control",
          event: "unknown_request",
          requestId,
          method,
        });
      }
      json(res, response.status, response.body);
    });
  });
  server.headersTimeout = 2_000;
  server.requestTimeout = 2_000;
  server.keepAliveTimeout = 500;
  server.maxRequestsPerSocket = 16;
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  await chmod(path, 0o600);
  return server;
}

export async function closeControlServer(
  server: Server,
  path: string,
): Promise<void> {
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  server.close(resolveClosed);
  server.closeIdleConnections();
  const closedGracefully = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), 500).unref(),
    ),
  ]);
  if (!closedGracefully) {
    server.closeAllConnections();
    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, 250).unref()),
    ]);
  }
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function controlRequest<T>(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const request = httpRequest(
      { socketPath, method, path, headers: { accept: "application/json" } },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) {
            request.destroy(new Error("control response exceeded 1 MiB"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const value = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as T;
            if ((response.statusCode ?? 500) >= 400)
              reject(
                Object.assign(new Error("control request failed"), {
                  response: value,
                }),
              );
            else resolve(value);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    request.setTimeout(2_000, () =>
      request.destroy(new Error("control request timed out")),
    );
    request.end();
  });
}

export class UnixSocketControlTransport implements ControlTransport {
  readonly #socketPath: string;

  constructor(socketPath: string) {
    this.#socketPath = socketPath;
  }

  async request<T>(method: "GET" | "POST", path: string): Promise<T> {
    return await controlRequest<T>(this.#socketPath, method, path);
  }
}
