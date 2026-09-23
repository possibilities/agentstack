import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
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

export function uiPageUrl(port: number, name: string): string {
  return `http://127.0.0.1:${port}/_ui/${name}`;
}

export type UiServer = {
  port: number;
  close(): Promise<void>;
};

export async function startUiServer(port = 0): Promise<UiServer> {
  const dir = fileURLToPath(new URL("../../web", import.meta.url));
  const app = next({ dev: true, dir, hostname: "127.0.0.1", port });
  await app.prepare();
  const handle = app.getRequestHandler();
  const http = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, "127.0.0.1", () => resolve());
  });
  const address = http.address();
  if (address === null || typeof address === "string") throw new Error("failed to listen");
  return {
    port: address.port,
    async close() {
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
      await app.close();
    },
  };
}
