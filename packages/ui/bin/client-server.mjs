// Client-only Next ingress. Platform owners continue to use `next start`.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import next from "next";
import { admitClientIngress, clientSecurityHeaders, runtime } from "../lib/client/security.mjs";

if (runtime.mode !== "client" || !process.send) throw new Error("client_parent_required");
const app = next({ dev: false, dir: process.cwd(), hostname: "127.0.0.1", port: Number(new URL(runtime.origin).port) });
let ready = false;
const server = createServer(async (request, response) => {
  for (const [name, value] of Object.entries(clientSecurityHeaders)) response.setHeader(name, value);
  response.setHeader("content-security-policy", "default-src 'none'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  // Never accept duplicate authority fields or caller-controlled internal markers.
  const incoming = new Headers();
  for (let i = 0; i < request.rawHeaders.length; i += 2) incoming.append(request.rawHeaders[i], request.rawHeaders[i + 1]);
  try {
    const proof = admitClientIngress(incoming, request.method ?? "GET", request.url ?? "/");
    Object.assign(request.headers, proof);
  } catch { response.writeHead(403); response.end("Client authority refused."); return; }
  if (!ready) { response.writeHead(503); response.end(); return; }
  try { await app.getRequestHandler()(request, response); }
  catch { if (!response.headersSent) response.writeHead(500); response.end(); }
});
server.on("upgrade", (_request, socket) => socket.destroy());
server.on("error", error => { process.send?.({ error: error.code === "EADDRINUSE" ? "client_ui_port_busy" : "client_ui_start_failed" }); process.exitCode = 1; });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  ready = false;
  server.close(); server.closeAllConnections();
  await app.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("disconnect", () => void stop());
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port: Number(new URL(runtime.origin).port), exclusive: true }, resolve); });
  await app.prepare();
  ready = true;
  process.send({ ready: true, instance: randomBytes(16).toString("hex") });
} catch { process.send?.({ error: "client_ui_start_failed" }); await stop(); }
