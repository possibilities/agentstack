import { loadCatalog } from "./catalog";
import { Channel } from "./channel";
import type { Account, Bot, BotSettings, ChannelStatus, Login, OwnerStatus, PackageDoc, Resource, Snapshot, StackEvent, VoiceCall, WorkerAccount, WorkerLogin, WorkerRuntime, WorkerSession } from "./types";

export type StackState = Snapshot & {
  /** Main channel status by Package API name. */
  status: Record<string, ChannelStatus>;
  /** Scoped event subscription status by bot id. */
  scoped: Record<string, { pkg: string; status: ChannelStatus }>;
  events: StackEvent[];
  /** Most recent sign-in attempt this page has seen, kept visible after it finishes. */
  attempt: Login | null;
  /** Latest Worker sign-in attempt per account, kept visible after it finishes until dismissed. */
  workerAttempts: Record<string, WorkerLogin>;
};

export type StackConnections = { packages?: readonly string[]; scopedBots?: boolean };

const authReads = new Set(["account_list", "account_login_current", "account_login_status", "worker_account_list", "worker_account_login_current", "worker_account_login_status"]);

function isLoginState(value: unknown): value is Login {
  return typeof value === "object" && value !== null && "status" in value && "authUrl" in value;
}

function isWorkerLoginState(value: unknown): value is WorkerLogin {
  return typeof value === "object" && value !== null && "status" in value && "account" in value && "provider" in value && "needsCode" in value;
}

type ResourceKey = "owner" | "accounts" | "workerAccounts" | "workerRuntimes" | "workerSessions" | "login" | "workerLogins" | "bots" | "botDefaults" | "voice" | "catalog";

const maxEvents = 250;

export class StackStore {
  private state: StackState;
  private listeners = new Set<() => void>();
  private main = new Map<string, Channel>();
  private scopedChannels = new Map<string, Channel>();
  private inflight = new Map<ResourceKey, Promise<void>>();
  private dirty = new Set<ResourceKey>();
  private seq = 0;
  private scopedBots = true;

  constructor(snapshot: Snapshot) {
    this.state = {
      ...snapshot, status: {}, scoped: {}, events: [], attempt: snapshot.login.data,
      workerAttempts: Object.fromEntries((snapshot.workerLogins.data ?? []).map((login) => [login.account, login])),
    };
  }

