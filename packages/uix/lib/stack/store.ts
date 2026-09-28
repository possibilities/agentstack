import { loadCatalog } from "./catalog";
import type { AccessSnapshot } from "./types";
import { Channel } from "./channel";
import { loadResources, mergeHistory } from "./resources";
import type { Account, Bot, BotSettings, ChannelStatus, InferModelObservation, InferRequestSummary, Login, Notification, NotificationCounts, NotificationFilter, NotificationPages, OwnerResources, OwnerStatus, PackageDoc, Resource, ResourceHistoryPage, ResourceHistoryPoint, RoleLaunchPreview, RolePreview, RoleSnapshot, Snapshot, StackEvent, UsageSnapshot, VoiceCall, WorkerAccount, WorkerCatalog, WorkerLogin, WorkerRuntime, WorkerSession } from "./types";

export type StackState = Snapshot & {
  access: Resource<AccessSnapshot>;
  /** Main channel status by Package API name. */
  status: Record<string, ChannelStatus>;
  /** Scoped event subscription status by bot id. */
  scoped: Record<string, { pkg: string; status: ChannelStatus }>;
  events: StackEvent[];
  /** Most recent sign-in attempt this page has seen, kept visible after it finishes. */
  attempt: Login | null;
  /** Latest Worker sign-in attempt per account, kept visible after it finishes until dismissed. */
  workerAttempts: Record<string, WorkerLogin>;
  workerCatalogs: Record<string, Resource<WorkerCatalog>>;
  catalogPending: Record<string, boolean>;
  /** Watched per-scope resource history, keyed by scope id. */
  resourceHistory: Record<string, Resource<ResourceHistoryPoint[]>>;
  /** Monotonic invalidation generations, independent of the bounded activity log. */
  botInvalidations: Record<string, number>;
  /** Newest page of the durable inference request ledger. */
  inferRequests: Resource<InferRequestSummary[]>;
  /** Cached model discovery per Bot account; reading it starts no discovery. */
  inferModels: Resource<InferModelObservation[]>;
  /** The Inbox's chosen filter; `notifications.data.filter` is the one its loaded pages answer. */
  notificationFilter: NotificationFilter;
  notifications: Resource<NotificationPages>;
  notifyCounts: Resource<NotificationCounts>;
  /** Latest known record per notification ID, from any page, read or write. */
  notificationRecords: Record<string, Notification>;
  /** What the next launch receives besides instructions, matched against every known Bot working directory. */
  roleLaunch: Resource<RoleLaunchPreview>;
};

export type StackConnections = { packages?: readonly string[]; scopedBots?: boolean };

const authReads = new Set(["account_list", "account_login_current", "account_login_status", "worker_account_list", "worker_account_login_current", "worker_account_login_status"]);

function isLoginState(value: unknown): value is Login {
  return typeof value === "object" && value !== null && "status" in value && "authUrl" in value;
}

function isWorkerLoginState(value: unknown): value is WorkerLogin {
  return typeof value === "object" && value !== null && "status" in value && "account" in value && "provider" in value && "needsCode" in value;
}

type ResourceKey = "access" | "owner" | "resources" | "accounts" | "workerAccounts" | "workerRuntimes" | "workerSessions" | "login" | "workerLogins" | "bots" | "botDefaults" | "voice" | "role" | "rolePreview" | "roleLaunch" | "catalog" | "usage" | "inferRequests" | "inferModels" | "notifications" | "notifyCounts";

const inferPage = 20;
/** notification_list's maximum page size. */
const notifyPage = 25;

function isNotification(value: unknown): value is Notification {
  return typeof value === "object" && value !== null && "id" in value && "sequence" in value && "dismissedAt" in value;
}

function isRoleSnapshot(value: unknown): value is RoleSnapshot {
  return typeof value === "object" && value !== null && "revision" in value && "categories" in value;
}

const maxEvents = 250;

/** Distinct absolute Bot working directories, newline-joined so a change is one string comparison. */
function botCwds(bots: Bot[] | null): string {
  return [...new Set((bots ?? []).map((bot) => bot.cwd).filter((cwd) => typeof cwd === "string" && cwd.startsWith("/")))].sort().slice(0, 64).join("\n");
}

