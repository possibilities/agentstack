import { chmod, lstat, unlink } from "node:fs/promises";
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
  body: StatusResponse | ErrorResponse | Record<string, unknown>;
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
    try {
      await handlers.restart(match[1]);
      return {
        status: 200,
        body: { schema: CONTROL_SCHEMA, accepted: true, child: match[1] },
      };
    } catch {
      return {
        status: 500,
        body: {
          schema: CONTROL_SCHEMA,
          error: { code: "restart_failed", message: "child restart failed" },
        } satisfies ErrorResponse,
      };
    }
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
  const body = `${JSON.stringify(value)}\n`;
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
    const requestId = crypto.randomUUID();
    void routeControlRequest(req.method, req.url, handlers).then((response) => {
      if (response.status === 404) {
        log({
          level: "warn",
          component: "control",
          event: "unknown_request",
          requestId,
          method: req.method,
          path: req.url,
        });
      }
      json(res, response.status, response.body);
    });
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
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