  getState = (): StackState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start({ packages, scopedBots = true }: StackConnections = {}): void {
    this.scopedBots = scopedBots;
    const { endpoints } = this.state;
    const enabled = packages && new Set(packages);
    const open = (pkg: string, onOpen: () => void, onNotice?: (topic: string) => void, topics?: string[]) => {
      if (enabled && !enabled.has(pkg)) return;
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
    open("auth", () => { this.refresh("accounts"); this.refresh("workerAccounts"); this.refresh("login"); this.refresh("workerLogins"); }, (topic) => {
      this.refresh("accounts");
      if (topic === "worker_accounts_changed") this.refresh("workerAccounts");
      if (topic === "login_changed") this.refresh("login");
      if (topic === "worker_login_changed") this.refresh("workerLogins");
    }, ["accounts_changed", "login_changed", "worker_accounts_changed", "worker_login_changed"]);
    open("bots", () => { this.refresh("bots"); this.refresh("botDefaults"); this.refresh("voice"); }, (topic) => {
      if (topic === "bots_changed") this.refresh("bots");
      if (topic === "defaults_changed") this.refresh("botDefaults");
      if (topic === "voice_changed") this.refresh("voice");
    }, ["bots_changed", "defaults_changed", "voice_changed"]);
    open("workers", () => { this.refresh("workerRuntimes"); this.refresh("workerSessions"); }, () => {
      this.refresh("workerRuntimes"); this.refresh("workerSessions");
    }, ["workers_changed"]);
    open("api", () => this.refresh("catalog"));
    this.reconcileScoped();
  }

  stop(): void {
    for (const channel of [...this.main.values(), ...this.scopedChannels.values()]) channel.dispose();
    this.main.clear();
    this.scopedChannels.clear();
  }

  /** Call any operation on a Package API's main channel. Auth mutations refresh accounts and sign-in state; voice calls refresh the call. */
  call = async <T>(pkg: string, name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const channel = this.main.get(pkg);
    if (!channel || channel.status !== "open") throw new Error(`${pkg} WebSocket is not connected`);
    const result = await channel.call<T>(name, args);
    if (pkg === "auth") {
      if (isWorkerLoginState(result)) this.set({ workerAttempts: { ...this.state.workerAttempts, [result.account]: result } });
      else if (isLoginState(result)) this.set({ attempt: result });
      if (!authReads.has(name)) {
        this.refresh("accounts");
        this.refresh("workerAccounts");
        this.refresh("login");
        this.refresh("workerLogins");
      }
    }
    if (pkg === "bots" && (name === "voice_dial" || name === "voice_hangup")) this.refresh("voice");
    return result;
  };

  dismissAttempt = (): void => this.set({ attempt: null });

  dismissWorkerAttempt = (accountId: string): void => {
    if (!this.state.workerAttempts[accountId]) return;
    const workerAttempts = { ...this.state.workerAttempts };
    delete workerAttempts[accountId];
    this.set({ workerAttempts });
  };

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
        if (key === "login") this.reconcileAttempt();
        if (key === "workerLogins") this.reconcileWorkerAttempts();
        if (key === "bots") this.reconcileScoped();
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
      case "workerAccounts": return call<{ accounts: WorkerAccount[] }>("auth", "worker_account_list").then((result) => result.accounts);
      case "workerRuntimes": return call<{ runtimes: WorkerRuntime[] }>("workers", "worker_runtime_list").then((result) => result.runtimes);
      case "workerSessions": return call<{ workers: WorkerSession[] }>("workers", "worker_list").then((result) => result.workers);
      case "login": return call<{ login: Login | null }>("auth", "account_login_current").then((result) => result.login);
      case "workerLogins": return call<{ logins: WorkerLogin[] }>("auth", "worker_account_login_current").then((result) => result.logins);
      case "bots": return call<{ bots: Bot[] }>("bots", "bot_list").then((result) => result.bots);
      case "botDefaults": return call<BotSettings>("bots", "bot_defaults_get");
      case "voice": return call<{ call: VoiceCall | null }>("bots", "voice_status").then((result) => result.call);
      case "catalog": return loadCatalog((name, args) => call<never>("api", name, args)) as Promise<PackageDoc[]>;
    }
  }

  /**
   * `account_login_current` only reports pending attempts, so once it returns
   * null a remembered pending attempt is resolved through `account_login_status`
   * to keep its outcome visible. Unknown sign-ins are dropped.
   */
  private reconcileAttempt(): void {
    const current = this.state.login.data;
    const attempt = this.state.attempt;
    if (current) {
      if (attempt?.id !== current.id || attempt.status === "pending") this.set({ attempt: current });
      return;
    }
    if (attempt?.status !== "pending") return;
    const id = attempt.id;
    void this.call<Login>("auth", "account_login_status", { id }).catch((error: Error) => {
      if (/unknown Codex sign-in/.test(error.message) && this.state.attempt?.id === id) this.set({ attempt: null });
    });
  }

  /**
   * `worker_account_login_current` only reports pending attempts, so a remembered
   * pending attempt missing from it is resolved through `worker_account_login_status`.
   * Unknown sign-ins are dropped.
   */
  private reconcileWorkerAttempts(): void {
    const current = this.state.workerLogins.data;
    if (!current) return;
    const merged = { ...this.state.workerAttempts };
    let changed = false;
    for (const login of current) {
      if (merged[login.account]?.id === login.id && merged[login.account]?.status !== "pending") continue;
      merged[login.account] = login;
      changed = true;
    }
    if (changed) this.set({ workerAttempts: merged });
    for (const attempt of Object.values(this.state.workerAttempts)) {
      if (attempt.status !== "pending" || current.some((login) => login.id === attempt.id)) continue;
      const accountId = attempt.account;
      void this.call<WorkerLogin>("auth", "worker_account_login_status", { id: attempt.id }).catch((error: Error) => {
        if (/unknown Worker sign-in/.test(error.message) && this.state.workerAttempts[accountId]?.id === attempt.id) this.dismissWorkerAttempt(accountId);
      });
    }
  }

  /** Keep one scoped subscription per bot; notices are not proof of sanctioned thread activity. */
  private reconcileScoped(): void {
    if (!this.scopedBots) return;
    const { bots, endpoints } = this.state;
    if (!bots.data) return;
    const wanted = new Map<string, { pkg: string; topics: string[] }>();
    for (const bot of bots.data) if (endpoints.bots) wanted.set(bot.id, { pkg: "bots", topics: ["bots_changed", "threads_changed", "chats_changed", "chat_queue_changed"] });
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
          }
        },
      });
      this.scopedChannels.set(id, channel);
      channel.subscribe(topics, id).connect();
    }
    this.set({ scoped });
  }
}
