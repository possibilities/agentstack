import { connect } from "node:net";
import { type Duplex } from "node:stream";
import { createServer, request as httpRequest, type Server, type IncomingHttpHeaders } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { BrowserSystem } from "./system.js";
import { egressPolicy, type EgressPolicy } from "@stack/scrape/network";
import { researchFirewall, researchPolicyId } from "./research-egress.js";
import { stateHash, type StateOutcome } from "@stack/api";

const IMAGE = "docker.io/onkernel/chromium-headful@sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3";
const MAX_SESSIONS = 16;
const namePattern = /^ast-[a-f0-9]{28}$/;
const targetSchema = z.strictObject({ name: z.string(), backend: z.literal("local") });
const nativeSchema = z.strictObject({ instanceName: z.string(), instanceId: z.string(), volumeName: z.string(), volumeId: z.string(), slot: z.number().int().nonnegative().max(999), ip: z.string() });
const recordSchema = z.strictObject({ version: z.literal(1), session: z.string(), profile: z.string(), persistent: z.boolean(),
  lease: z.string(), createdAt: z.string(), target: targetSchema.nullable(), native: nativeSchema.nullable(),
  egress: egressPolicy.optional(),
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
  return tags["dev.stack.browser"] === "true" && tags["dev.stack.role"] === role &&
    tags["dev.stack.session"] === session && tags["dev.stack.lease"] === lease;
}
const tags = (session: string, lease: string, role: string) => ({
  "dev.stack.browser": "true", "dev.stack.role": role,
  "dev.stack.session": session, "dev.stack.lease": lease,
});

export class Backend {
  private queue = Promise.resolve();
  private draining = false;
  private maintenanceConnection: { baseUrl: string; token: string } | null = null;
  private readonly path: string;
  private readonly relays = new Map<string, { server: Server; port: number; sockets: Set<Duplex> }>();
  onChange?: () => void;
  onRecover?: (session: string) => Promise<void>;

  constructor(private readonly system: BrowserSystem, private readonly testReady?: (port: number) => Promise<void>) { this.path = join(system.root, "sessions.json"); }

  beginShutdown(): void { this.draining = true; }

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
    const { baseUrl, token } = this.maintenanceConnection ?? await this.system.connection();
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

  async stateProfile(session: string) {
    const name = backendSession(session), all = await this.read(), receipt = all.find(row => row.session === name) ?? null;
    const connection = this.maintenanceConnection ?? await this.system.connection();
    const instances = records(await this.request("GET", "/instances")), volumes = records(await this.request("GET", "/volumes"));
    const selectedInstances = instances.filter(row => receipt && owned(row, name, receipt.lease, "browser"));
    const selectedVolumes = volumes.filter(row => receipt && owned(row, name, receipt.lease, "durable-profile"));
    const blockedBy = !receipt?.persistent ? ["Exact durable profile receipt unavailable"] : [];
    const suffix = receipt && `${name}-${receipt.lease.slice(0, 8)}`;
    if (selectedInstances.some(row => typeof row.id !== "string" || row.name !== `stack-browser-${suffix}`)
      || selectedVolumes.some(row => typeof row.id !== "string" || row.name !== `stack-profile-${suffix}`)) blockedBy.push("Owned profile resource name/identity cannot be verified");
    if (selectedInstances.length > 1 || selectedVolumes.length !== 1) blockedBy.push("Profile has ambiguous or missing owned provider resources");
    if (selectedVolumes.some(volume => instances.some(instance => !selectedInstances.includes(instance) && Array.isArray(instance.volumes) && instance.volumes.some(mount => row(mount).volume_id === volume.id)))) blockedBy.push("Profile volume is mounted by another provider instance");
    if (receipt?.native && (!selectedInstances.some(row => row.id === receipt.native!.instanceId && row.name === receipt.native!.instanceName)
      || !selectedVolumes.some(row => row.id === receipt.native!.volumeId && row.name === receipt.native!.volumeName))) blockedBy.push("Native profile incarnation or volume changed/missing");
    return { revision: stateHash([this.system.selectedHypemanRoot(), connection, receipt, selectedInstances, selectedVolumes]), receipt, instances: selectedInstances, volumes: selectedVolumes, blockedBy };
  }

  async stateReset(session: string, expected: string, progress: (outcomes: StateOutcome[]) => void) {
    return this.serial(() => this.maintainProvider(async () => {
      const current = await this.stateProfile(session);
      if (current.revision !== expected || current.blockedBy.length || !current.receipt) throw new Error("Native profile changed or unavailable");
      const all = await this.read(), old = all.find(row => row.session === backendSession(session))!;
      const removed: StateOutcome[] = [];
      await this.removeNative(old, current.instances[0], current.volumes[0]!, resource => {
        removed.push({ resource, outcome: "removed", detail: "Exact old profile provider resource absent" });
        progress(removed);
      });
      const next: NativeRecord = { ...old, native: null, target: null, lease: randomBytes(16).toString("hex"), createdAt: new Date().toISOString() };
      all[all.findIndex(row => row.session === old.session)] = next; await this.save(all);
      const provisioned = await this.provision(next);
      all[all.findIndex(row => row.session === old.session)] = provisioned; await this.save(all);
      return provisioned;
    }));
  }

  async stateVolumes() {
    const ledger = await this.read(), instances = records(await this.request("GET", "/instances"));
    const providerRevision = stateHash([this.system.selectedHypemanRoot(), this.maintenanceConnection ?? await this.system.connection()]);
    const volumes = records(await this.request("GET", "/volumes")).filter(row => {
      const tag = row.tags && typeof row.tags === "object" ? row.tags as Record<string, string> : {};
      const session = tag["dev.stack.session"], lease = tag["dev.stack.lease"], kind = tag["dev.stack.role"];
      return typeof row.id === "string" && typeof session === "string" && namePattern.test(session) && typeof lease === "string" && /^[a-f0-9]{32}$/.test(lease)
        && ["durable-profile", "disposable-profile"].includes(kind!) && row.name === `stack-profile-${session}-${lease.slice(0, 8)}` && owned(row, session, lease, kind!);
    }).map((row): Record<string, unknown> & { id: string; blockedBy: string[] } => ({ ...row, id: String(row.id), providerRevision, blockedBy: [
      ...(ledger.some(receipt => receipt.native?.volumeId === row.id || row.name === `stack-profile-${receipt.session}-${receipt.lease.slice(0, 8)}`) ? ["Volume is referenced by a Browser session receipt (including incomplete/disposable leases)"] : []),
      ...(instances.some(instance => Array.isArray(instance.volumes) && instance.volumes.some(mount => (mount as Record<string, unknown>).volume_id === row.id)) ? ["Volume is mounted by a provider instance"] : []),
    ] }));
    volumes.sort((a, b) => a.id.localeCompare(b.id));
    return { revision: stateHash([this.system.selectedHypemanRoot(), ledger, volumes]), volumes };
  }

  async stateCollectVolume(id: string, expected: string) {
    return this.serial(() => this.maintainProvider(async () => {
      const current = await this.stateVolumes(), volume = current.volumes.find(row => row.id === id);
      if (!volume || stateHash(volume) !== expected || volume.blockedBy.length) throw new Error("Exact orphan volume changed, occupied or unavailable");
      await this.request("DELETE", `/volumes/${encodeURIComponent(id)}`);
      if (records(await this.request("GET", "/volumes")).some(row => row.id === id)) throw new Error("Provider did not verify exact volume absence");
    }));
  }

  private maintainProvider<T>(run: () => Promise<T>): Promise<T> {
    return this.system.maintainProvider(async () => {
      if (this.draining) throw new Error("Browser provider is shutting down");
      this.maintenanceConnection = await this.system.connection();
      try { return await run(); } finally { this.maintenanceConnection = null; }
    });
  }

  private async removeNative(receipt: NativeRecord, expectedInstance: Record<string, unknown> | undefined, expectedVolume: Record<string, unknown>, removed: (id: string) => void) {
    const instances = records(await this.request("GET", "/instances")), volumes = records(await this.request("GET", "/volumes"));
    const instance = expectedInstance && instances.find(item => item.id === expectedInstance.id);
    const volume = volumes.find(item => item.id === expectedVolume.id);
    if (instance && (!owned(instance, receipt.session, receipt.lease, "browser") || instance.name !== expectedInstance!.name)) throw new Error("Refusing changed or foreign profile instance");
    if (volume && (!owned(volume, receipt.session, receipt.lease, "durable-profile") || volume.name !== expectedVolume.name)) throw new Error("Refusing changed or foreign profile volume");
    if (volume && instances.some(item => item !== instance && Array.isArray(item.volumes) && item.volumes.some(mount => row(mount).volume_id === volume.id))) throw new Error("Profile volume is mounted by another instance");
    if (instance) await this.request("DELETE", `/instances/${encodeURIComponent(String(instance.id))}`);
    if (instance && records(await this.request("GET", "/instances")).some(item => item.id === instance.id)) throw new Error("Profile instance absence not verified");
    if (expectedInstance) removed(String(expectedInstance.id));
    if (volume) await this.request("DELETE", `/volumes/${encodeURIComponent(String(volume.id))}`);
    if (volume && records(await this.request("GET", "/volumes")).some(item => item.id === volume.id)) throw new Error("Profile volume absence not verified");
    removed(String(expectedVolume.id));
    await this.stopRelay(receipt.session);
  }
  async get(session: string): Promise<Receipt | null> {
    return (await this.list()).find((item) => item.session === backendSession(session)) ?? null;
  }

  private async relay(session: string, ip: string): Promise<number> {
    const current = this.relays.get(session);
    if (current) return current.port;
    if (!(await this.system.guestSubnet())(ip)) throw new Error("Hypeman returned an address outside its local guest subnet");
    const sockets = new Set<Duplex>();
    const allowed = (headers: IncomingHttpHeaders) => {
      const address = server.address();
      const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : null;
      return host !== null && headers.host === host && (headers.origin === undefined || headers.origin === `http://${host}`);
    };
    const server = createServer((client, response) => {
      if (!allowed(client.headers)) { response.writeHead(403).end(); return; }
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
      if (!allowed(request.headers)) { client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return; }
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
      if (this.draining) throw new Error("browser is shutting down");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
        if (response.ok && typeof row(await response.json()).webSocketDebuggerUrl === "string") return;
        await response.body?.cancel();
      } catch { /* Guest starts asynchronously. */ }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error("Kernel Chrome did not expose CDP within 35 seconds; receipt retained. Kernel supervises Chrome; Stack does not force-reboot a Running VM with unflushed profile data");
  }

  private async provision(receipt: NativeRecord): Promise<NativeRecord> {
    const session = receipt.session;
    const lease = receipt.lease;
    const volumeName = `stack-profile-${session}-${lease.slice(0, 8)}`;
    const instanceName = `stack-browser-${session}-${lease.slice(0, 8)}`;
    const instances = records(await this.request("GET", "/instances"));
    const existing = instances.find((item) => item.name === instanceName);
    if (existing && !owned(existing, session, lease, "browser")) throw new Error("browser instance name is occupied by a foreign target");
    const volumes = records(await this.request("GET", "/volumes"));
    let volume = volumes.find((item) => item.name === volumeName);
    const profileRole = receipt.persistent ? "durable-profile" : "disposable-profile";
    if (volume && !owned(volume, session, lease, profileRole)) throw new Error("browser profile name is occupied by a foreign volume");
    if (!volume) {
      const resources = row(await this.request("GET", "/resources"));
      const available = row(resources.disk).available;
      if (typeof available !== "number" || available < 12 * 1024 ** 3) throw new Error("local Hypeman has insufficient disk capacity for a browser target");
      await this.request("POST", "/volumes", { name: volumeName, size_gb: 2, tags: tags(session, lease, profileRole) });
      volume = records(await this.request("GET", "/volumes")).find((item) => item.name === volumeName);
    }
    if (!volume || typeof volume.id !== "string") throw new Error("Hypeman did not retain the new profile volume");
    const slotValue = existing ? row(existing.tags)["dev.stack.slot"] : undefined;
    const slot = typeof slotValue === "string" && /^(0|[1-9][0-9]{0,2})$/.test(slotValue) ? Number(slotValue) : receipt.native?.slot ?? this.firstFreeSlot(instances);
    let instance = existing;
    if (!instance) {
      const image = row(await this.request("GET", `/images/${encodeURIComponent(IMAGE)}`));
      if (image.status !== "ready") throw new Error("pinned Kernel image is not installed on local Hypeman");
      await this.request("POST", "/instances", {
        name: instanceName, image: IMAGE, platform: "linux/amd64", size: "3G", vcpus: 2,
        tags: { ...tags(session, lease, "browser"), "dev.stack.slot": String(slot),
          ...(receipt.egress ? { "dev.stack.egress": researchPolicyId(receipt.egress) } : {}) },
        env: { DISPLAY_NUM: "1", HEIGHT: "1080", WIDTH: "1920", RUN_AS_ROOT: "false", CHROMIUM_FLAGS: `--start-fullscreen --disable-infobars${receipt.egress ? " --disable-quic --force-webrtc-ip-handling-policy=disable_non_proxied_udp" : ""}`,
          ENABLE_WEBRTC: receipt.egress ? "false" : "true", NEKO_WEBRTC_UDPMUX: String(56000 + slot) },
        volumes: [{ volume_id: volume.id, mount_path: "/home/kernel", readonly: false }],
        entrypoint: ["/bin/sh", "-c"],
        cmd: [`set -e; ${receipt.egress ? `${researchFirewall(receipt.egress)}; printf 'nameserver 1.1.1.1\\n' > /etc/resolv.conf; ( sleep 300; iptables -F OUTPUT; ip6tables -F OUTPUT ) >/dev/null 2>&1 & ` : ""}mkdir -p /home/kernel/user-data; chown kernel:kernel /home/kernel/user-data; rm -f /var/run/supervisor.sock /var/run/supervisord.pid /run/dbus/system_bus_socket /tmp/pulse/native; chown 0:0 /usr/bin/mount /opt/chrome-for-testing/chrome_sandbox; chmod 4755 /opt/chrome-for-testing/chrome_sandbox; ln -sfn chrome_sandbox /opt/chrome-for-testing/chrome-sandbox; export CHROME_DEVEL_SANDBOX=/opt/chrome-for-testing/chrome_sandbox; export NEKO_WEBRTC_NAT1TO1=$(hostname -I | awk '{print $1}'); mountpoint -q /dev/shm || mount -t tmpfs -o mode=1777 tmpfs /dev/shm; exec /wrapper`],
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
    const used = new Set(instances.map((item) => Number(item.tags ? row(item.tags)["dev.stack.slot"] : NaN)).filter((value) => Number.isInteger(value) && value >= 0));
    for (let slot = 0; slot < 1000; slot += 1) if (!used.has(slot)) return slot;
    throw new Error("local Hypeman has no free browser slots");
  }

  async launch(session: string, persistent = false, egress?: EgressPolicy): Promise<{ cdpUrl: string; cleanup: Cleanup }> {
    return this.serial(async () => {
      if (this.draining) throw new Error("browser is shutting down");
      const name = backendSession(session);
      const all = await this.read();
      let current = all.find((item) => item.session === name);
      if (egress && persistent) throw new Error("research browser must be disposable");
      if (current && JSON.stringify(current.egress) !== JSON.stringify(egress)) throw new Error("browser egress policy mismatch");
      if (current?.egress && Date.now() - Date.parse(current.createdAt) >= 240_000) throw new Error("research browser lease expired");
      if (!current) {
        if (all.length >= MAX_SESSIONS) throw new Error("all disposable browser session slots are occupied");
        current = { version: 1, session: name, profile: name, persistent, lease: randomBytes(16).toString("hex"),
          createdAt: new Date().toISOString(), target: null, native: null, ...(egress ? { egress: egressPolicy.parse(egress) } : {}) };
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
      const observed = await this.request("GET", `/instances/${encodeURIComponent(native.instanceName)}`);
      if (!observed) throw new Error("recorded browser VM is missing; automatic replacement is disabled and the profile volume receipt is retained for operator recovery");
      let instance = row(observed);
      if (instance.id !== native.instanceId || !owned(instance, name, current.lease, "browser")) throw new Error("browser target changed; refusing to attach to another incarnation");
      if (current.egress && row(instance.tags)["dev.stack.egress"] !== researchPolicyId(current.egress)) throw new Error("browser_egress_unverifiable");
      const volume = records(await this.request("GET", "/volumes")).find((item) => item.id === native.volumeId);
      if (!volume || volume.name !== native.volumeName || !owned(volume, name, current.lease, current.persistent ? "durable-profile" : "disposable-profile")) throw new Error("browser profile changed; refusing to attach to another volume");
      if (persistent && instance.state === "Stopped") {
        await this.onRecover?.(name);
        await this.request("POST", `/instances/${encodeURIComponent(native.instanceId)}/start`, {});
        instance = row(await this.request("GET", `/instances/${encodeURIComponent(native.instanceName)}`));
      }
      const deadline = Date.now() + 30_000;
      while (["Initializing", "Starting"].includes(String(instance.state)) && Date.now() < deadline) {
        await this.onRecover?.(name);
        await new Promise((resolve) => setTimeout(resolve, 500));
        instance = row(await this.request("GET", `/instances/${encodeURIComponent(native.instanceName)}`));
      }
      if (instance.id !== native.instanceId || !owned(instance, name, current.lease, "browser")) throw new Error("browser target changed during restart");
      if (instance.state !== "Running") throw new Error("browser instance is not running");
      if (!Array.isArray(instance.volumes) || !instance.volumes.some((mount: unknown) => row(mount).volume_id === native.volumeId && row(mount).mount_path === "/home/kernel" && row(mount).readonly === false)) throw new Error("browser profile mount changed");
      const ip = row(instance.network).ip;
      if (typeof ip !== "string") throw new Error("browser instance has no guest address");
      if (ip !== native.ip) {
        await this.stopRelay(name);
        native.ip = ip;
        await this.save(all);
      }
      const port = await this.relay(name, ip);
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
        if (!owned(volume, current.session, current.lease, current.persistent ? "durable-profile" : "disposable-profile")) throw new Error("refusing to delete a changed or foreign browser profile");
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
      const instanceName = `stack-browser-${suffix}`;
      const volumeName = `stack-profile-${suffix}`;
      const instance = records(await this.request("GET", "/instances")).find((item) => item.name === instanceName);
      if (instance) {
        if (!owned(instance, session, lease, "browser") || typeof instance.id !== "string") throw new Error("refusing to reconcile a foreign browser target");
        await this.request("DELETE", `/instances/${encodeURIComponent(instance.id)}`);
      }
      const volume = records(await this.request("GET", "/volumes")).find((item) => item.name === volumeName);
      if (volume) {
        if (!owned(volume, session, lease, current.persistent ? "durable-profile" : "disposable-profile") || typeof volume.id !== "string") throw new Error("refusing to reconcile a foreign profile volume");
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

  async observation(session: string): Promise<{ url: string; udpPort: number } | null> {
    const current = (await this.read()).find((item) => item.session === backendSession(session));
    if (!current?.native) return null;
    return { url: `http://${current.native.ip}:8080/?readOnly=1`, udpPort: 56000 + current.native.slot };
  }

  /** Planned shutdown preserves volumes and stops only exact, owned instances. */
  async suspend(session: string): Promise<void> {
    await this.queue;
      const current = (await this.read()).find((item) => item.session === backendSession(session));
      if (!current?.native || !current.persistent) return;
      const native = current.native;
      const instance = row(await this.request("GET", `/instances/${encodeURIComponent(native.instanceName)}`));
      if (instance.id !== native.instanceId || !owned(instance, current.session, current.lease, "browser")) throw new Error("refusing to stop a changed browser incarnation");
      const volume = records(await this.request("GET", "/volumes")).find((item) => item.id === native.volumeId);
      if (!volume || !owned(volume, current.session, current.lease, "durable-profile") || !Array.isArray(instance.volumes) || !instance.volumes.some((mount: unknown) => row(mount).volume_id === native.volumeId && row(mount).mount_path === "/home/kernel" && row(mount).readonly === false)) throw new Error("refusing to stop a browser with a changed profile volume");
      if (instance.state === "Stopped") return;
      if (instance.state !== "Running") throw new Error("browser cannot be cleanly stopped in its current state");
      const ip = row(instance.network).ip;
      if (typeof ip !== "string" || !(await this.system.guestSubnet())(ip)) throw new Error("invalid guest address at shutdown");
      await this.stopRelay(current.session);
      const port = await this.relay(current.session, ip);
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
      const url = row(await response.json()).webSocketDebuggerUrl;
      if (!response.ok || typeof url !== "string") throw new Error("cannot cleanly close Chrome; VM left running");
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        let sent = false;
        const timer = setTimeout(() => { socket.close(); reject(new Error("Chrome close timed out; VM left running")); }, 10_000);
        const done = (error?: Error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(); };
        socket.onopen = () => { sent = true; socket.send(JSON.stringify({ id: 1, method: "Browser.close" })); };
        socket.onmessage = (event) => { const message = JSON.parse(String(event.data)); if (message.id === 1) done(message.error ? new Error("Chrome refused clean close") : undefined); };
        socket.onclose = () => done(sent ? undefined : new Error("Chrome disconnected before close"));
        socket.onerror = () => done(new Error("Chrome close connection failed"));
      });
      // Chrome flushes profile databases during orderly exit. Give its child
      // processes time to drain before asking Hypeman to stop the guest.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await this.request("POST", `/instances/${encodeURIComponent(native.instanceId)}/stop`, {});
      await this.stopRelay(current.session);
  }

  async closeContext(): Promise<void> {
    await this.queue;
    await Promise.all([...this.relays.keys()].map((name) => this.stopRelay(name)));
  }
}
