import { loadCatalog } from "./catalog";
import type { AccessSnapshot } from "./types";
import { Channel } from "./channel";
import { loadResources, mergeHistory } from "./resources";
import { asText, itemKindFor, itemLimit, scopeKey, sha256Hex } from "./content";
import { stageBytes, StageStalled } from "./content-upload";
import type { ContentArtifact, ContentCollection, ContentDocument, ContentItem, ContentItemPage, ContentItemScope, ContentLibrary, ContentTag, ContentUpload } from "./types";
import { scrapeCallError } from "./scrape";
import type { ScrapeCanaryRun, ScrapePreset, ScrapeQueue, ScrapeReplay, ScrapeStatus } from "./types";
import type { Account, AttentionItem, AttentionMessage, AttentionPage, AttentionRun, AttentionStatus, Bot, BotSettings, ChannelStatus, InferModelObservation, InferRequestSummary, Login, Notification, NotificationCounts, NotificationFilter, NotificationPages, OwnerResources, OwnerStatus, PackageDoc, Resource, ResourceHistoryPage, ResourceHistoryPoint, RoleLaunchPreview, RolePreview, RoleSnapshot, Snapshot, StackEvent, UsageSnapshot, VoiceCall, WorkerAccount, WorkerCatalog, WorkerLogin, WorkerRuntime, WorkerSession, WorkerStatus } from "./types";

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
  signalStatus: Resource<AttentionStatus>;
  /** Bumped when attention records may have changed (a new `changeSeq` or a reconnect); Signal views re-read on it. */
  signalGeneration: number;
  /** Attention records any Signal view has read, by ID, so links and the inspector resolve them. */
  signalRecords: SignalRecords;
  /** Newest Vault documents, as `list` returns them. */
  contentDocuments: Resource<ContentDocument[]>;
  contentTags: Resource<ContentTag[]>;
  /** Every collection plus item totals per Library scope. */
  contentLibrary: Resource<ContentLibrary>;
  /** The Library's loaded item pages for its current scope. */
  contentItems: Resource<ContentItemPage>;
  contentArtifacts: Resource<ContentArtifact[]>;
  /** `content_status` route templates. */
  contentRoutes: Resource<{ documentPath: string; artifactPath: string; itemPath: string }>;
  /** Increments on every content invalidation, so windows re-run their own reads. */
  contentGeneration: number;
  /** Single records windows have read, by node key, so the inspector can show records outside the loaded lists. */
  contentRecords: Record<string, Record<string, unknown>>;
  contentUploads: ContentUpload[];
  /** The Library's chosen item scope, which contentItems follows. */
  contentItemScope: ContentItemScope;
  /** worker_status for each Worker a window watches. */
  workerStatuses: Record<string, Resource<WorkerStatus>>;
  /** Bumped on a watched Worker's scoped notices and (re)subscription; its windows re-read their pages on it. */
  workerGenerations: Record<string, number>;
  scrapeStatus: Resource<ScrapeStatus>;
  scrapePresets: Resource<ScrapePreset[]>;
  /** Preset names with a configured live canary; configuration is not a passing check. */
  scrapeCanaries: Resource<string[]>;
  scrapeQueue: Resource<ScrapeQueue>;
  /** This page's latest canary run and corpus replay; neither is durable. */
  scrapeChecks: { canary: ScrapeCheck<ScrapeCanaryRun> | null; replay: ScrapeCheck<ScrapeReplay> | null };
  /** A preset another window asked Extract to try; `seq` distinguishes repeated requests. */
  scrapeCompose: { seq: number; preset: string; mode: "page" | "links" } | null;
};

/** A check this page started. `error` is set when the call itself failed; `uncertain` when it may still be running. */
export type ScrapeCheck<T> = { startedAt: number; finishedAt: number | null; args: Record<string, unknown>; result: T | null; error: string | null; uncertain: boolean };

