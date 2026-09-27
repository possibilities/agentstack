import { connect } from "node:net";
import { type Duplex } from "node:stream";
import { createServer, request as httpRequest, type Server } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BrowserSystem } from "./system.js";

const IMAGE = "docker.io/onkernel/chromium-headful@sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3";
const MAX_SESSIONS = 16;
const namePattern = /^ast-[a-f0-9]{28}$/;
const targetSchema = z.strictObject({ name: z.string(), backend: z.literal("local") });
const nativeSchema = z.strictObject({ instanceName: z.string(), instanceId: z.string(), volumeName: z.string(), volumeId: z.string(), slot: z.number().int().nonnegative().max(999), ip: z.string() });
const recordSchema = z.strictObject({ version: z.literal(1), session: z.string(), profile: z.string(), persistent: z.literal(false),
  lease: z.string(), createdAt: z.string(), target: targetSchema.nullable(), native: nativeSchema.nullable(),
});
type NativeRecord = z.infer<typeof recordSchema>;
export type Receipt = Omit<NativeRecord, "native">;
export const cleanupSchema = z.strictObject({ session: z.string().regex(namePattern), lease: z.string().regex(/^[a-f0-9]{32}$/),
  backend: z.literal("local"), browserTarget: z.string().min(1), browserProfile: z.string().min(1),
});
export type Cleanup = z.infer<typeof cleanupSchema>;

export function backendSession(session: string): string {
  return `ast-${createHash("sha256").update(session).digest("hex").slice(0, 28)}`;
}

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Hypeman returned an invalid record");
  return value as Record<string, unknown>;
}
function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new Error("Hypeman returned an invalid inventory");
  return value.map(row);
}
function owned(value: Record<string, unknown>, session: string, lease: string, role: string): boolean {
  const tags = value.tags ? row(value.tags) : {};
  return tags["dev.agentstack.browser"] === "true" && tags["dev.agentstack.role"] === role &&
    tags["dev.agentstack.session"] === session && tags["dev.agentstack.lease"] === lease;
}
const tags = (session: string, lease: string, role: string) => ({
  "dev.agentstack.browser": "true", "dev.agentstack.role": role,
  "dev.agentstack.session": session, "dev.agentstack.lease": lease,
});

export class Backend {
  private queue = Promise.resolve();
  private readonly path: string;
  private readonly relays = new Map<string, { server: Server; port: number; sockets: Set<Duplex> }>();
  onChange?: () => void;