export class StackStore {
  private state: StackState;
  private readonly serverState: StackState;
  private listeners = new Set<() => void>();
  private main = new Map<string, Channel>();
  private scopedChannels = new Map<string, Channel>();
  private inflight = new Map<ResourceKey, Promise<void>>();
  private dirty = new Set<ResourceKey>();
  private seq = 0;
  private scopedBots = true;
  private catalogInflight = new Map<string, { promise: Promise<void>; refresh: boolean }>();
  private catalogDirty = new Map<string, boolean>();
  private catalogAvailable = new Set<string>();
  private catalogGeneration = new Map<string, number>();
  private historyWatchers = new Map<string, number>();
  private historyInflight = new Map<string, Promise<void>>();
  private historyDirty = new Set<string>();
  private notificationWatchers = new Map<string, number>();
  private olderInflight: Promise<void> | null = null;

  constructor(snapshot: Snapshot) {
    this.state = {
      ...snapshot, status: {}, scoped: {}, events: [], attempt: snapshot.login.data,
      access: { data: null, error: null, at: null },
      workerAttempts: Object.fromEntries((snapshot.workerLogins.data ?? []).map((login) => [login.account, login])),
      workerCatalogs: {}, catalogPending: {}, resourceHistory: {}, botInvalidations: {},
      inferRequests: { data: null, error: null, at: null }, inferModels: { data: null, error: null, at: null },
      notificationFilter: { dismissed: false }, notifications: { data: null, error: null, at: null },
      notifyCounts: { data: null, error: null, at: null }, notificationRecords: {},
      roleLaunch: { data: null, error: null, at: null },
    };
    this.serverState = this.state;
    for (const account of snapshot.workerAccounts.data ?? []) if (this.catalogAccountAvailable(account.id)) this.catalogAvailable.add(account.id);
  }

  getState = (): StackState => this.state;
  // Activity benches can hydrate after socket effects run. Hydration must still
  // read the original server snapshot, never the subsequently updated live state.
  getServerState = (): StackState => this.serverState;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  start({ packages, scopedBots = true }: StackConnections = {}): void {
    this.scopedBots = scopedBots;
    const { endpoints } = this.state;
    const enabled = packages && new Set(packages);
    const open = (pkg: string, onOpen: () => void, onNotice?: (topic: string) => void, topics?: string[], options?: { silent?: readonly string[] }) => {
      if (enabled && !enabled.has(pkg)) return;
      const url = endpoints[pkg];
      if (!url) return;
      const silent = new Set(options?.silent ?? []);
      const channel = new Channel(url, pkg, {
        onStatus: (status) => this.set({ status: { ...this.state.status, [pkg]: status } }),
        onOpen,
        onNotice: (topic) => {
          if (!silent.has(topic)) this.log(pkg, topic, null);
          onNotice?.(topic);
        },
      });
      if (topics) channel.subscribe(topics);
      this.main.set(pkg, channel.connect());
    };
    // resources_changed is a five-second sampling tick: refreshing state must not flood the activity log.
    open("owner", () => { this.refresh("owner"); this.refresh("resources"); this.refreshWatchedHistories(); }, (topic) => {
      if (topic === "pids_changed") this.refresh("owner");
      if (topic === "resources_changed") { this.refresh("resources"); this.refreshWatchedHistories(); }
    }, ["pids_changed", "resources_changed"], { silent: ["resources_changed"] });
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
    // Existing cards use the global inventory invalidation. Conversation consumers
    // subscribe to worker_progress + worker_changed scoped by Worker ID and resnapshot
    // worker_detail/worker_tool_list or continue immutable worker_record_list pages.
    open("worker", () => { this.refresh("workerRuntimes"); this.refresh("workerSessions"); this.reconcileCatalogs(true); }, () => {
      this.refresh("workerRuntimes"); this.refresh("workerSessions"); this.reconcileCatalogs(true);
    }, ["workers_changed"]);
    open("usage", () => this.refresh("usage"), () => this.refresh("usage"), ["usage_changed"]);
    // Reads only: discovery (infer_discover) and requests (infer_start) are explicit actions.
    open("infer", () => { this.refresh("inferRequests"); this.refresh("inferModels"); }, () => {
      this.refresh("inferRequests"); this.refresh("inferModels");
    }, ["infer_changed"]);
    const roleReads = () => { this.refresh("role"); this.refresh("rolePreview"); this.refresh("roleLaunch"); };
    open("roles", roleReads, roleReads, ["role_changed"]);
    const notify = () => { this.refresh("notifications"); this.refresh("notifyCounts"); this.refreshWatchedNotifications(); };
    open("notify", notify, notify, ["notify_changed"]);
    open("api", () => this.refresh("catalog"));
    open("access", () => this.refresh("access"), () => this.refresh("access"), ["access_changed"]);
    this.reconcileScoped();
  }