export type SignalRecords = { items: Record<string, AttentionItem>; messages: Record<string, AttentionMessage>; runs: Record<string, AttentionRun> };

export type StackConnections = { packages?: readonly string[]; scopedBots?: boolean };

const authReads = new Set(["account_list", "account_login_current", "account_login_status", "worker_account_list", "worker_account_login_current", "worker_account_login_status"]);

function isLoginState(value: unknown): value is Login {
  return typeof value === "object" && value !== null && "status" in value && "authUrl" in value;
}

function isWorkerLoginState(value: unknown): value is WorkerLogin {
  return typeof value === "object" && value !== null && "status" in value && "account" in value && "provider" in value && "needsCode" in value;
}

type ContentKey = "contentDocuments" | "contentTags" | "contentLibrary" | "contentItems" | "contentArtifacts" | "contentRoutes";
const contentKeys: ContentKey[] = ["contentDocuments", "contentTags", "contentLibrary", "contentItems", "contentArtifacts", "contentRoutes"];
/** Successful content writes change what the lists show; blob stages do not. */
const contentWrites = new Set(["collection_create", "collection_update", "collection_delete", "item_put", "item_move", "item_delete",
  "document_update", "new", "add", "rm", "restore", "artifacts_rm", "artifacts_restore", "artifact_publish", "gc"]);
const itemPage = 100;
export const contentDocumentLimit = 200;

type ResourceKey = ContentKey | "access" | "owner" | "resources" | "accounts" | "workerAccounts" | "workerRuntimes" | "workerSessions" | "login" | "workerLogins" | "bots" | "botDefaults" | "voice" | "role" | "rolePreview" | "roleLaunch" | "catalog" | "usage" | "inferRequests" | "inferModels" | "notifications" | "notifyCounts" | "signalStatus" | "scrapeStatus" | "scrapePresets" | "scrapeCanaries" | "scrapeQueue";

