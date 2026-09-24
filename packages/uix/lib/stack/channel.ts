import type { ChannelStatus } from "./types";

type Pending = { resolve(value: unknown): void; reject(error: Error): void };

export type ChannelOptions = {
  onStatus?(status: ChannelStatus): void;
  onOpen?(): void;
  onNotice?(topic: string): void;
  onError?(message: string): void;
};

/**
 * One WebSocket connection to a Package API. Forwards `tools/call`, holds at
 * most one event subscription, and reconnects with backoff. Each (re)open
 * resubscribes and calls `onOpen` so the owner can snapshot state again.
 */
export class Channel {
  readonly url: string;
  status: ChannelStatus = "idle";
  private options: ChannelOptions;
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private subscription: { topics: string[]; scope?: string } | null = null;

  constructor(url: string, options: ChannelOptions = {}) {
    this.url = url;
    this.options = options;
  }

  connect(): this {
    if (this.disposed || this.ws) return this;
    this.setStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      this.sendSubscription();
      this.options.onOpen?.();
    };
    ws.onmessage = (event) => this.receive(String(event.data));
    ws.onclose = () => {
      this.ws = null;
      for (const pending of this.pending.values()) pending.reject(new Error("connection closed"));
      this.pending.clear();
      this.setStatus("closed");
      if (!this.disposed) this.schedule();
    };
    return this;
  }

  subscribe(topics: string[], scope?: string): this {
    this.subscription = { topics, scope };
    this.sendSubscription();
    return this;
  }

  call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.request("tools/call", { name, arguments: args }) as Promise<T>;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onclose = null;
    ws.onmessage = null;
    for (const pending of this.pending.values()) pending.reject(new Error("connection closed"));
    this.pending.clear();
    // Closing a socket that is still connecting logs a browser warning; close it once it opens.
    if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
    else ws.close();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("not connected"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private sendSubscription(): void {
    if (!this.subscription || this.ws?.readyState !== WebSocket.OPEN) return;
    const { topics, scope } = this.subscription;
    this.request("events/subscribe", scope === undefined ? { topics } : { topics, scope })
      .catch((error: Error) => this.options.onError?.(error.message));
  }

  private receive(raw: string): void {
    let message: { id?: number | null; method?: string; params?: { topic?: string }; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.method === "events/changed" && message.params?.topic) {
      this.options.onNotice?.(message.params.topic);
    } else if (message.method === "events/disconnected") {
      this.timer = setTimeout(() => {
        this.sendSubscription();
        this.options.onOpen?.();
      }, 1_000);
    } else if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending?.reject(new Error(message.error.message ?? "request failed"));
      else pending?.resolve(message.result);
    } else if (message.error) {
      this.options.onError?.(message.error.message ?? "request failed");
    }
  }

  private schedule(): void {
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: ChannelStatus): void {
    this.status = status;
    this.options.onStatus?.(status);
  }
}
