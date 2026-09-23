import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

type NextApp = {
  prepare(): Promise<void>;
  getRequestHandler(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  close(): Promise<void>;
};

const require = createRequire(import.meta.url);
const next = require("next") as (options: {
  dev?: boolean;
  dir?: string;
  hostname?: string;
  port?: number;
}) => NextApp;

export const defaultUiPort = 3000;

export function uiListenPort(env: { PORT?: string } = process.env): number {
  if (env.PORT === undefined || env.PORT === "") return defaultUiPort;
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT: ${env.PORT}`);
  return port;
}

export function uiPageUrl(port: number, name: string, token?: string): string {
  const url = `http://127.0.0.1:${port}/_ui/${name}`;
  return token ? `${url}?token=${token}` : url;
}

export type UiServer = {
  port: number;
  token: string;
  close(): Promise<void>;
};

export async function startUiServer(port = 0): Promise<UiServer> {
  const dir = fileURLToPath(new URL("../../web", import.meta.url));
  const app = next({ dev: true, dir, hostname: "127.0.0.1", port });
  const token = randomBytes(32).toString("hex");
  let http: ReturnType<typeof createServer> | undefined;
  try {
    await app.prepare();
    const handle = app.getRequestHandler();
    let boundPort = port;
    http = createServer((req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (req.headers.host !== `127.0.0.1:${boundPort}`) {
        res.writeHead(421).end();
        return;
      }
      let requested: URL;
      try {
        requested = new URL(req.url ?? "/", `http://127.0.0.1:${boundPort}`);
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (requested.pathname.startsWith("/_ui/") && tokenMatches(requested.searchParams.get("token"), token)) {
        res.writeHead(302, {
          "Set-Cookie": `agentstack_ui=${token}; HttpOnly; SameSite=Strict; Path=/`,
          Location: requested.pathname,
        }).end();
        return;
      }
      const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("agentstack_ui="));
      if (!tokenMatches(cookie?.slice("agentstack_ui=".length), token)) {
        res.writeHead(401).end();
        return;
      }
      void handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve, reject) => {
      http!.once("error", reject);
      http!.listen(port, "127.0.0.1", () => {
        http!.off("error", reject);
        resolve();
      });
    });
    const address = http.address();
    if (address === null || typeof address === "string") throw new Error("failed to listen");
    boundPort = address.port;
    const serving = http;
    serving.prependListener("upgrade", (req, socket) => {
      const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("agentstack_ui="));
      if (req.headers.host !== `127.0.0.1:${boundPort}` || !tokenMatches(cookie?.slice("agentstack_ui=".length), token)) {
        socket.destroy();
      }
    });
    return {
      port: address.port,
      token,
      async close() {
        serving.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          serving.close((error) => (error ? reject(error) : resolve()));
        });
        await app.close();
      },
    };
  } catch (error) {
    http?.closeAllConnections();
    if (http?.listening) await new Promise<void>((resolve) => http!.close(() => resolve()));
    await app.close().catch(() => undefined);
    throw error;
  }
}

function tokenMatches(candidate: string | null | undefined, token: string): boolean {
  if (!candidate || !/^[0-9a-f]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
}
