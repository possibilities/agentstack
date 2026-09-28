import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";

type Peer = { client: WebSocket; upstream: WebSocket; pending: Set<string> };
export type ManagedGate = Pick<BrowserGate, "start" | "close" | "hold" | "drain" | "resume" | "unknownDrain" | "grantHuman" | "revokeHuman" | "cdpUrl" | "observationUrl">;
const key = (frame: { id?: unknown; sessionId?: unknown }) => JSON.stringify([frame.sessionId ?? null, frame.id]);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Managed-path boundary, not a sandbox against direct guest network access.
 * CDP is decoded so a hold covers sockets opened before the hold, too.
 * Neko's data channel is fenced by explicit server-side host ownership.
 */
export class BrowserGate {
  private readonly server: Server;
  private readonly upgrades = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  private readonly peers = new Set<Peer>();
  private readonly viewers = new Set<Peer>();
  private held = true;
  private closed = false;
  private uncertain = false;
  private requests = 0;
  private human: string | null = null;
  private revoking = false;
  private viewEpoch = 0;
  private admin: { id: string; token: string } | null = null;
  private origin = "";
  private readonly viewerKey = randomBytes(24).toString("hex");

  constructor(private readonly cdp: string, private readonly neko: string, private readonly prefix: string) {
    this.server = createServer(async (request, response) => {
      try {
        if (!this.hostAllowed(request.headers.host)) { response.writeHead(403).end(); return; }
        const url = new URL(request.url!, "http://localhost");
        if (url.pathname.startsWith("/json")) {
          if (this.held || this.closed) { response.writeHead(423).end("browser is held"); return; }
          // Chrome's other HTTP endpoints can mutate the browser. Agent-browser
          // only needs discovery; actions travel through the decoded websocket.
          if (request.method !== "GET" || !["/json/version", "/json/list", "/json"].includes(url.pathname)) {
            response.writeHead(403).end(); return;
          }
          this.requests++;
          try {
            const source = await fetch(this.cdp + url.pathname, { signal: AbortSignal.timeout(5000), redirect: "error" });
            const body = (await source.text()).replaceAll(this.cdp.replace("http:", "ws:"), this.origin.replace("http:", "ws:"));
            response.writeHead(source.status, { "content-type": "application/json" }).end(body);
          } finally { this.requests--; }
          return;
        }
        const parts = url.pathname.split("/");
        const token = parts[1];
        if (!this.viewAllowed(token)) { response.writeHead(403).end(); return; }
        const path = "/" + parts.slice(2).join("/");
        // Serve the existing viewer assets only, never Neko's admin/API routes.
        if (request.method !== "GET" || !(path === "/" || /^\/(js|css|img|fonts)\/[a-zA-Z0-9_./-]+$/.test(path) || path === "/favicon.ico")) {
          response.writeHead(403).end(); return;
        }
        const source = await fetch(this.neko + path, { signal: AbortSignal.timeout(5000), redirect: "error" });
        let body = Buffer.from(await source.arrayBuffer());
        if (path === "/") {
          // A base path keeps the unmodified upstream viewer inside its grant.
          body = Buffer.from(body.toString().replaceAll('src="/', `src="/${token}/`).replaceAll('href="/', `href="/${token}/`).replace("<head>", `<head><base href="/${token}/">`));
        }
        response.writeHead(source.status, { "content-type": source.headers.get("content-type") ?? "application/octet-stream", "cache-control": "no-store", "referrer-policy": "no-referrer" }).end(body);
      } catch { if (!response.headersSent) response.writeHead(502); response.end(); }
    });
    this.server.on("upgrade", (request, socket, head) => {
      if (!this.hostAllowed(request.headers.host) || (request.headers.origin !== undefined && request.headers.origin !== this.origin)) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
      }
      void (async () => {
      const url = new URL(request.url!, "http://localhost");
      const parts = url.pathname.split("/");
      const agent = parts[1] === "devtools";
      const token = parts[1];
      const epoch = this.viewEpoch;
      if (!agent) {
        if (!this.viewAllowed(token)) { socket.destroy(); return; }
        if ((await this.api("/room/settings")).implicit_hosting !== false) throw new Error("Neko input policy changed");
      }
      if (this.closed || (agent ? this.held || !/^\/devtools\/(browser|page)\/[a-zA-Z0-9-]+$/.test(url.pathname) : epoch !== this.viewEpoch || !this.viewAllowed(token) || parts.slice(2).join("/") !== "ws")) {
        socket.end("HTTP/1.1 423 Locked\r\nConnection: close\r\n\r\n"); return;
      }
      this.upgrades.handleUpgrade(request, socket, head, (client) => {
        const endpoint = agent ? this.cdp.replace("http:", "ws:") + url.pathname : this.neko.replace("http:", "ws:") + `/ws?password=admin&username=${encodeURIComponent(this.prefix + ":" + randomBytes(12).toString("hex"))}`;
        const upstream = new WebSocket(endpoint, { maxPayload: 16 * 1024 * 1024 });
        const peer: Peer = { client, upstream, pending: new Set() };
        const peers = agent ? this.peers : this.viewers;
        peers.add(peer);
        const finish = () => {
          if (agent && peer.pending.size) this.uncertain = true;
          peers.delete(peer); client.terminate(); upstream.terminate();
        };
        client.on("error", finish); upstream.on("error", finish);
        client.on("close", finish); upstream.on("close", finish);
        let queued = 0;
        const forward = (raw: WebSocket.RawData, binary: boolean) => {
          if (upstream.readyState === WebSocket.CONNECTING && queued++ < 100) { upstream.once("open", () => forward(raw, binary)); return; }
          if (upstream.readyState !== WebSocket.OPEN || binary) { client.close(); return; }
          try {
            const frame = JSON.parse(raw.toString());
            if (agent) {
              // Nested CDP sessions would hide pending work behind an outer ack.
              if (this.held || frame.method === "Target.sendMessageToTarget") {
                client.send(JSON.stringify({ id: frame.id, sessionId: frame.sessionId, error: { code: -32000, message: "Managed browser held; reconnect and take a fresh snapshot after return" } })); return;
              }
              if (typeof frame.id !== "number" || peer.pending.has(key(frame))) { client.close(); return; }
              peer.pending.add(key(frame));
            } else {
              if (!this.viewAllowed(token)) { finish(); return; }
              const allowed = new Set(["client/heartbeat", "signal/offer", "signal/answer", "signal/candidate", "screen/resolution", "screen/configurations"]);
              // Use the image's configured keyboard layout. The legacy viewer
              // automatically sends control/keyboard on host acquisition; that
              // mutates guest-global XKB settings, not ordinary key input.
              if (token === this.human) for (const event of ["control/request", "admin/control", "control/release", "control/clipboard"]) allowed.add(event);
              if (!allowed.has(frame.event)) return;
              if (token === this.human && frame.event === "control/request") { upstream.send(JSON.stringify({ event: "admin/control" })); return; }
            }
            upstream.send(raw, { binary: false });
          } catch { client.close(); }
        };
        client.on("message", forward);
        upstream.on("message", (raw, binary) => {
          if (agent) {
            try { const frame = JSON.parse(raw.toString()); if (frame.id !== undefined) peer.pending.delete(key(frame)); } catch { this.uncertain = true; finish(); return; }
          } else if (token === this.human && this.viewAllowed(token)) {
            try { if (JSON.parse(raw.toString()).event === "system/init") upstream.send(JSON.stringify({ event: "admin/control" })); } catch { finish(); return; }
          }
          if (client.readyState === WebSocket.OPEN) client.send(raw, { binary });
        });
      });
      })().catch(() => socket.destroy());
    });
  }

  private viewAllowed(token: string | undefined): boolean { return !this.closed && !this.revoking && (token === this.viewerKey || (this.human !== null && token === this.human)); }
  private hostAllowed(host: string | undefined): boolean { return !!this.origin && host === new URL(this.origin).host; }
  get cdpUrl(): string { return this.origin; }
  get observationUrl(): string { return `${this.origin}/${this.viewerKey}/?readOnly=1`; }

  private async api(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<any> {
    const response = await fetch(this.neko + "/api" + path, { method, headers: { "content-type": "application/json", ...(this.admin ? { authorization: `Bearer ${this.admin.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000), redirect: "error" });
    if (!response.ok) throw new Error(`Neko ${method} ${path} failed (${response.status})`);
    const text = await response.text(); return text ? JSON.parse(text) : null;
  }

  async start(): Promise<void> {
    this.admin = await this.api("/login", { username: this.prefix + ":owner", password: "admin" });
    if (!this.admin?.id || !this.admin.token) throw new Error("Neko did not issue an admin session");
    // Required by the pinned legacy input handler. A proxy alone cannot fence
    // packets sent directly over an already negotiated WebRTC data channel.
    await this.api("/room/settings", { implicit_hosting: false });
    if ((await this.api("/room/settings")).implicit_hosting !== false) throw new Error("Neko explicit hosting was not confirmed");
    await this.revokeHuman();
    await new Promise<void>((resolve, reject) => { this.server.once("error", reject); this.server.listen(0, "127.0.0.1", resolve); });
    this.origin = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  hold(): void { this.held = true; }
  unknownDrain(): void { this.held = true; this.uncertain = true; }
  async drain(timeoutMs = 5000): Promise<void> {
    this.hold();
    const deadline = Date.now() + timeoutMs;
    while (this.requests || [...this.peers].some((p) => p.pending.size)) {
      if (Date.now() >= deadline) throw new Error("CDP drain deadline exceeded; profile remains held and human input is not granted");
      await delay(10);
    }
    if (this.uncertain) throw new Error("CDP connection was lost with pending work; quiescence is unknown and profile remains held");
    for (const peer of this.peers) { peer.client.terminate(); peer.upstream.terminate(); }
    this.peers.clear();
  }

  async grantHuman(): Promise<string> {
    await this.revokeHuman();
    this.human = randomBytes(24).toString("hex");
    return `${this.origin}/${this.human}/`;
  }

  async revokeHuman(): Promise<void> {
    this.revoking = true; this.viewEpoch++;
    try {
    this.human = null;
    for (const peer of this.viewers) { peer.client.terminate(); peer.upstream.terminate(); }
    this.viewers.clear();
    // Take host away BEFORE destroying sessions. On return the upstream DELETE
    // destroys WebRTC peers too; closing signaling alone is not sufficient.
    await this.api("/room/control/take", {});
    const sessions = await this.api("/sessions") as Array<{ id: string; profile: { name: string } }>;
    for (const session of sessions) if (session.id !== this.admin!.id && session.profile.name.startsWith(this.prefix + ":")) {
      try { await this.api(`/sessions/${encodeURIComponent(session.id)}`, undefined, "DELETE"); }
      catch (error) {
        // Closing legacy signaling logs out asynchronously. A concurrent logout
        // may win the DELETE; authoritative absence is the success condition.
        const current = await this.api("/sessions") as Array<{ id: string }>;
        if (current.some((s) => s.id === session.id)) throw error;
      }
    }
    const remaining = await this.api("/sessions") as Array<{ id: string; profile: { name: string } }>;
    if (remaining.some((s) => s.id !== this.admin!.id && s.profile.name.startsWith(this.prefix + ":"))) throw new Error("Neko managed input sessions were not revoked");
    } finally { this.revoking = false; }
  }

  resume(): void { if (this.uncertain) throw new Error("CDP quiescence is unknown"); this.held = false; }
  async close(): Promise<void> {
    this.closed = true; this.hold();
    for (const peer of [...this.peers, ...this.viewers]) { peer.client.terminate(); peer.upstream.terminate(); }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
