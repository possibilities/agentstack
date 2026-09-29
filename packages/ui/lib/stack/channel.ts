import type { ChannelStatus } from "./types";

type Pending = { channel: Channel; resolve(value: unknown): void; reject(error: Error): void };

export type ChannelOptions = {
  onStatus?(status: ChannelStatus): void;
  onOpen?(): void;
  onNotice?(topic: string): void;
  onError?(message: string): void;
};

const connections = new Map<string, Connection>();
let nextSubscription = 0;

/** One physical WebSocket per URL, shared by the package and scoped channels in this page. */
class Connection {
  readonly url: string;
  private ws: WebSocket | null = null;
  private channels = new Map<string, Channel>();
  private pending = new Map<number, Pending>();
  private seq = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;
  private generation = 0;
  status: ChannelStatus = "idle";

  constructor(url: string) { this.url = url; }

  add(channel: Channel): void {
    this.channels.set(channel.subscriptionId, channel);
    channel.statusChanged(this.status);
    // A late joiner must open after its caller has registered this logical
    // channel in its own store; otherwise the first snapshot cannot call it.
    if (this.status === "open") queueMicrotask(() => {
      if (this.status === "open" && this.channels.get(channel.subscriptionId) === channel) channel.opened();
    });
    else if (!this.ws && !this.timer && !this.connecting) void this.connect();
  }

  remove(channel: Channel): void {
    if (!this.channels.delete(channel.subscriptionId)) return;
    for (const [id, pending] of this.pending) {
      if (pending.channel !== channel) continue;
      this.pending.delete(id);
      pending.reject(new Error("connection closed"));
    }
    if (this.channels.size) {
      if (channel.subscribed && this.status === "open")
        void this.request(channel, "events/unsubscribe", { package: channel.pkg, subscription: channel.subscriptionId }).catch(() => undefined);
      return;
    }
    connections.delete(this.url);
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    // A connecting socket cannot close cleanly until the handshake finishes.
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
    else ws.close();
  }

  request(channel: Channel, method: string, params: Record<string, unknown>): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { channel, resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private async connect(): Promise<void> {
    if (!this.channels.size || this.connecting) return;
    this.connecting = true;
    const generation = ++this.generation;
    this.setStatus("connecting");
    let protocols: string[] = [];
    try {
      const target = new URL(this.url);
      if (target.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
        const response = await fetch("/connect/local/ticket", { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "content-type": "application/json" }, body: "{}" });
        if (!response.ok) throw new Error("Local session expired. Run agentstack open to reconnect.");
        const { ticket } = await response.json() as { ticket: string };
        if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error("Invalid WebSocket ticket");
        protocols = [`agentstack-local.${ticket}`];
      }
    } catch (error) {
      if (generation === this.generation && this.channels.size) {
        this.setStatus("closed");
        for (const channel of this.channels.values()) channel.error(error instanceof Error ? error.message : String(error));
        this.schedule();
      }
      return;
    } finally { this.connecting = false; }
    if (generation !== this.generation || !this.channels.size) return;
    const ws = new WebSocket(this.url, protocols);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      for (const channel of this.channels.values()) channel.opened();
    };
    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = () => {
      this.ws = null;
      for (const pending of this.pending.values()) pending.reject(new Error("connection closed"));
      this.pending.clear();
      this.setStatus("closed");
      if (this.channels.size) this.schedule();
    };
  }

  private receive(raw: string): void {
    let message: { id?: number | null; method?: string; params?: { package?: string; subscription?: string; topic?: string }; result?: unknown; error?: { message?: string } };
    try { message = JSON.parse(raw); } catch { return; }
    if (message.method === "events/changed" && message.params?.topic && message.params.subscription) {
      const channel = this.channels.get(message.params.subscription);
      if (channel && channel.pkg === message.params.package) channel.notice(message.params.topic);
    } else if (message.method === "events/disconnected" && message.params?.subscription) {
      const channel = this.channels.get(message.params.subscription);
      if (channel && channel.pkg === message.params.package) channel.disconnected();
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message ?? "request failed"));
      else pending?.resolve(message.result);
    } else if (message.error) {
      for (const channel of this.channels.values()) channel.error(message.error.message ?? "request failed");
    }
  }

  private schedule(): void {
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
    this.timer = setTimeout(() => { this.timer = null; void this.connect(); }, delay);
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    for (const channel of this.channels.values()) channel.statusChanged(status);
  }
}

/** Logical package channel; independent subscriptions share a single connection. */
export class Channel {
  readonly subscriptionId = `sub-${++nextSubscription}`;
  readonly url: string;
  readonly pkg: string;
  status: ChannelStatus = "idle";
  private options: ChannelOptions;
  private connection: Connection | null = null;
  private subscription: { topics: string[]; scope?: string } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(url: string, pkg: string, options: ChannelOptions = {}) {
    this.url = url;
    this.pkg = pkg;
    this.options = options;
  }

  get subscribed(): boolean { return this.subscription !== null; }

  connect(): this {
    if (this.disposed || this.connection) return this;
    let connection = connections.get(this.url);
    if (!connection) {
      connection = new Connection(this.url);
      connections.set(this.url, connection);
    }
    this.connection = connection;
    connection.add(this);
    return this;
  }

  subscribe(topics: string[], scope?: string): this {
    this.subscription = { topics, scope };
    this.sendSubscription();
    return this;
  }

  call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.connection
      ? this.connection.request(this, "tools/call", { package: this.pkg, name, arguments: args }) as Promise<T>
      : Promise.reject(new Error("not connected"));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.connection?.remove(this);
    this.connection = null;
  }

  statusChanged(status: ChannelStatus): void {
    if (status !== "open" && this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.status = status;
    this.options.onStatus?.(status);
  }

  opened(): void {
    this.sendSubscription();
    this.options.onOpen?.();
  }

  notice(topic: string): void { this.options.onNotice?.(topic); }
  error(message: string): void { this.options.onError?.(message); }

  disconnected(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.disposed) return;
      this.sendSubscription();
      this.options.onOpen?.();
    }, 1_000);
  }

  private sendSubscription(): void {
    if (!this.subscription || this.connection?.status !== "open") return;
    const { topics, scope } = this.subscription;
    void this.connection.request(this, "events/subscribe", { package: this.pkg, subscription: this.subscriptionId, topics,
      ...(scope === undefined ? {} : { scope }) }).catch((error: Error) => this.options.onError?.(error.message));
  }
}