  stop(): void {
    this.catalogDirty.clear();
    for (const id of this.catalogAvailable) this.catalogGeneration.set(id, (this.catalogGeneration.get(id) ?? 0) + 1);
    for (const channel of [...this.main.values(), ...this.scopedChannels.values()]) channel.dispose();
    this.main.clear();
    this.scopedChannels.clear();
  }

  /** Call any operation on a Package API's main channel. Auth mutations refresh accounts and sign-in state; dial/hangup refresh voice state. Speech submission changes no call state. */
  call = async <T>(pkg: string, name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const channel = this.main.get(pkg);
    if (!channel || channel.status !== "open") throw new Error(`${pkg} WebSocket is not connected`);
    const request = channel.call<T>(name, args);
    const result = await (pkg === "bots" ? request.finally(() => {
      // A lost mutation acknowledgement may still have changed the Bot. Re-read,
      // never replay the operation automatically.
      if (pkg === "bots" && ["bot_start", "bot_stop", "bot_assign", "bot_remove", "chat_open"].includes(name)) this.refresh("bots");
      if (pkg === "bots" && name === "bot_defaults_set") this.refresh("botDefaults");
    }) : pkg === "access" && name !== "access_snapshot" ? request.finally(() => this.refresh("access")) : request);
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
    if (pkg === "notify" && isNotification(result)) this.upsertNotifications([result]);
    // Role writes return the whole snapshot; apply it before role_changed arrives so editors see their own write at once.
    if (pkg === "roles" && isRoleSnapshot(result) && result.revision >= (this.state.role?.data?.revision ?? -1)) {
      this.set({ role: { data: result, error: null, at: Date.now() } });
      this.refresh("rolePreview");
      this.refresh("roleLaunch");
    }
    return result;
  };

  /** Explicit infer actions. The ledger and model cache are re-read after each attempt, since a lost acknowledgement may still have admitted it. */
  infer = <T>(name: "infer_start" | "infer_discover", args: Record<string, unknown>): Promise<T> => {
    const refresh = () => this.refresh(name === "infer_start" ? "inferRequests" : "inferModels");
    return this.call<T>("infer", name, args).finally(refresh);
  };
  /** A fresh Role read that starts now, e.g. after a stale-revision refusal; it is applied like a write's result. */
  reloadRole = (): Promise<RoleSnapshot> => this.call<RoleSnapshot>("roles", "role_snapshot");

  /** Notify writes. Lists and counts are re-read after each attempt, since a lost acknowledgement may still have dismissed. */
  notify = <T>(name: "notification_dismiss" | "notification_dismiss_all", args: Record<string, unknown>): Promise<T> =>
    this.call<T>("notify", name, args).finally(() => { this.refresh("notifications"); this.refresh("notifyCounts"); });

  /** Show a different slice of the ledger; its first page replaces the loaded pages when it arrives. */
  setNotificationFilter = (filter: NotificationFilter): void => {
    this.set({ notificationFilter: filter });
    this.refresh("notifications");
  };

  /** Append the next older page of the loaded filter. */
  loadOlderNotifications = (): Promise<void> => {
    const pages = this.state.notifications.data;
    if (this.olderInflight || !pages?.nextCursor || pages.filter !== this.state.notificationFilter) return this.olderInflight ?? Promise.resolve();
    const { filter, nextCursor } = pages;
    this.olderInflight = this.call<{ entries: Notification[]; nextCursor: number | null }>("notify", "notification_list", { ...filter, before: nextCursor, limit: notifyPage })
      .then((page) => {
        const current = this.state.notifications.data;
        if (!current || current.filter !== filter || current.nextCursor !== nextCursor) return;
        const known = new Set(current.entries.map((item) => item.id));
        this.upsertNotifications(page.entries);
        this.set({ notifications: { data: { filter, entries: [...current.entries, ...page.entries.filter((item) => !known.has(item.id))], nextCursor: page.nextCursor }, error: null, at: Date.now() } });
      }, (error: Error) => this.set({ notifications: { ...this.state.notifications, error: error.message, at: Date.now() } }))
      .finally(() => { this.olderInflight = null; });
    return this.olderInflight;
  };

