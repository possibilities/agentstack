import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const defaultUiPort = 3000;

export function uiListenPort(env: NodeJS.ProcessEnv = process.env): number {
  if (env.PORT === undefined || env.PORT === "") return defaultUiPort;
  const port = Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid PORT: ${env.PORT}`);
  return port;
}

export function uiPageUrl(port: number, name: string): string {
  return `http://127.0.0.1:${port}/_ui/${name}`;
}

export type UiPage = {
  name: string;
  dir: string;
  data(request?: URL): Promise<unknown> | unknown;
};

const files: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/style.css": { name: "style.css", type: "text/css; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
};

export type UiServer = {
  port: number;
  close(): Promise<void>;
};

export async function startUiServer(pages: UiPage[], port = 0): Promise<UiServer> {
  const byName = new Map(pages.map((page) => [page.name, page]));
  const http = createServer((req, res) => {
    void route(req.url ?? "/", byName)
      .then((result) => {
        res.writeHead(result.status, result.headers).end(result.body);
      })
      .catch(() => {
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
    close() {
      http.closeAllConnections();
      return new Promise((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function route(rawUrl: string, pages: Map<string, UiPage>): Promise<{
  status: number;
  headers: Record<string, string>;
  body: string | Buffer;
}> {
  const url = new URL(rawUrl, "http://127.0.0.1");
  const match = url.pathname.match(/^\/_ui\/([^/]+)(\/.*)?$/);
  if (!match) return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  const name = match[1] ?? "";
  const page = pages.get(name);
  const rest = match[2];
  if (!page) return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  if (rest === undefined) {
    return {
      status: 302,
      headers: { location: `/_ui/${name}/` },
      body: "",
    };
  }
  if (rest === "/data") {
    const body = JSON.stringify(await Promise.resolve(page.data(url)));
    return { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" }, body };
  }
  const file = files[rest];
  if (!file) return { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  const body = await readFile(join(page.dir, file.name));
  return { status: 200, headers: { "content-type": file.type }, body };
}
