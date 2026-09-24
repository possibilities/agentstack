import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { loadDocs } from "./catalog.js";
import { renderMarkdown, renderUnavailableMarkdown } from "./markdown.js";
import { renderDocs, renderUnavailable } from "./render.js";

export type DocsServer = { url: string; close(): Promise<void> };

const headers = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export async function serveDocs(options: { env?: NodeJS.ProcessEnv; port?: number; basePath?: "" | "/docs" } = {}): Promise<DocsServer> {
  const env = options.env ?? process.env;
  const port = options.port ?? 0;
  const basePath = options.basePath ?? "";
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("docs port must be an integer from 0 to 65535");
  const assets = join(import.meta.dirname, "..", "..", "public");
  const [css, js] = await Promise.all([readFile(join(assets, "site.css")), readFile(join(assets, "site.js"))]);
  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
      response.writeHead(403, headers).end();
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { ...headers, Allow: "GET" }).end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path === `${basePath}/site.css` || path === `${basePath}/site.js`) {
      response.writeHead(200, { ...headers, "Content-Type": path.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8" }).end(path.endsWith(".css") ? css : js);
      return;
    }
    const pagePath = basePath || "/";
    const markdownTarget = path.endsWith(".md") ? path.slice(0, -".md".length) : null;
    const isMarkdown = markdownTarget === pagePath || markdownTarget === `${basePath}/index`;
    if (path !== pagePath && path !== `${basePath}/revision` && !isMarkdown) {
      response.writeHead(404, headers).end();
      return;
    }
    try {
      const docs = await loadDocs(env);
      const revision = createHash("sha256").update(JSON.stringify(docs)).digest("hex");
      if (path === `${basePath}/revision`) {
        response.writeHead(200, { ...headers, "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify({ revision }));
      } else if (isMarkdown) {
        response.writeHead(200, { ...headers, "Cache-Control": "no-store", "Content-Type": "text/markdown; charset=utf-8" }).end(renderMarkdown(docs));
      } else {
        response.writeHead(200, {
          ...headers,
          "Cache-Control": "no-store",
          "Content-Type": "text/html; charset=utf-8",
          Link: `<${basePath}/index.md>; rel="alternate"; type="text/markdown"`,
        }).end(renderDocs(docs, revision, basePath));
      }
    } catch {
      const unavailable = path === `${basePath}/revision`
        ? ["application/json; charset=utf-8", JSON.stringify({ error: "Discovery API unavailable" })] as const
        : isMarkdown
          ? ["text/markdown; charset=utf-8", renderUnavailableMarkdown()] as const
          : ["text/html; charset=utf-8", renderUnavailable(basePath)] as const;
      response.writeHead(503, { ...headers, "Cache-Control": "no-store", "Content-Type": unavailable[0] }).end(unavailable[1]);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("docs server has no TCP address");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}${basePath || "/"}`,
    close() {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