const inferPage = 20;
/** Jobs the Queue window lists; counts cover every job. */
export const scrapeQueueLimit = 200;
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
  private itemScope: ContentItemScope = undefined;
  private itemPages = 1;
  private uploadFiles = new Map<string, File>();
  private uploadSeq = 0;
  private remoteInflight: Promise<void> | null = null;
  private workerWatchers = new Map<string, number>();
  private workerChannels = new Map<string, Channel>();
  private statusInflight = new Map<string, Promise<void>>();
  private statusDirty = new Set<string>();

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
      signalStatus: { data: null, error: null, at: null }, signalGeneration: 0, signalRecords: { items: {}, messages: {}, runs: {} },
      contentDocuments: { data: null, error: null, at: null }, contentTags: { data: null, error: null, at: null },
      contentLibrary: { data: null, error: null, at: null }, contentItems: { data: null, error: null, at: null },
      contentArtifacts: { data: null, error: null, at: null }, contentRoutes: { data: null, error: null, at: null },
      contentGeneration: 0, contentRecords: {}, contentUploads: [], contentItemScope: undefined,
      workerStatuses: {}, workerGenerations: {},
      scrapeStatus: { data: null, error: null, at: null }, scrapePresets: { data: null, error: null, at: null },
      scrapeCanaries: { data: null, error: null, at: null }, scrapeQueue: { data: null, error: null, at: null },
      scrapeChecks: { canary: null, replay: null }, scrapeCompose: null,
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
        onStatus: (status) => { this.set({ status: { ...this.state.status, [pkg]: status } }); if (status === "closed" && this.state.remote) void this.syncRemote(); },
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
    // Cards and the Workers list use the global inventory invalidation. Worker windows
    // subscribe to worker_progress + worker_changed scoped by Worker ID (watchWorker).
    open("worker", () => { this.refresh("workerRuntimes"); this.refresh("workerSessions"); this.reconcileCatalogs(true); }, () => {
      this.refresh("workerRuntimes"); this.refresh("workerSessions"); this.reconcileCatalogs(true);
    }, ["workers_changed"]);
    open("usage", () => this.refresh("usage"), () => this.refresh("usage"), ["usage_changed"]);
    // Reads only: discovery (infer_discover) and requests (infer_start) are explicit actions.
    open("infer", () => { this.refresh("inferRequests"); this.refresh("inferModels"); }, () => {
      this.refresh("inferRequests"); this.refresh("inferModels");
    }, ["infer_changed"]);
    // Signal publishes signal_changed after every source scan while processing is enabled. The
    // status read is cheap; list views re-read only when its changeSeq says records may have changed.
    open("signal", () => this.refresh("signalStatus"), () => this.refresh("signalStatus"), ["signal_changed"], { silent: ["signal_changed"] });
    const roleReads = () => { this.refresh("role"); this.refresh("rolePreview"); this.refresh("roleLaunch"); };
    open("roles", roleReads, roleReads, ["role_changed"]);
    const notify = () => { this.refresh("notifications"); this.refresh("notifyCounts"); this.refreshWatchedNotifications(); };
    open("notify", notify, notify, ["notify_changed"]);
    open("api", () => this.refresh("catalog"));
    open("access", () => this.refresh("access"), () => this.refresh("access"), ["access_changed"]);
    // content_changed is an invalidation notice; windows re-read what they show from contentGeneration.
    open("content", () => this.invalidateContent(), () => this.invalidateContent(), ["content_changed"]);
    // Presets and executables have no change event; they are read on (re)connect and on request.
    // scrape_queue_changed is an invalidation notice only, so the queue is re-read after each.
    open("scrape", () => { this.refreshScrape(); this.refresh("scrapeQueue"); }, () => this.refresh("scrapeQueue"), ["scrape_queue_changed"]);
    this.reconcileScoped();
    for (const id of this.workerWatchers.keys()) this.openWorkerChannel(id);
  }

  stop(): void {
    this.catalogDirty.clear();
    for (const id of this.catalogAvailable) this.catalogGeneration.set(id, (this.catalogGeneration.get(id) ?? 0) + 1);
    for (const channel of [...this.main.values(), ...this.scopedChannels.values(), ...this.workerChannels.values()]) channel.dispose();
    this.main.clear();
    this.scopedChannels.clear();
    this.workerChannels.clear();
  }
  syncRemote = (): Promise<void> => {
    if (!this.state.remote) return Promise.resolve();
    if (this.remoteInflight) return this.remoteInflight;
    this.remoteInflight = (async () => {
      try {
        const response = await fetch("/connect/me", { cache: "no-store" });
        if (!response.ok) { if (response.status === 401) window.location.assign("/connect"); return; }
        const data: { data: { scopes: string[] } } = await response.json();
        const current = this.state.remote;
        if (!current || JSON.stringify(current.scopes) === JSON.stringify(data.data.scopes)) return;
        this.set({ remote: { ...current, scope: data.data.scopes.includes("uix:control") ? "control" : "view", scopes: data.data.scopes } });
      } catch { /* the gateway still denies stale permissions */ }
    })().finally(() => { this.remoteInflight = null; });
    return this.remoteInflight;
  };

  /** Call any operation on a Package API's main channel. Auth mutations refresh accounts and sign-in state; dial/hangup refresh voice state. Speech submission changes no call state. */
  call = async <T>(pkg: string, name: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (this.state.remote?.scope === "view") {
      const annotation = this.state.catalog.data?.find(doc => doc.name === pkg)?.operations.find(operation => operation.name === name)?.annotations;
      if (annotation && annotation.readOnlyHint !== true) throw new Error("Read-only remote session: this operation requires uix:control");
    }
    if (this.state.remote && ["access", "auth", "browse"].includes(pkg)) throw new Error(`${pkg} controls are available only on the local UIX`);
    if (this.state.remote && pkg === "bots" && name.startsWith("voice_")) throw new Error("Voice calls are available only on the local UIX");
    const channel = this.main.get(pkg);
    if (!channel || channel.status !== "open") throw new Error(`${pkg} WebSocket is not connected`);
    const request = channel.call<T>(name, args);
    const result = await (pkg === "bots" ? request.finally(() => {
      // A lost mutation acknowledgement may still have changed the Bot. Re-read,
      // never replay the operation automatically.
      if (pkg === "bots" && ["bot_start", "bot_stop", "bot_assign", "bot_remove", "chat_open"].includes(name)) this.refresh("bots");
      if (pkg === "bots" && name === "bot_defaults_set") this.refresh("botDefaults");
    }) : pkg === "access" && name !== "access_snapshot" ? request.finally(() => this.refresh("access"))
      // A lost acknowledgement may still have written; re-read either way, never replay.
      : pkg === "content" && contentWrites.has(name) ? request.finally(() => this.invalidateContent()) : request);
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

  /** Ask the Extract window to use a preset; it keeps the URL already entered. */
  composeScrape = (preset: string, mode: "page" | "links"): void => {
    this.set({ scrapeCompose: { seq: (this.state.scrapeCompose?.seq ?? 0) + 1, preset, mode } });
  };

  /** Re-read Scrape's status, presets and canary inventory. */
  refreshScrape = (): void => {
    this.refresh("scrapeStatus"); this.refresh("scrapePresets"); this.refresh("scrapeCanaries");
  };

  /**
   * Scrape queue writes. The queue is re-read afterwards either way, since a lost acknowledgement
   * may still have submitted or processed; nothing is resent automatically.
   */
  scrapeQueueAction = <T>(name: "scrape_queue_submit" | "scrape_queue_process", args: Record<string, unknown>): Promise<T> =>
    this.call<T>("scrape", name, args).finally(() => this.refresh("scrapeQueue"));

  /** Run a canary check or corpus replay and keep its latest outcome for this page. */
  scrapeCheck = async (kind: "canary" | "replay", args: Record<string, unknown>): Promise<void> => {
    const startedAt = Date.now();
    const set = (check: ScrapeCheck<unknown>) => this.set({ scrapeChecks: { ...this.state.scrapeChecks, [kind]: check } });
    set({ startedAt, finishedAt: null, args, result: null, error: null, uncertain: false });
    const current = () => this.state.scrapeChecks[kind]?.startedAt === startedAt;
    try {
      const result = await this.call<ScrapeCanaryRun | ScrapeReplay>("scrape", kind === "canary" ? "scrape_presets_check" : "scrape_corpus_replay", args);
      if (current()) set({ startedAt, finishedAt: Date.now(), args, result, error: null, uncertain: false });
    } catch (error) {
      const failure = scrapeCallError(error);
      if (current()) set({ startedAt, finishedAt: Date.now(), args, result: null, error: failure.text, uncertain: failure.uncertain });
    }
  };

  /** Explicit infer actions. The ledger and model cache are re-read after each attempt, since a lost acknowledgement may still have admitted it. */
  infer = <T>(name: "infer_start" | "infer_discover", args: Record<string, unknown>): Promise<T> => {
    const refresh = () => this.refresh(name === "infer_start" ? "inferRequests" : "inferModels");
    return this.call<T>("infer", name, args).finally(refresh);
  };
  /** Read a Signal list and remember its records for links and inspection. */
  readSignal = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const result = await this.call<T>("signal", name, args);
    const entries = (result as AttentionPage<unknown>).entries;
    const records = this.state.signalRecords;
    if (name === "attention_list") {
      const items = (entries as Array<{ cursor: number; item: Omit<AttentionItem, "cursor"> }>).map(({ cursor, item }) => ({ ...item, cursor }));
      this.set({ signalRecords: { ...records, items: { ...records.items, ...Object.fromEntries(items.map((item) => [item.id, item])) } } });
      return { ...result, entries: items } as T;
    }
    if (name === "attention_message_list") this.set({ signalRecords: { ...records, messages: { ...records.messages, ...Object.fromEntries((entries as AttentionMessage[]).map((entry) => [entry.id, entry])) } } });
    if (name === "attention_run_list") this.set({ signalRecords: { ...records, runs: { ...records.runs, ...Object.fromEntries((entries as AttentionRun[]).map((entry) => [entry.id, entry])) } } });
    return result;
  };

  /** Signal writes. Status is re-read afterwards, since a lost acknowledgement may still have applied the write. */
  signalAction = <T>(name: "attention_control" | "attention_defaults_set" | "attention_feedback" | "attention_replay", args: Record<string, unknown>): Promise<T> =>
    this.call<T>("signal", name, args).finally(() => this.refresh("signalStatus"));

  private bumpSignal(): void {
    this.set({ signalGeneration: this.state.signalGeneration + 1 });
  }

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

  /** Re-read every content list and tell windows to re-read their own records. */
  invalidateContent = (): void => {
    this.set({ contentGeneration: this.state.contentGeneration + 1 });
    for (const key of contentKeys) this.refresh(key);
  };

  /** Show all items (undefined), ungrouped items (null) or one collection's items in the Library. */
  setContentItemScope = (scope: ContentItemScope): void => {
    if (scopeKey(scope) === scopeKey(this.itemScope)) return;
    this.itemScope = scope;
    this.itemPages = 1;
    this.set({ contentItemScope: scope });
    this.refresh("contentItems");
  };

  loadMoreContentItems = (): void => {
    if (this.state.contentItems.data?.nextOffset === null) return;
    this.itemPages++;
    this.refresh("contentItems");
  };

  /** Keep (or forget, with null) a single content record a window read, for the inspector. */
  rememberContent = (key: string, record: Record<string, unknown> | null): void => {
    const current = this.state.contentRecords[key];
    if (record === null ? current === undefined : JSON.stringify(current) === JSON.stringify(record)) return;
    const contentRecords = { ...this.state.contentRecords };
    if (record === null) delete contentRecords[key]; else contentRecords[key] = record;
    this.set({ contentRecords });
  };

  /** Upload files as Content items through resumable blob stages; progress and failures stay visible until dismissed. */
  uploadContent = (files: File[], collection: string | null): void => {
    const added: ContentUpload[] = files.map((file) => {
      const key = `upload-${++this.uploadSeq}`;
      this.uploadFiles.set(key, file);
      return { key, name: file.name, bytes: file.size, received: 0, collection, phase: "hashing", error: null, itemId: null, stageId: null, retryable: true };
    });
    this.set({ contentUploads: [...this.state.contentUploads, ...added] });
    // One file at a time keeps chunks from competing for the one WebSocket.
    void added.reduce((chain, upload) => chain.then(() => this.runUpload(upload.key)), Promise.resolve());
  };

  /** Resume a stalled upload or retry one that failed before it could have been stored. */
  resumeUpload = (key: string): void => {
    const upload = this.state.contentUploads.find((item) => item.key === key);
    if (!upload || !this.uploadFiles.has(key) || !upload.retryable || !["stalled", "failed"].includes(upload.phase)) return;
    void this.runUpload(key);
  };

  dismissUpload = (key: string): void => {
    this.uploadFiles.delete(key);
    this.set({ contentUploads: this.state.contentUploads.filter((item) => item.key !== key) });
  };

  private patchUpload(key: string, patch: Partial<ContentUpload>): void {
    this.set({ contentUploads: this.state.contentUploads.map((item) => item.key === key ? { ...item, ...patch } : item) });
  }

  private async runUpload(key: string): Promise<void> {
    const file = this.uploadFiles.get(key);
    const upload = this.state.contentUploads.find((item) => item.key === key);
    if (!file || !upload) return;
    let storing = false;
    try {
      if (file.size > itemLimit) throw new Error("Larger than the 50 MiB item limit");
      this.patchUpload(key, { phase: "hashing", error: null });
      const bytes = new Uint8Array(await file.arrayBuffer());
      const digest = await sha256Hex(bytes);
      this.patchUpload(key, { phase: "uploading" });
      const blob = await stageBytes((name, args) => this.call("content", name, args), bytes, digest,
        (received, stageId) => this.patchUpload(key, { received, stageId }));
      let { kind, mediaType } = itemKindFor(file.name, file.type);
      // Documents must be UTF-8; other text is kept as a file.
      if (kind === "document" && asText(bytes.subarray(0, Math.min(bytes.length, 65_536))) === null) kind = "file";
      storing = true;
      this.patchUpload(key, { phase: "storing", received: file.size });
      const item = await this.call<ContentItem>("content", "item_put", { collection: upload.collection, name: file.name, kind, mediaType, blob });
      this.uploadFiles.delete(key);
      this.patchUpload(key, { phase: "done", itemId: item.id });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (error instanceof StageStalled) this.patchUpload(key, { phase: "stalled", error: text, received: error.received, stageId: error.stageId });
      // item_put is not idempotent: after a lost response the item may exist, so never retry blindly.
      else if (storing && !/already exists|not found|must be|exceeds/.test(text)) this.patchUpload(key, { phase: "failed", error: `${text}. It may have been stored; check the Library.`, retryable: false });
      else this.patchUpload(key, { phase: "failed", error: text, retryable: !storing || /already exists|not found/.test(text) });
    }
  }

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

  /**
   * Reference-counted scoped subscription to one Worker's worker_changed and
   * worker_progress notices. Every notice and (re)subscription bumps its
   * generation, since missed notices are not replayed; worker_changed and
   * (re)subscription also re-read its status. Reads only: nothing here writes.
   */
  watchWorker = (id: string): (() => void) => {
    const watchers = (this.workerWatchers.get(id) ?? 0) + 1;
    this.workerWatchers.set(id, watchers);
    if (watchers === 1) this.openWorkerChannel(id);
    return () => {
      const remaining = (this.workerWatchers.get(id) ?? 0) - 1;
      if (remaining > 0) { this.workerWatchers.set(id, remaining); return; }
      this.workerWatchers.delete(id);
      this.statusDirty.delete(id);
      this.workerChannels.get(id)?.dispose();
      this.workerChannels.delete(id);
      if (this.state.workerStatuses[id]) {
        const workerStatuses = { ...this.state.workerStatuses };
        delete workerStatuses[id];
        this.set({ workerStatuses });
      }
    };
  };

  private openWorkerChannel(id: string): void {
    const url = this.state.endpoints.worker;
    if (!url || this.workerChannels.has(id)) return;
    const channel = new Channel(url, "worker", {
      onOpen: () => {
        if (this.workerChannels.get(id) !== channel) return;
        this.bumpWorker(id);
        this.readWorkerStatus(id);
      },
      onNotice: (topic) => {
        if (this.workerChannels.get(id) !== channel) return;
        this.bumpWorker(id);
        if (topic === "worker_changed") this.readWorkerStatus(id);
      },
    });
    this.workerChannels.set(id, channel);
    channel.subscribe(["worker_changed", "worker_progress"], id).connect();
  }

  private bumpWorker(id: string): void {
    this.set({ workerGenerations: { ...this.state.workerGenerations, [id]: (this.state.workerGenerations[id] ?? 0) + 1 } });
  }

  private readWorkerStatus(id: string): void {
    if (!this.workerWatchers.has(id)) return;
    if (this.statusInflight.has(id)) { this.statusDirty.add(id); return; }
    const run = this.call<WorkerStatus>("worker", "worker_status", { id })
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state.workerStatuses[id]?.data ?? null, error: error.message, at: Date.now() }))
      .then((next) => { if (this.workerWatchers.has(id)) this.set({ workerStatuses: { ...this.state.workerStatuses, [id]: next } }); })
      .finally(() => {
        this.statusInflight.delete(id);
        if (this.statusDirty.delete(id)) this.readWorkerStatus(id);
      });
    this.statusInflight.set(id, run);
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
        const changeSeq = key === "signalStatus" ? this.state.signalStatus.data?.changeSeq : undefined;
        // A Library scope change while a page read was in flight: read again for the new scope.
        if (key === "contentItems" && next.data && scopeKey((next.data as ContentItemPage).scope) !== scopeKey(this.itemScope)) { this.dirty.add(key); return; }
        this.set({ [key]: next } as Partial<StackState>);
        if (key === "signalStatus" && next.data && (next.data as AttentionStatus).changeSeq !== changeSeq) this.bumpSignal();
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
      case "signalStatus": return call<AttentionStatus>("signal", "attention_status");
      case "inferModels": return call<{ accounts: InferModelObservation[] }>("infer", "infer_model_list", {}).then((result) => result.accounts);
      case "notifications": return this.loadNotifications();
      case "notifyCounts": return call<NotificationCounts>("notify", "notification_counts");
      case "contentDocuments": return call<{ documents: ContentDocument[] }>("content", "list", { limit: contentDocumentLimit }).then((result) => result.documents);
      case "contentTags": return call<{ tags: ContentTag[] }>("content", "tags", {}).then((result) => result.tags);
      case "contentArtifacts": return call<{ artifacts: ContentArtifact[] }>("content", "artifacts_list", {}).then((result) => result.artifacts);
      case "contentRoutes": return call<{ documentPath: string; artifactPath: string; itemPath: string }>("content", "content_status", {});
      case "contentLibrary": return this.loadLibrary(call);
      case "contentItems": return this.loadItems(call);
      case "scrapeStatus": return call<ScrapeStatus>("scrape", "scrape_status");
      case "scrapePresets": return call<{ presets: ScrapePreset[] }>("scrape", "scrape_presets_list").then((result) => result.presets);
      case "scrapeCanaries": return call<{ presets: Array<{ preset: string; configured: boolean }> }>("scrape", "scrape_canary_inventory")
        .then((result) => result.presets.filter((item) => item.configured).map((item) => item.preset));
      case "scrapeQueue": return call<ScrapeQueue>("scrape", "scrape_queue_list", { limit: scrapeQueueLimit });
    }
  }

  private async loadLibrary(call: <T>(pkg: string, name: string, args?: Record<string, unknown>) => Promise<T>): Promise<ContentLibrary> {
    const collections: ContentCollection[] = [];
    for (let offset: number | null = 0; offset !== null && collections.length < 2_000;) {
      const page: { collections: ContentCollection[]; nextOffset: number | null } = await call("content", "collection_list", { limit: 200, offset });
      collections.push(...page.collections);
      offset = page.nextOffset;
    }
    const total = (collection?: string | null) => call<{ total: number }>("content", "item_list", { ...(collection !== undefined ? { collection } : {}), limit: 1 }).then((page) => page.total);
    const [all, ungrouped, ...counts] = await Promise.all([total(), total(null), ...collections.map((collection) => total(collection.slug).catch(() => 0))]);
    return { collections, counts: { all, ungrouped, byCollection: Object.fromEntries(collections.map((collection, index) => [collection.slug, counts[index]])) } };
  }

  private async loadItems(call: <T>(pkg: string, name: string, args?: Record<string, unknown>) => Promise<T>): Promise<ContentItemPage> {
    const scope = this.itemScope;
    const items: ContentItem[] = [];
    let total = 0;
    let nextOffset: number | null = 0;
    for (let page = 0; page < this.itemPages && nextOffset !== null; page++) {
      const result: { items: ContentItem[]; total: number; nextOffset: number | null } = await call("content", "item_list", { ...(scope !== undefined ? { collection: scope } : {}), limit: itemPage, offset: nextOffset });
      items.push(...result.items);
      total = result.total;
      nextOffset = result.nextOffset;
    }
    return { scope, items, total, nextOffset };
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
