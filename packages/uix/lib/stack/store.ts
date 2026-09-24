import { loadCatalog } from "./catalog";
import { Channel } from "./channel";
import type { Account, ChannelStatus, Login, OwnerStatus, PackageDoc, Resource, Server, Snapshot, StackEvent } from "./types";

export type StackState = Snapshot & {
  /** Main channel status by Package API name. */
  status: Record<string, ChannelStatus>;
  /** Scoped event subscription status by Server id. */
  scoped: Record<string, { pkg: string; status: ChannelStatus }>;
  events: StackEvent[];
};

type ResourceKey = "owner" | "accounts" | "login" | "servers" | "bots" | "catalog";

const maxEvents = 250;

export class StackStore {
  private state: StackState;
  private listeners = new Set<() => void>();
  private main = new Map<string, Channel>();
  private scopedChannels = new Map<string, Channel>();
  private inflight = new Map<ResourceKey, Promise<void>>();
  private dirty = new Set<ResourceKey>();
  private seq = 0;

  constructor(snapshot: Snapshot) {
    this.state = { ...snapshot, status: {}, scoped: {}, events: [] };
  }

  getState = (): StackState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start(): void {
    const { endpoints } = this.state;
    const open = (pkg: string, onOpen: () => void, onNotice?: (topic: string) => void, topics?: string[]) => {
      const url = endpoints[pkg];
      if (!url) return;
      const channel = new Channel(url, {
        onStatus: (status) => this.set({ status: { ...this.state.status, [pkg]: status } }),
        onOpen,
        onNotice: (topic) => {
          this.log(pkg, topic, null);
          onNotice?.(topic);
        },
      });
      if (topics) channel.subscribe(topics);
      this.main.set(pkg, channel.connect());
    };
    open("owner", () => this.refresh("owner"), () => this.refresh("owner"), ["pids_changed"]);
    open("auth", () => { this.refresh("accounts"); this.refresh("login"); }, (topic) => {
      this.refresh("accounts");
      if (topic === "login_changed") this.refresh("login");
    }, ["accounts_changed", "login_changed"]);
    open("codex", () => this.refresh("servers"), () => { this.refresh("servers"); this.refresh("bots"); }, ["servers_changed"]);
    open("bots", () => this.refresh("bots"));
    open("api", () => this.refresh("catalog"));
    this.reconcileScoped();
  }

  stop(): void {
    for (const channel of [...this.main.values(), ...this.scopedChannels.values()]) channel.dispose();
    this.main.clear();
    this.scopedChannels.clear();
  }

  private set(patch: Partial<StackState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private log(pkg: string, topic: string, scope: string | null): void {
    const event: StackEvent = { seq: ++this.seq, at: Date.now(), pkg, topic, scope };
    this.set({ events: [event, ...this.state.events].slice(0, maxEvents) });
  }

  private refresh(key: ResourceKey): void {
    if (this.inflight.has(key)) {
      this.dirty.add(key);
      return;
    }
    const run = this.load(key)
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state[key].data, error: error.message, at: Date.now() }))
      .then((next) => {
        this.set({ [key]: next } as Partial<StackState>);
        if (key === "servers" || key === "bots") this.reconcileScoped();
      })
      .finally(() => {
        this.inflight.delete(key);
        if (this.dirty.delete(key)) this.refresh(key);
      });
    this.inflight.set(key, run);
  }

  private load(key: ResourceKey): Promise<Resource<unknown>["data"]> {
    const call = <T>(pkg: string, name: string, args?: Record<string, unknown>) => {
      const channel = this.main.get(pkg);
      return channel ? channel.call<T>(name, args) : Promise.reject(new Error(`${pkg} WebSocket is not configured`));
    };
    switch (key) {
      case "owner": return call<OwnerStatus>("owner", "owner_status");
      case "accounts": return call<{ accounts: Account[] }>("auth", "account_list").then((result) => result.accounts);
      case "login": return call<{ login: Login | null }>("auth", "account_login_current").then((result) => result.login);
      case "servers": return call<{ servers: Server[] }>("codex", "server_list").then((result) => result.servers);
      case "bots": return call<{ bots: Server[] }>("bots", "bot_list").then((result) => result.bots);
      case "catalog": return loadCatalog((name, args) => call<never>("api", name, args)) as Promise<PackageDoc[]>;
    }
  }

  /** Keep one scoped subscription per Server so thread activity is attributed to it. */
  private reconcileScoped(): void {
    const { servers, bots, endpoints } = this.state;
    if (!servers.data) return;
    const botIds = new Set(bots.data?.map((bot) => bot.id) ?? []);
    const wanted = new Map<string, { pkg: string; topics: string[] }>();
    for (const server of servers.data) {
      if (botIds.has(server.id) && endpoints.bots) wanted.set(server.id, { pkg: "bots", topics: ["bots_changed", "threads_changed"] });
      else if (endpoints.codex) wanted.set(server.id, { pkg: "codex", topics: ["threads_changed"] });
    }
    for (const bot of bots.data ?? []) {
      if (!wanted.has(bot.id) && endpoints.bots) wanted.set(bot.id, { pkg: "bots", topics: ["bots_changed", "threads_changed"] });
    }
    const scoped = { ...this.state.scoped };
    for (const [id, channel] of this.scopedChannels) {
      if (wanted.get(id)?.pkg === scoped[id]?.pkg) continue;
      channel.dispose();
      this.scopedChannels.delete(id);
      delete scoped[id];
    }
    for (const [id, { pkg, topics }] of wanted) {
      if (this.scopedChannels.has(id)) continue;
      scoped[id] = { pkg, status: "idle" };
      const channel = new Channel(endpoints[pkg], {
        onStatus: (status) => {
          if (this.scopedChannels.get(id) !== channel) return;
          this.set({ scoped: { ...this.state.scoped, [id]: { pkg, status } } });
        },
        onNotice: (topic) => {
          this.log(pkg, topic, id);
          if (topic === "bots_changed") {
            this.refresh("bots");
            this.refresh("servers");
          }
        },
      });
      this.scopedChannels.set(id, channel);
      channel.subscribe(topics, id).connect();
    }
    this.set({ scoped });
  }
}