  constructor(private readonly system: BrowserSystem, private readonly testReady?: (port: number) => Promise<void>) { this.path = join(system.root, "sessions.json"); }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn, fn);
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async read(): Promise<NativeRecord[]> {
    try { return z.array(recordSchema).parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async save(rows: NativeRecord[]): Promise<void> {
    await mkdir(this.system.root, { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${randomUUID()}.tmp`;
    try { await writeFile(temp, `${JSON.stringify(rows)}\n`, { flag: "wx", mode: 0o600 }); await rename(temp, this.path); }
    finally { await rm(temp, { force: true }); }
    this.onChange?.();
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    await this.system.ensureRunning();
    const { baseUrl, token } = await this.system.connection();
    const response = await fetch(baseUrl + path, {
      method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Hypeman ${method} ${path.split("?")[0]} failed (HTTP ${response.status})`);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  async list(): Promise<Receipt[]> { return (await this.read()).map(({ native: _, ...receipt }) => receipt); }
  async get(session: string): Promise<Receipt | null> {
    return (await this.list()).find((item) => item.session === backendSession(session)) ?? null;
  }

  private async relay(session: string, ip: string): Promise<number> {
    const current = this.relays.get(session);
    if (current) return current.port;
    if (!(await this.system.guestSubnet())(ip)) throw new Error("Hypeman returned an address outside its local guest subnet");
    const sockets = new Set<Duplex>();
    const server = createServer((client, response) => {
      const upstream = httpRequest({ hostname: ip, port: 9222, method: client.method, path: client.url,
        headers: { ...client.headers, host: "127.0.0.1:9222", "accept-encoding": "identity" } }, async (source) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source) chunks.push(Buffer.from(chunk));
        let body = Buffer.concat(chunks);
        if (client.url?.startsWith("/json/") && source.headers["content-type"]?.includes("json")) {
          const port = (server.address() as { port: number }).port;
          body = Buffer.from(body.toString().replaceAll(`127.0.0.1:9222`, `127.0.0.1:${port}`).replaceAll(`${ip}:9222`, `127.0.0.1:${port}`));
        }
        const headers = { ...source.headers };
        delete headers["content-encoding"];
        delete headers["transfer-encoding"];
        response.writeHead(source.statusCode ?? 502, { ...headers, "content-length": body.length });
        response.end(body);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      client.pipe(upstream);
    });
    server.on("upgrade", (request, client, head) => {
      const remote = connect({ host: ip, port: 9222 });
      sockets.add(client); sockets.add(remote);
      client.once("close", () => sockets.delete(client));
      remote.once("close", () => sockets.delete(remote));
      remote.once("connect", () => {
        remote.write(`${request.method} ${request.url} HTTP/1.1\r\n${Object.entries({ ...request.headers, host: "127.0.0.1:9222" })
          .map(([key, value]) => `${key}: ${value}`).join("\r\n")}\r\n\r\n`);
        if (head.length) remote.write(head);
        client.pipe(remote).pipe(client);
      });
      client.on("error", () => remote.destroy());
      remote.on("error", () => client.destroy());
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("CDP relay did not bind a loopback port");
      this.relays.set(session, { server, port: address.port, sockets });
      return address.port;
    } catch (error) { server.close(); throw error; }
  }

  private async stopRelay(session: string): Promise<void> {
    const relay = this.relays.get(session);
    if (!relay) return;
    this.relays.delete(session);
    for (const socket of relay.sockets) socket.destroy();
    await new Promise<void>((resolve) => relay.server.close(() => resolve()));
  }

  private async ready(port: number): Promise<void> {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && typeof row(await response.json()).webSocketDebuggerUrl === "string") return;
        await response.body?.cancel();
      } catch { /* Guest starts asynchronously. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Kernel Chrome did not expose CDP before the provider deadline; session receipt retained");
  }

  private async provision(receipt: NativeRecord): Promise<NativeRecord> {
    const session = receipt.session;
    const lease = receipt.lease;
    const volumeName = `agentstack-profile-${session}-${lease.slice(0, 8)}`;
    const instanceName = `agentstack-browser-${session}-${lease.slice(0, 8)}`;
    const instances = records(await this.request("GET", "/instances"));
    const existing = instances.find((item) => item.name === instanceName);
    if (existing && !owned(existing, session, lease, "browser")) throw new Error("browser instance name is occupied by a foreign target");
    const volumes = records(await this.request("GET", "/volumes"));
    let volume = volumes.find((item) => item.name === volumeName);
    if (volume && !owned(volume, session, lease, "disposable-profile")) throw new Error("browser profile name is occupied by a foreign volume");
    if (!volume) {
      const resources = row(await this.request("GET", "/resources"));
      const available = row(resources.disk).available;
      if (typeof available !== "number" || available < 12 * 1024 ** 3) throw new Error("local Hypeman has insufficient disk capacity for a browser target");
      await this.request("POST", "/volumes", { name: volumeName, size_gb: 2, tags: tags(session, lease, "disposable-profile") });
      volume = records(await this.request("GET", "/volumes")).find((item) => item.name === volumeName);
    }
    if (!volume || typeof volume.id !== "string") throw new Error("Hypeman did not retain the new profile volume");
    const slotValue = existing ? row(existing.tags)["dev.agentstack.slot"] : undefined;
    const slot = typeof slotValue === "string" && /^(0|[1-9][0-9]{0,2})$/.test(slotValue) ? Number(slotValue) : receipt.native?.slot ?? this.firstFreeSlot(instances);
    let instance = existing;
    if (!instance) {
      const image = row(await this.request("GET", `/images/${encodeURIComponent(IMAGE)}`));
      if (image.status !== "ready") throw new Error("pinned Kernel image is not installed on local Hypeman");
      await this.request("POST", "/instances", {
        name: instanceName, image: IMAGE, platform: "linux/amd64", size: "3G", vcpus: 2,
        tags: { ...tags(session, lease, "browser"), "dev.agentstack.slot": String(slot) },
        env: { DISPLAY_NUM: "1", HEIGHT: "1080", WIDTH: "1920", RUN_AS_ROOT: "false", CHROMIUM_FLAGS: "--start-fullscreen --disable-infobars",
          ENABLE_WEBRTC: "true", NEKO_WEBRTC_UDPMUX: String(56000 + slot), NEKO_WEBRTC_NAT1TO1: "127.0.0.1" },
        volumes: [{ volume_id: volume.id, mount_path: "/home/kernel", readonly: false }],
        entrypoint: ["/bin/sh", "-c"],
        cmd: ["set -e; mkdir -p /home/kernel/user-data; chown kernel:kernel /home/kernel/user-data; rm -f /var/run/supervisor.sock /var/run/supervisord.pid /run/dbus/system_bus_socket /tmp/pulse/native; chown 0:0 /usr/bin/mount /opt/chrome-for-testing/chrome_sandbox; chmod 4755 /opt/chrome-for-testing/chrome_sandbox; ln -sfn chrome_sandbox /opt/chrome-for-testing/chrome-sandbox; export CHROME_DEVEL_SANDBOX=/opt/chrome-for-testing/chrome_sandbox; mountpoint -q /dev/shm || mount -t tmpfs -o mode=1777 tmpfs /dev/shm; exec /wrapper"],
        skip_kernel_headers: true,
      });
      instance = row(await this.request("GET", `/instances/${encodeURIComponent(instanceName)}`));
    }
    const deadline = Date.now() + 30_000;
    while (instance.state !== "Running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      instance = row(await this.request("GET", `/instances/${encodeURIComponent(instanceName)}`));
    }
    if (!owned(instance, session, lease, "browser") || typeof instance.id !== "string" || instance.state !== "Running") throw new Error("Hypeman browser instance is not running with the expected ownership");
    const network = row(instance.network);
    if (typeof network.ip !== "string") throw new Error("Hypeman browser has no guest address");
    const updated: NativeRecord = { ...receipt, target: { name: instanceName, backend: "local" },
      native: { instanceName, instanceId: instance.id, volumeName, volumeId: volume.id, slot, ip: network.ip } };
    return updated;
  }

  private firstFreeSlot(instances: Array<Record<string, unknown>>): number {
    const used = new Set(instances.map((item) => Number(item.tags ? row(item.tags)["dev.agentstack.slot"] : NaN)).filter((value) => Number.isInteger(value) && value >= 0));
    for (let slot = 0; slot < 1000; slot += 1) if (!used.has(slot)) return slot;
    throw new Error("local Hypeman has no free browser slots");
  }

  async launch(session: string): Promise<{ cdpUrl: string; cleanup: Cleanup }> {
    return this.serial(async () => {
      const name = backendSession(session);
      const all = await this.read();
      let current = all.find((item) => item.session === name);
      if (!current) {
        if (all.length >= MAX_SESSIONS) throw new Error("all disposable browser session slots are occupied");
        current = { version: 1, session: name, profile: name, persistent: false, lease: randomBytes(16).toString("hex"),
          createdAt: new Date().toISOString(), target: null, native: null };
        all.push(current);
        await this.save(all);
      }
      if (!current.native) {
        current = await this.provision(current);
        all[all.findIndex((item) => item.session === name)] = current;
        await this.save(all);
      }
      const native = current.native;
      if (!native) throw new Error("browser target was not provisioned");
      const instance = row(await this.request("GET", `/instances/${encodeURIComponent(native.instanceName)}`));
      if (instance.id !== native.instanceId || !owned(instance, name, current.lease, "browser")) throw new Error("browser target changed; refusing to attach to another incarnation");
      const port = await this.relay(name, native.ip);
      await (this.testReady ?? ((value) => this.ready(value)))(port);
      return { cdpUrl: `http://127.0.0.1:${port}`, cleanup: { session: name, lease: current.lease, backend: "local",
        browserTarget: native.instanceName, browserProfile: current.profile } };
    });
  }

  async close(cleanup: Cleanup): Promise<{ closed: true }> {
    return this.serial(async () => {
      const all = await this.read();
      const index = all.findIndex((item) => item.session === cleanup.session);
      if (index < 0) return { closed: true };
      const current = all[index]!;
      if (current.lease !== cleanup.lease || current.profile !== cleanup.browserProfile || current.target?.name !== cleanup.browserTarget)
        throw new Error("stale or mismatched browser cleanup receipt");
      if (!current.native) throw new Error("browser target creation is incomplete; inspect its durable reservation");
      const instance = await this.request("GET", `/instances/${encodeURIComponent(current.native.instanceName)}`);
      if (instance) {
        const target = row(instance);
        if (target.id !== current.native.instanceId || !owned(target, current.session, current.lease, "browser")) throw new Error("refusing to delete a changed or foreign browser target");
        await this.request("DELETE", `/instances/${encodeURIComponent(current.native.instanceId)}`);
      }
      const volume = records(await this.request("GET", "/volumes")).find((item) => item.id === current.native!.volumeId);
      if (volume) {
        if (!owned(volume, current.session, current.lease, "disposable-profile")) throw new Error("refusing to delete a changed or foreign browser profile");
        await this.request("DELETE", `/volumes/${encodeURIComponent(current.native.volumeId)}`);
      }
      await this.stopRelay(current.session);
      all.splice(index, 1);
      await this.save(all);
      return { closed: true };
    });
  }

  /** Recover a launch that failed after its durable reservation, before a cleanup receipt existed. */
  async reconcile(session: string, lease: string): Promise<{ closed: true }> {
    return this.serial(async () => {
      const all = await this.read();
      const index = all.findIndex((item) => item.session === session && item.lease === lease);
      if (index < 0) throw new Error("no matching browser reservation");
      const current = all[index]!;
      if (current.native || current.target) throw new Error("a launched browser requires its exact close receipt");
      const suffix = `${session}-${lease.slice(0, 8)}`;
      const instanceName = `agentstack-browser-${suffix}`;
      const volumeName = `agentstack-profile-${suffix}`;
      const instance = records(await this.request("GET", "/instances")).find((item) => item.name === instanceName);
      if (instance) {
        if (!owned(instance, session, lease, "browser") || typeof instance.id !== "string") throw new Error("refusing to reconcile a foreign browser target");
        await this.request("DELETE", `/instances/${encodeURIComponent(instance.id)}`);
      }
      const volume = records(await this.request("GET", "/volumes")).find((item) => item.name === volumeName);
      if (volume) {
        if (!owned(volume, session, lease, "disposable-profile") || typeof volume.id !== "string") throw new Error("refusing to reconcile a foreign profile volume");
        await this.request("DELETE", `/volumes/${encodeURIComponent(volume.id)}`);
      }
      all.splice(index, 1);
      await this.save(all);
      return { closed: true };
    });
  }

  async status(): Promise<{ provider: "hypeman"; mode: "disposable"; sessions: number }> {
    return { provider: "hypeman", mode: "disposable", sessions: (await this.read()).length };
  }

  async closeContext(): Promise<void> {
    await this.queue;
    await Promise.all([...this.relays.keys()].map((name) => this.stopRelay(name)));
  }
}