  /** Keep one record fresh while something shows it, even when no loaded page lists it. */
  watchNotification = (id: string): (() => void) => {
    const watchers = (this.notificationWatchers.get(id) ?? 0) + 1;
    this.notificationWatchers.set(id, watchers);
    if (watchers === 1) this.readNotification(id);
    return () => {
      const remaining = (this.notificationWatchers.get(id) ?? 0) - 1;
      if (remaining > 0) this.notificationWatchers.set(id, remaining);
      else this.notificationWatchers.delete(id);
    };
  };

  private refreshWatchedNotifications(): void {
    for (const id of this.notificationWatchers.keys()) this.readNotification(id);
  }

  private readNotification(id: string): void {
    if (this.main.get("notify")?.status !== "open") return;
    this.call<Notification>("notify", "notification_get", { id }).catch((error: Error) => {
      if (!/notification_not_found/.test(error.message) || !this.state.notificationRecords[id]) return;
      const notificationRecords = { ...this.state.notificationRecords };
      delete notificationRecords[id];
      this.set({ notificationRecords });
    });
  }

  private upsertNotifications(entries: Notification[]): void {
    if (entries.length) this.set({ notificationRecords: { ...this.state.notificationRecords, ...Object.fromEntries(entries.map((item) => [item.id, item])) } });
  }

  /** Re-read as many pages as are loaded, so an invalidation neither drops older rows nor keeps stale ones. */
  private async loadNotifications(): Promise<NotificationPages> {
    const filter = this.state.notificationFilter;
    const loaded = this.state.notifications.data;
    const pages = loaded?.filter === filter ? Math.max(1, Math.ceil(loaded.entries.length / notifyPage)) : 1;
    const channel = this.main.get("notify");
    if (!channel) throw new Error("notify WebSocket is not configured");
    const entries: Notification[] = [];
    let before: number | undefined;
    let nextCursor: number | null = null;
    for (let index = 0; index < pages; index += 1) {
      const page = await channel.call<{ entries: Notification[]; nextCursor: number | null }>("notification_list", { ...filter, limit: notifyPage, ...(before ? { before } : {}) });
      entries.push(...page.entries);
      nextCursor = page.nextCursor;
      if (nextCursor === null) break;
      before = nextCursor;
    }
    return { filter, entries, nextCursor };
  }

  dismissAttempt = (): void => this.set({ attempt: null });

  reloadUsage = (): void => this.refresh("usage");

  /** One no-turn catalog read per account, shared by cards and inspectors. */
  refreshWorkerCatalog = (id: string, refresh = true): Promise<void> => {
    const pending = this.catalogInflight.get(id);
    if (pending) {
      // An explicit rediscovery must not be swallowed by a cache-only read.
      if (refresh && !pending.refresh) this.catalogDirty.set(id, true);
      return pending.promise;
    }
    if (!this.catalogAccountAvailable(id) || this.main.get("worker")?.status !== "open") return Promise.resolve();
    const generation = this.catalogGeneration.get(id) ?? 0;
    this.set({ catalogPending: { ...this.state.catalogPending, [id]: true } });
    const run = this.call<WorkerCatalog>("worker", "worker_catalog", { accountId: id, refresh })
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state.workerCatalogs[id]?.data ?? null, error: error.message, at: Date.now() }))
      .then((resource) => {
        // Availability now is insufficient: disable/re-enable may have replaced
        // the account's runtime while this observation was in flight.
        if (this.catalogAccountAvailable(id) && generation === (this.catalogGeneration.get(id) ?? 0)) this.set({ workerCatalogs: { ...this.state.workerCatalogs, [id]: resource } });
      }).finally(() => {
        this.catalogInflight.delete(id);
        const followup = this.catalogDirty.get(id);
        this.catalogDirty.delete(id);
        if (followup !== undefined && this.catalogAccountAvailable(id) && this.main.get("worker")?.status === "open") return this.refreshWorkerCatalog(id, followup);
        const catalogPending = { ...this.state.catalogPending };
        delete catalogPending[id];
        this.set({ catalogPending });
      });
    this.catalogInflight.set(id, { promise: run, refresh });
    return run;
  };

  /**
   * Reference-counted history subscription per scope id. The first watcher
   * loads it; the last unwatch drops the entry and its single-flight chain.
   */
  watchResourceHistory = (scopeId: string): (() => void) => {
    const watchers = (this.historyWatchers.get(scopeId) ?? 0) + 1;
    this.historyWatchers.set(scopeId, watchers);
    if (watchers === 1) this.refreshHistory(scopeId);
    return () => {
      const remaining = (this.historyWatchers.get(scopeId) ?? 0) - 1;
      if (remaining > 0) {
        this.historyWatchers.set(scopeId, remaining);
        return;
      }
      this.historyWatchers.delete(scopeId);
      this.historyDirty.delete(scopeId);
      if (this.state.resourceHistory[scopeId]) {
        const resourceHistory = { ...this.state.resourceHistory };
        delete resourceHistory[scopeId];
        this.set({ resourceHistory });
      }
    };
  };

  private refreshWatchedHistories(): void {
    for (const scopeId of this.historyWatchers.keys()) this.refreshHistory(scopeId);
  }

  private refreshHistory(scopeId: string): void {
    if (!this.historyWatchers.has(scopeId)) return;
    if (this.historyInflight.has(scopeId)) {
      this.historyDirty.add(scopeId);
      return;
    }
    const existing = this.state.resourceHistory[scopeId]?.data ?? [];
    const newest = existing.at(-1)?.attemptedAt;
    const args = newest ? { scopeId, since: newest } : { scopeId, limit: 120 };
    const run = this.call<ResourceHistoryPage>("owner", "owner_resource_history", args)
      .then((page) => ({ data: mergeHistory(existing, page.points, page.retention), error: null, at: Date.now() }),
        (error: Error) => ({ data: this.state.resourceHistory[scopeId]?.data ?? null, error: error.message, at: Date.now() }))
      .then((next) => {
        if (this.historyWatchers.has(scopeId)) this.set({ resourceHistory: { ...this.state.resourceHistory, [scopeId]: next } });
      })
      .finally(() => {
        this.historyInflight.delete(scopeId);
        if (this.historyDirty.delete(scopeId)) this.refreshHistory(scopeId);
      });
    this.historyInflight.set(scopeId, run);
  }

  private catalogAccountAvailable(id: string): boolean {
    return Boolean(this.state.workerAccounts.data?.some((account) => account.id === id && account.enabled && account.ready && !account.removing));
  }

  private reconcileCatalogs(invalidated = false): void {
    const available = new Set((this.state.workerAccounts.data ?? []).filter((account) => this.catalogAccountAvailable(account.id)).map((account) => account.id));
    for (const id of new Set([...available, ...this.catalogAvailable])) {
      if (available.has(id) !== this.catalogAvailable.has(id)) this.catalogGeneration.set(id, (this.catalogGeneration.get(id) ?? 0) + 1);
      if (!available.has(id)) this.catalogDirty.delete(id);
    }
    this.catalogAvailable = available;
    const workerCatalogs = Object.fromEntries(Object.entries(this.state.workerCatalogs).filter(([id]) => this.catalogAccountAvailable(id)));
    if (Object.keys(workerCatalogs).length !== Object.keys(this.state.workerCatalogs).length) this.set({ workerCatalogs });
    for (const id of available) {
      // Discovery itself emits workers_changed. Its coalesced follow-up MUST be
      // cache-only: the API's cached success/failure reads emit no new notice.
      if (invalidated && this.catalogInflight.has(id) && !this.catalogDirty.has(id)) this.catalogDirty.set(id, false);
      void this.refreshWorkerCatalog(id, false);
    }
  }

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
    this.set({ events: [event, ...this.state.events].slice(0, maxEvents),
      ...(pkg === "bots" && scope ? { botInvalidations: { ...this.state.botInvalidations, [scope]: (this.state.botInvalidations[scope] ?? 0) + 1 } } : {}) });
  }

  private invalidateBot(id: string): void {
    this.set({ botInvalidations: { ...this.state.botInvalidations, [id]: (this.state.botInvalidations[id] ?? 0) + 1 } });
  }

  private refresh(key: ResourceKey): void {
    if (this.inflight.has(key)) {
      this.dirty.add(key);
      return;
    }
    const run = this.load(key)
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state[key]?.data ?? null, error: error.message, at: Date.now() }))
      .then((next) => {
        // A read that started before a write it lost the race to must not roll the Role back.
        const newer = (key === "role" || key === "rolePreview" || key === "roleLaunch") && (this.state[key]?.data as { revision: number } | null)?.revision;
        const cwds = key === "bots" ? botCwds(this.state.bots.data) : "";
        if (typeof newer === "number" && next.data && (next.data as { revision: number }).revision < newer) return;
        // Pages for a filter the Inbox has since left are dropped; the follow-up read serves the new one.
        if (key === "notifications" && next.data && (next.data as NotificationPages).filter !== this.state.notificationFilter) { this.dirty.add(key); return; }
        if (key === "notifications" && next.data) this.upsertNotifications((next.data as NotificationPages).entries);
        this.set({ [key]: next } as Partial<StackState>);
        if (key === "login") this.reconcileAttempt();
        if (key === "workerLogins") this.reconcileWorkerAttempts();
        if (key === "bots") this.reconcileScoped();
        // Trusted project matches depend on where Bots run.
        if (key === "bots" && botCwds(this.state.bots.data) !== cwds) this.refresh("roleLaunch");
        if (key === "workerAccounts") this.reconcileCatalogs(true);
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
      case "access": return call<AccessSnapshot>("access", "access_snapshot");
      case "owner": return call<OwnerStatus>("owner", "owner_status");
      case "resources": return loadResources((name, args) => call<never>("owner", name, args)) as Promise<OwnerResources>;
      case "accounts": return call<{ accounts: Account[] }>("auth", "account_list").then((result) => result.accounts);
      case "workerAccounts": return call<{ accounts: WorkerAccount[] }>("auth", "worker_account_list").then((result) => result.accounts);
      case "workerRuntimes": return call<{ runtimes: WorkerRuntime[] }>("worker", "worker_runtime_list").then((result) => result.runtimes);
      case "workerSessions": return call<{ workers: WorkerSession[] }>("worker", "worker_list").then((result) => result.workers);
      case "login": return call<{ login: Login | null }>("auth", "account_login_current").then((result) => result.login);
      case "workerLogins": return call<{ logins: WorkerLogin[] }>("auth", "worker_account_login_current").then((result) => result.logins);
      case "bots": return call<{ bots: Bot[] }>("bots", "bot_list").then((result) => result.bots);
      case "botDefaults": return call<BotSettings>("bots", "bot_defaults_get");
      case "voice": return call<{ call: VoiceCall | null }>("bots", "voice_status").then((result) => result.call);
      case "role": return call<RoleSnapshot>("roles", "role_snapshot");
      case "rolePreview": return call<RolePreview>("roles", "role_preview");
      case "roleLaunch": return call<RoleLaunchPreview>("roles", "role_launch_preview", { cwds: botCwds(this.state.bots.data).split("\n").filter(Boolean) });
      case "usage": return call<UsageSnapshot>("usage", "usage_snapshot");
      case "catalog": return loadCatalog((name, args) => call<never>("api", name, args)) as Promise<PackageDoc[]>;
      case "inferRequests": return call<{ requests: InferRequestSummary[] }>("infer", "infer_request_list", { limit: inferPage }).then((result) => result.requests);
      case "inferModels": return call<{ accounts: InferModelObservation[] }>("infer", "infer_model_list", {}).then((result) => result.accounts);
      case "notifications": return this.loadNotifications();
      case "notifyCounts": return call<NotificationCounts>("notify", "notification_counts");
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

  /** Keep one scoped subscription per bot; notices are not proof of sanctioned thread activity.
   * Bot tools expose chat_tree/chat_tree_detail snapshots and mark them stale on
   * notices/reconnects; subsequent pages are explicitly fenced with snapshot.
   */
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
    this.set({ scoped });
    for (const [id, { pkg, topics }] of wanted) {
      if (this.scopedChannels.has(id)) continue;
      this.set({ scoped: { ...this.state.scoped, [id]: { pkg, status: "idle" } } });
      const channel = new Channel(endpoints[pkg], pkg, {
        onStatus: (status) => {
          if (this.scopedChannels.get(id) !== channel) return;
          this.set({ scoped: { ...this.state.scoped, [id]: { pkg, status } } });
          if (status === "closed") this.invalidateBot(id);
        },
        // onOpen also runs when the underlying socket subscription reconnects
        // without closing the browser WebSocket. Missed notices are not replayed.
        onOpen: () => { if (this.scopedChannels.get(id) === channel) this.invalidateBot(id); },
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
  }
}
