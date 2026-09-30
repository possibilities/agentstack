import { loadCatalog } from "./catalog";
import type { AccessSnapshot, CodexToolsStatus } from "./types";
import { Channel } from "./channel";
import { loadResources, mergeHistory } from "./resources";
import { asText, itemKindFor, itemLimit, scopeKey, sha256Hex } from "./content";
import { stageBytes, StageStalled } from "./content-upload";
import type { ContentArtifact, ContentCollection, ContentDocument, ContentItem, ContentItemPage, ContentItemScope, ContentLibrary, ContentTag, ContentUpload } from "./types";
import { scrapeCallError } from "./scrape";
import type { ScrapeCanaryRun, ScrapePreset, ScrapeQueue, ScrapeReplay, ScrapeStatus } from "./types";
import type { AgentBrowserInstallation, AgentBrowserStatus, BrowserController, BrowserHandoff, BrowserProfile, BrowserStatus, BrowserToolchain, HypemanInstallation } from "./types";
import type { Account, AttentionItem, AttentionMessage, AttentionPage, AttentionRun, AttentionStatus, Bot, BotSettings, ChannelStatus, InferModelObservation, InferRequestSummary, Login, Notification, NotificationCounts, NotificationFilter, NotificationPages, ServerResources, ServerStatus, PackageDoc, Resource, ResourceHistoryPage, ResourceHistoryPoint, RoleCatalog, RoleInternalMcp, RoleLaunchPreview, RolePreview, RoleRenderContext, RoleShims, RoleSnapshot, Snapshot, StackEvent, UsageSnapshot, VoiceCall, WorkerAccount, WorkerCatalog, WorkerListItem, WorkerLogin, WorkerRuntime, WorkerStatus } from "./types";
import { acceptCatalog, acceptRoleRead, contextKey, normalizeContext, roleReadOf } from "./roles";
import { brainCallError, jobViews, mergeJobs, submissionLabel, terminalStates, type BrainJobView, type CallError } from "./brain";
import type { BrainAdmission, BrainJob, BrainJobRecord, BrainJobStats, BrainShareState, BrainSource, BrainStats, BrainStatus, BrainTag } from "./types";
import type { ProcRun, ProcScheduleListItem, ProcStatus } from "./types";
import type { SettingsCatalog, SettingsView } from "./types";
import { catalogRequest, readRequest, settingsKey, settingsPackage, type SettingsTarget } from "./settings";
import { loadTree, type HudTree } from "./hud";
import { continueInventory, continueSubscriptions, loadInventory, loadSubscriptions, type StateInventory, type StateSelection, type SubscriptionFilter, type SubscriptionList } from "./state";

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
  /**
   * The Role every Role-scoped resource below reads: the page's selection, set with `selectRole`. Each of them is
   * fenced by this ID as well as by revision, and cleared to a loading state whenever it changes.
   */
  roleId: string | null;
  /** The selected Role, complete with connection definitions, for the operator's editor. */
  role: Resource<RoleSnapshot>;
  rolePreview: Resource<RolePreview>;
  /** What the selected Role's launch receives besides instructions, matched against every known Bot working directory. */
  roleLaunch: Resource<RoleLaunchPreview>;
  /**
   * The rendering context both previews are read with, set with `setRoleContext`. It is the page's, not a Role's:
   * it survives Role selection, changes nothing in any Role, and configures no runtime. `{}` previews what a launch
   * without context renders, which is every Bot and Worker today.
   */
  roleContext: RoleRenderContext;
  /** The `contextKey` each held preview answers, since a preview does not echo its context. */
  roleContextShown: Partial<Record<PreviewKey, string>>;
  /** The internal Stack MCP servers configured now, each with the selected Role's switch. */
  roleInternal: Resource<RoleInternalMcp>;
  /** Cached Codex tool bridge observations; only `checkCodexTools` starts a runtime. */
  codexTools: Resource<CodexToolsStatus>;
  /** Loaded pages of `serve_state_list` for `stateSelection`. Local operator only; a remote session never reads it. */
  stateInventory: Resource<StateInventory>;
  stateSelection: StateSelection;
  /** Loaded pages of durable Bot event subscriptions for `subscriptionFilter`, without read arguments. Local only. */
  subscriptions: Resource<SubscriptionList>;
  subscriptionFilter: SubscriptionFilter;
  /** The Bot Fleet's state window shows. Local only. */
  botStateId: string | null;
  /** Per Bot: bumped on bot_state_changed, lifecycle and queue notices and scoped (re)connects. Bot state views re-read on it. */
  botStateGenerations: Record<string, number>;
  /** Bumped on every `serve_state_changed` and serve (re)connect; open maintenance views re-read what they hold on it. */
  serveStateGeneration: number;
  /** Local-only PATH inventory; no Roles window consumes it until the shim UI is requested. */
  roleShims: Resource<RoleShims>;
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
  browserProfiles: Resource<BrowserProfile[]>;
  /** Last confirmed controller bindings; observations, not liveness. */
  browserControllers: Resource<BrowserController[]>;
  browserHandoffs: Resource<BrowserHandoff[]>;
  browserToolchain: Resource<BrowserToolchain>;
  brainStatus: Resource<BrainStatus>;
  brainStats: Resource<BrainStats>;
  brainTags: Resource<BrainTag[]>;
  brainJobStats: Resource<BrainJobStats>;
  /** The Jobs window's tab and optional Run; `brainJobs.data` says which one its list answers. */
  brainJobView: { view: BrainJobView; run: number | null };
  brainJobs: Resource<{ view: BrainJobView; run: number | null; jobs: BrainJob[] }>;
  /** Diagnostics for jobs someone opened, re-read on each ledger notice. */
  brainJobRecords: Record<number, Resource<BrainJobRecord>>;
  brainSources: Resource<BrainSource[]>;
  /** Bumped on each index_changed notice; the Search and Reader windows compare against it. */
  brainIndexGeneration: number;
  /** The document the Reader shows, and the chunk that led there. `seq` distinguishes repeated requests. */
  brainReader: { seq: number; documentId: number; chunk: { chunk_id: number; start_char: number; end_char: number } | null } | null;
  /** A query another surface asked Search to run. */
  brainQuery: { seq: number; query: string } | null;
  /** Latest known summary per `research-document:<id>` key, from searches, stats and the Reader. */
  brainDocumentRecords: Record<string, Record<string, unknown>>;
  /** Submissions made from this page. Labels exist only here: job reads never return submitted content. */
  brainSubmissions: BrainSubmission[];
  /** proc_schedule_list's page, including removed tombstones. */
  procSchedules: Resource<ProcScheduleListItem[]>;
  /** proc_run_list's newest page and its continuation; older pages stay in the Runs window. */
  procRuns: Resource<{ runs: ProcRun[]; nextCursor: string | null }>;
  procStatus: Resource<ProcStatus>;
  /** Bumped on every proc_schedules_changed notice; Schedule views re-read on it. */
  procScheduleGeneration: number;
  /** Bumped on a watched run's scoped notices and (re)subscription; its window re-reads on it. */
  procRunGenerations: Record<string, number>;
  /** Managed settings views editors watch, by `settingsKey`. Shared saved evidence; drafts stay in each editor. */
  settingsViews: Record<string, Resource<SettingsView>>;
  /** Managed settings catalogs editors watch: `bots`, or `worker:<provider>`. */
  settingsCatalogs: Record<string, Resource<SettingsCatalog>>;
  /** The whole Work hierarchy up to `hudTreeBudget` rows, read as one snapshot-fenced generation. */
  hudTree: Resource<HudTree>;
  hudTreeBudget: number;
  /** Bumped on every hud_changed notice and (re)subscription; HUD views re-read their own projections on it. */
  hudGeneration: number;
  /** Bumped on Worker and Bot invalidations; Work resource views re-read from their first page on it. HUD never relays these. */
  hudResourceGeneration: number;
  /** Bumped on a watched item's scoped work_changed notices and (re)subscription, which include derived ancestors and dependents. */
  hudItemGenerations: Record<string, number>;
};

export type BrainSubmission = { key: string; label: string; kind: "url" | "text"; at: number; pending: boolean; admission: BrainAdmission | null; error: CallError | null; share: BrainShareState | null };

/** A check this page started. `error` is set when the call itself failed; `uncertain` when it may still be running. */
export type ScrapeCheck<T> = { startedAt: number; finishedAt: number | null; args: Record<string, unknown>; result: T | null; error: string | null; uncertain: boolean };

export type SignalRecords = { items: Record<string, AttentionItem>; messages: Record<string, AttentionMessage>; runs: Record<string, AttentionRun> };

export type StackConnections = { packages?: readonly string[]; scopedBots?: boolean };

const authReads = new Set(["account_list", "account_login_current", "account_login_status", "worker_account_list", "worker_account_login_current", "worker_account_login_status"]);

const callMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

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
/** Every Role shim write, settled either way, rereads the listing: it is the only record of what is installed. */
const shimWrites = new Set(["role_shim_create", "role_shim_update", "role_shim_delete"]);
const itemPage = 100;
/** Managed settings writes; each re-reads what it targets once settled, since a lost acknowledgement may still have written. */
const settingsWrites = new Set(["bot_settings_patch", "bot_settings_apply", "worker_settings_patch", "worker_settings_apply"]);
export const contentDocumentLimit = 200;

type ResourceKey = ContentKey | "access" | "server" | "codexTools" | "resources" | "accounts" | "workerAccounts" | "workerRuntimes" | "workerSessions" | "login" | "workerLogins" | "bots" | "botDefaults" | "voice" | "roleCatalog" | "role" | "rolePreview" | "roleLaunch" | "roleInternal" | "roleShims" | "catalog" | "usage" | "inferRequests" | "inferModels" | "notifications" | "notifyCounts" | "signalStatus" | "scrapeStatus" | "scrapePresets" | "scrapeCanaries" | "scrapeQueue"
  | "browserProfiles" | "browserControllers" | "browserHandoffs" | "browserToolchain"
  | "brainStatus" | "brainStats" | "brainTags" | "brainJobStats" | "brainJobs" | "brainSources"
  | "procSchedules" | "procRuns" | "procStatus" | "hudTree";

/** Which reads each browse write can change; each is re-read afterwards, since a lost acknowledgement may still have acted. */
function browseReads(name: string): ResourceKey[] {
  if (name.startsWith("browser_handoff_")) return ["browserHandoffs", "browserProfiles", "browserControllers"];
  if (name.startsWith("browser_profile_")) return ["browserProfiles", "browserToolchain"];
  return ["browserToolchain"];
}
const inferPage = 20;
/** Jobs the Queue window lists; counts cover every job. */
export const scrapeQueueLimit = 200;
/** Jobs read per ledger state for the Jobs window. */
export const brainJobLimit = 200;
/** share_read_states' maximum ID count. */
const brainShareIds = 50;
/** notification_list's maximum page size. */
const notifyPage = 25;

function isNotification(value: unknown): value is Notification {
  return typeof value === "object" && value !== null && "id" in value && "sequence" in value && "dismissedAt" in value;
}

function isRoleSnapshot(value: unknown): value is RoleSnapshot {
  return typeof value === "object" && value !== null && "revision" in value && "categories" in value;
}

function isRoleCatalog(value: unknown): value is RoleCatalog {
  return typeof value === "object" && value !== null && "revision" in value && "roles" in value && "defaultRoleId" in value && "workerDefaultRoleId" in value;
}

function isRoleInternal(value: unknown): value is RoleInternalMcp {
  return typeof value === "object" && value !== null && "revision" in value && "roleId" in value && "servers" in value;
}

/** The resources that read one Role, in the order a selection rereads them. */
const roleKeys = ["role", "rolePreview", "roleLaunch", "roleInternal"] as const;
type RoleKey = typeof roleKeys[number];
type RoleData = RoleSnapshot | RolePreview | RoleLaunchPreview | RoleInternalMcp;
const isRoleKey = (key: ResourceKey): key is RoleKey => (roleKeys as readonly string[]).includes(key);
/** The Role reads that render instructions, and so also depend on the rendering context. */
type PreviewKey = "rolePreview" | "roleLaunch";
const isPreviewKey = (key: ResourceKey): key is PreviewKey => key === "rolePreview" || key === "roleLaunch";
/** Catalog operations answer with the whole catalog, which replaces the held one when it is not older. */
const catalogReplies = new Set(["roles_snapshot", "role_create", "role_set_default", "role_set_worker_default", "role_delete"]);

const maxEvents = 250;
/** Work rows the tree reads before offering to load more. */
export const hudTreePage = 1_000;

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
  /** The scope each in-flight Role-scoped read was started for: its Role, and for previews also the context. */
  private inflightRole = new Map<ResourceKey, string | null>();
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
  private procRunWatchers = new Map<string, number>();
  private procChannels = new Map<string, Channel>();
  private workItemWatchers = new Map<string, number>();
  private workItemChannels = new Map<string, Channel>();
  private statusInflight = new Map<string, Promise<void>>();
  private statusDirty = new Set<string>();
  private settingsWatchers = new Map<string, { target: SettingsTarget; count: number }>();
  private settingsCatalogWatchers = new Map<string, number>();
  /** Settings reads in flight by view or catalog key; a notice during one schedules a single follow-up. */
  private settingsInflight = new Set<string>();
  private settingsDirty = new Set<string>();

  constructor(snapshot: Snapshot) {
    this.state = {
      ...snapshot, status: {}, scoped: {}, events: [], attempt: snapshot.login.data,
      access: { data: null, error: null, at: null },
      workerAttempts: Object.fromEntries((snapshot.workerLogins.data ?? []).map((login) => [login.account, login])),
      workerCatalogs: {}, catalogPending: {}, resourceHistory: {}, botInvalidations: {},
      inferRequests: { data: null, error: null, at: null }, inferModels: { data: null, error: null, at: null },
      notificationFilter: { dismissed: false }, notifications: { data: null, error: null, at: null },
      notifyCounts: { data: null, error: null, at: null }, notificationRecords: {},
      roleId: null, role: { data: null, error: null, at: null }, rolePreview: { data: null, error: null, at: null },
      roleLaunch: { data: null, error: null, at: null }, roleInternal: { data: null, error: null, at: null }, roleShims: { data: null, error: null, at: null },
      codexTools: { data: null, error: null, at: null },
      stateInventory: { data: null, error: null, at: null }, stateSelection: { owners: null, measure: false },
      subscriptions: { data: null, error: null, at: null }, subscriptionFilter: {}, serveStateGeneration: 0,
      botStateId: null, botStateGenerations: {},
      roleContext: {}, roleContextShown: {},
      signalStatus: { data: null, error: null, at: null }, signalGeneration: 0, signalRecords: { items: {}, messages: {}, runs: {} },
      contentDocuments: { data: null, error: null, at: null }, contentTags: { data: null, error: null, at: null },
      contentLibrary: { data: null, error: null, at: null }, contentItems: { data: null, error: null, at: null },
      contentArtifacts: { data: null, error: null, at: null }, contentRoutes: { data: null, error: null, at: null },
      contentGeneration: 0, contentRecords: {}, contentUploads: [], contentItemScope: undefined,
      workerStatuses: {}, workerGenerations: {},
      scrapeStatus: { data: null, error: null, at: null }, scrapePresets: { data: null, error: null, at: null },
      scrapeCanaries: { data: null, error: null, at: null }, scrapeQueue: { data: null, error: null, at: null },
      scrapeChecks: { canary: null, replay: null }, scrapeCompose: null,
      browserProfiles: { data: null, error: null, at: null }, browserControllers: { data: null, error: null, at: null },
      browserHandoffs: { data: null, error: null, at: null }, browserToolchain: { data: null, error: null, at: null },
      brainStatus: { data: null, error: null, at: null }, brainStats: { data: null, error: null, at: null }, brainTags: { data: null, error: null, at: null },
      brainJobStats: { data: null, error: null, at: null }, brainJobView: { view: "attention", run: null }, brainJobs: { data: null, error: null, at: null },
      brainJobRecords: {}, brainSources: { data: null, error: null, at: null }, brainIndexGeneration: 0, brainReader: null, brainQuery: null,
      brainDocumentRecords: {}, brainSubmissions: [],
      procSchedules: { data: null, error: null, at: null }, procRuns: { data: null, error: null, at: null },
      procStatus: { data: null, error: null, at: null }, procScheduleGeneration: 0, procRunGenerations: {},
      settingsViews: {}, settingsCatalogs: {},
      hudTree: { data: null, error: null, at: null }, hudTreeBudget: hudTreePage, hudGeneration: 0, hudResourceGeneration: 0, hudItemGenerations: {},
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
    // State inventories and subscriptions are local operator reads; notices are not replayed, so (re)connect re-reads them.
    open("serve", () => { this.refresh("server"); this.refresh("codexTools"); this.refresh("resources"); this.refreshWatchedHistories(); this.invalidateServeState(); }, (topic) => {
      if (topic === "pids_changed") this.refresh("server");
      if (topic === "codex_tools_changed") this.refresh("codexTools");
      if (topic === "resources_changed") { this.refresh("resources"); this.refreshWatchedHistories(); }
      if (topic === "serve_state_changed") this.invalidateServeState();
    }, this.state.remote ? ["pids_changed", "codex_tools_changed", "resources_changed"] : ["pids_changed", "codex_tools_changed", "resources_changed", "serve_state_changed"], { silent: ["resources_changed"] });
    open("auth", () => { this.refresh("accounts"); this.refresh("workerAccounts"); this.refresh("login"); this.refresh("workerLogins"); }, (topic) => {
      this.refresh("accounts");
      if (topic === "worker_accounts_changed") this.refresh("workerAccounts");
      if (topic === "login_changed") this.refresh("login");
      if (topic === "worker_login_changed") this.refresh("workerLogins");
    }, ["accounts_changed", "login_changed", "worker_accounts_changed", "worker_login_changed"]);
    open("bots", () => { this.refresh("bots"); this.refresh("botDefaults"); this.refresh("voice"); this.refreshSettings("bots"); this.bumpHudResources(); }, (topic) => {
      if (topic === "bots_changed") { this.refresh("bots"); this.refreshSettings("bots", "bot"); this.bumpHudResources(); }
      if (topic === "defaults_changed") { this.refresh("botDefaults"); this.refreshSettings("bots"); }
      if (topic === "voice_changed") { this.refresh("voice"); this.refreshSettings("bots", "bot"); }
    }, ["bots_changed", "defaults_changed", "voice_changed"]);
    // Cards and the Workers list use the global inventory invalidation. Worker windows
    // subscribe to worker_progress + worker_changed scoped by Worker ID (watchWorker).
    open("worker", () => { this.refresh("workerRuntimes"); this.refresh("workerSessions"); this.reconcileCatalogs(true); this.refreshSettings("worker"); this.bumpHudResources(); }, () => {
      this.refresh("workerRuntimes"); this.refresh("workerSessions"); this.reconcileCatalogs(true); this.refreshSettings("worker"); this.bumpHudResources();
    }, ["workers_changed"]);
    open("usage", () => this.refresh("usage"), () => this.refresh("usage"), ["usage_changed"]);
    // Reads only: discovery (infer_discover) and requests (infer_start) are explicit actions.
    open("infer", () => { this.refresh("inferRequests"); this.refresh("inferModels"); }, () => {
      this.refresh("inferRequests"); this.refresh("inferModels");
    }, ["infer_changed"]);
    // Signal publishes signal_changed after every source scan while processing is enabled. The
    // status read is cheap; list views re-read only when its changeSeq says records may have changed.
    open("signal", () => this.refresh("signalStatus"), () => this.refresh("signalStatus"), ["signal_changed"], { silent: ["signal_changed"] });
    // role_changed is an invalidation notice: the catalog changed, and so may the selected Role.
    const roleReads = () => { this.refresh("roleCatalog"); this.refreshRole(); };
    open("roles", () => { roleReads(); if (!this.state.remote) this.refresh("roleShims"); }, (topic) => {
      if (topic === "role_shims_changed") this.refresh("roleShims");
      else roleReads();
    }, this.state.remote ? ["role_changed"] : ["role_changed", "role_shims_changed"]);
    const notify = () => { this.refresh("notifications"); this.refresh("notifyCounts"); this.refreshWatchedNotifications(); };
    open("notify", notify, notify, ["notify_changed"]);
    open("api", () => this.refresh("catalog"));
    open("access", () => this.refresh("access"), () => this.refresh("access"), ["access_changed"]);
    // content_changed is an invalidation notice; windows re-read what they show from contentGeneration.
    open("content", () => this.invalidateContent(), () => this.invalidateContent(), ["content_changed"]);
    // Presets and executables have no change event; they are read on (re)connect and on request.
    // scrape_queue_changed is an invalidation notice only, so the queue is re-read after each.
    open("scrape", () => { this.refreshScrape(); this.refresh("scrapeQueue"); }, () => this.refresh("scrapeQueue"), ["scrape_queue_changed"]);
    // Browse notices are invalidations only. Legacy disposable reservations have no UI, so their topic is not subscribed.
    open("browse", this.refreshBrowse, (topic) => {
      if (topic === "browser_handoffs_changed") this.refresh("browserHandoffs");
      if (topic === "browser_profiles_changed") { this.refresh("browserProfiles"); this.refresh("browserControllers"); }
      if (topic === "browser_system_changed") this.refresh("browserToolchain");
    }, ["browser_handoffs_changed", "browser_profiles_changed", "browser_system_changed"]);
    // Brain's notices are invalidations only. Ledger notices follow every job transition while
    // ingestion runs, so they stay out of the activity log.
    open("brain", () => { this.refreshBrainLedger(); this.refresh("brainSources"); this.invalidateBrainIndex(); }, (topic) => {
      if (topic === "jobs_changed") this.refreshBrainLedger();
      if (topic === "sources_changed") this.refresh("brainSources");
      if (topic === "index_changed") this.invalidateBrainIndex();
    }, ["jobs_changed", "sources_changed", "index_changed"], { silent: ["jobs_changed"] });
    // Proc is server-local: process output and schedule definitions never reach a remote session.
    // proc_output_changed fires once per line; only a scoped Run window subscribes to it.
    if (!this.state.remote) open("proc", () => this.refreshProc(), (topic) => {
      if (topic === "proc_schedules_changed") {
        this.refresh("procSchedules");
        this.refresh("procStatus");
        this.set({ procScheduleGeneration: this.state.procScheduleGeneration + 1 });
      } else if (topic === "proc_runs_changed") {
        this.refresh("procRuns");
        this.refresh("procStatus");
      }
    }, ["proc_schedules_changed", "proc_runs_changed"], { silent: ["proc_schedules_changed"] });
    // hud_changed invalidates the whole shared view; (re)subscription resnapshots it, since notices are not replayed.
    // Item-scoped work_changed subscriptions belong to the views that watch one item (watchWorkItem).
    open("hud", () => this.invalidateHud(), () => this.invalidateHud(), ["hud_changed"]);
    this.reconcileScoped();
    for (const id of this.workerWatchers.keys()) this.openWorkerChannel(id);
    for (const id of this.procRunWatchers.keys()) this.openProcChannel(id);
    for (const id of this.workItemWatchers.keys()) this.openWorkItemChannel(id);
  }

  stop(): void {
    this.catalogDirty.clear();
    for (const id of this.catalogAvailable) this.catalogGeneration.set(id, (this.catalogGeneration.get(id) ?? 0) + 1);
    for (const channel of [...this.main.values(), ...this.scopedChannels.values(), ...this.workerChannels.values(), ...this.procChannels.values(), ...this.workItemChannels.values()]) channel.dispose();
    this.main.clear();
    this.scopedChannels.clear();
    this.workerChannels.clear();
    this.procChannels.clear();
    this.workItemChannels.clear();
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
        this.set({ remote: { ...current, scope: data.data.scopes.includes("ui:control") ? "control" : "view", scopes: data.data.scopes } });
      } catch { /* the gateway still denies stale permissions */ }
    })().finally(() => { this.remoteInflight = null; });
    return this.remoteInflight;
  };

  /** Call any operation on a Package API's main channel. Auth mutations refresh accounts and sign-in state; dial/hangup refresh voice state. Speech submission changes no call state. */
  call = async <T>(pkg: string, name: string, args: Record<string, unknown> = {}): Promise<T> => {
    if (this.state.remote?.scope === "view") {
      const annotation = this.state.catalog.data?.find(doc => doc.name === pkg)?.operations.find(operation => operation.name === name)?.annotations;
      if (annotation && annotation.readOnlyHint !== true) throw new Error("Read-only remote session: this operation requires ui:control");
    }
    if (this.state.remote && ["access", "auth", "browse", "proc"].includes(pkg)) throw new Error(`${pkg} controls are available only on the local UI`);
    if (this.state.remote && pkg === "bots" && name.startsWith("voice_")) throw new Error("Voice calls are available only on the local UI");
    if (this.state.remote && pkg === "roles" && name.startsWith("role_shim_")) throw new Error("Role shims are available only on the local UI");
    const channel = this.main.get(pkg);
    if (!channel || channel.status !== "open") throw new Error(`${pkg} WebSocket is not connected`);
    const request = settingsWrites.has(name) ? channel.call<T>(name, args).finally(() => this.settingsSettled(pkg, name, args)) : channel.call<T>(name, args);
    const result = await (pkg === "bots" ? request.finally(() => {
      // A lost mutation acknowledgement may still have changed the Bot. Re-read,
      // never replay the operation automatically.
      if (pkg === "bots" && ["bot_start", "bot_stop", "bot_assign", "bot_remove", "bot_settings_patch", "bot_settings_apply", "chat_open"].includes(name)) this.refresh("bots");
      if (pkg === "bots" && (name === "bot_defaults_set" || name === "bot_settings_patch" && !args.id)) this.refresh("botDefaults");
      if (pkg === "bots" && name === "bot_defaults_set") this.refreshSettings("bots");
    }) : pkg === "access" && name !== "access_snapshot" ? request.finally(() => this.refresh("access"))
      // A lost acknowledgement may still have written; re-read either way, never replay.
      : pkg === "content" && contentWrites.has(name) ? request.finally(() => this.invalidateContent())
      // A refused shim write (stale, foreign or colliding) changed nothing, but the listing it was built from is out of date.
      : pkg === "roles" && shimWrites.has(name) ? request.finally(() => this.refresh("roleShims")) : request);
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
    if (pkg === "roles") this.applyRoleReply(name, result);
    return result;
  };

  /**
   * Take a Roles reply the page did not ask `refresh` for, under the same fences. Only the operator read includes
   * definitions, so a write's compact receipt is never merged into held data: writes reread instead.
   */
  private applyRoleReply(name: string, result: unknown): void {
    const now = Date.now();
    if (name === "role_editor_snapshot" && isRoleSnapshot(result)) {
      if (!acceptRoleRead(this.state.roleId, this.state.role.data && roleReadOf(this.state.role.data), roleReadOf(result))) return;
      this.set({ role: { data: result, error: null, at: now } });
      // Whatever a write changed shows in the derived views and in this Role's revision in the catalog.
      this.refresh("roleCatalog"); this.refresh("rolePreview"); this.refresh("roleLaunch"); this.refresh("roleInternal");
    } else if (name === "role_internal_mcp_list" && isRoleInternal(result)) {
      if (acceptRoleRead(this.state.roleId, this.state.roleInternal.data && roleReadOf(this.state.roleInternal.data), roleReadOf(result))) this.set({ roleInternal: { data: result, error: null, at: now } });
    } else if (catalogReplies.has(name) && isRoleCatalog(result)) {
      if (acceptCatalog(this.state.roleCatalog.data, result)) this.applyCatalog({ data: result, error: null, at: now });
    }
  }

  /** Hold a catalog. A selected Role it no longer lists loses its data at once; one it lists gets any read still missing. */
  private applyCatalog(next: Resource<RoleCatalog>): void {
    this.set({ roleCatalog: next });
    if (!next.data) return;
    const { roleId } = this.state;
    if (roleId && !next.data.roles.some((role) => role.id === roleId)) {
      const empty = { data: null, error: null, at: null };
      this.set({ role: empty, rolePreview: empty, roleLaunch: empty, roleInternal: empty });
    } else if (roleId) for (const key of roleKeys) if (!this.state[key].data) this.refresh(key);
  }

  /**
   * Point every Role-scoped resource at another Role (or none). What was loaded for the old one is cleared
   * rather than shown under the new one's name, and a read still in flight for it is dropped when it lands.
   */
  selectRole = (roleId: string | null): void => {
    if (roleId === this.state.roleId) return;
    const empty = { data: null, error: null, at: null };
    this.set({ roleId, role: empty, rolePreview: empty, roleLaunch: empty, roleInternal: empty });
    this.refreshRole();
  };

  private refreshRole(): void {
    for (const key of roleKeys) this.refresh(key);
  }

  /**
   * Preview the selected Role in another rendering context. Only the two previews are reread; the held ones stay
   * shown until the new context's answers land, and an answer for any other context is dropped.
   */
  setRoleContext = (context: RoleRenderContext): void => {
    const next = normalizeContext(context);
    if (contextKey(next) === contextKey(this.state.roleContext)) return;
    this.set({ roleContext: next });
    this.refresh("rolePreview");
    this.refresh("roleLaunch");
  };

  /** What a Role-scoped read is for: its Role, plus the rendering context for the previews. */
  private readScope(key: RoleKey): string | null {
    const { roleId } = this.state;
    return roleId !== null && isPreviewKey(key) ? `${roleId}\n${contextKey(this.state.roleContext)}` : roleId;
  }

  /** The context argument for a preview read; omitted when empty, as a launch without context omits it. */
  private contextArgs(): { context?: RoleRenderContext } {
    return Object.keys(this.state.roleContext).length ? { context: this.state.roleContext } : {};
  }

  /** Whether the selected Role exists as far as the loaded catalog says; reads wait until it does. */
  private roleReadable(): boolean {
    const { roleId, roleCatalog } = this.state;
    return roleId !== null && Boolean(roleCatalog.data?.roles.some((role) => role.id === roleId));
  }

  /** Ask the Extract window to use a preset; it keeps the URL already entered. */
  composeScrape = (preset: string, mode: "page" | "links"): void => {
    this.set({ scrapeCompose: { seq: (this.state.scrapeCompose?.seq ?? 0) + 1, preset, mode } });
  };

  /** A browse write. What it can change is re-read either way; nothing is resent automatically. */
  browse = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
    this.call<T>("browse", name, args).finally(() => { for (const key of browseReads(name)) this.refresh(key); });

  /** Re-read everything the Browse space shows. */
  refreshBrowse = (): void => {
    for (const key of ["browserProfiles", "browserControllers", "browserHandoffs", "browserToolchain"] as const) this.refresh(key);
  };

  /**
   * Start one server-side check of the Codex tool bridges. It returns on admission; the result arrives
   * with `codex_tools_changed`. A check already running is joined, never repeated.
   */
  checkCodexTools = (chromeBrowser = false): Promise<void> =>
    this.call<{ admitted: boolean; status: CodexToolsStatus }>("serve", "serve_codex_tools_check", { chromeBrowser })
      .then((result) => { this.set({ codexTools: { data: result.status, error: null, at: Date.now() } }); })
      .finally(() => this.refresh("codexTools"));

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

  private refreshBrainLedger(): void {
    this.refresh("brainStatus"); this.refresh("brainJobStats"); this.refresh("brainJobs");
    for (const id of Object.keys(this.state.brainJobRecords)) void this.loadBrainJob(Number(id));
    void this.refreshBrainSubmissions();
  }

  private invalidateBrainIndex(): void {
    this.refresh("brainStats"); this.refresh("brainTags");
    this.set({ brainIndexGeneration: this.state.brainIndexGeneration + 1 });
  }

  setBrainJobView = (view: BrainJobView, run: number | null = null): void => {
    this.set({ brainJobView: { view, run } });
    this.refresh("brainJobs");
  };

  /** Read one job's sanitized diagnostics; it is then re-read on every ledger notice. At most 20 are kept. */
  loadBrainJob = async (id: number): Promise<void> => {
    try {
      const data = await this.call<BrainJobRecord>("brain", "jobs_show", { "job-id": id });
      const kept = Object.entries(this.state.brainJobRecords).filter(([key]) => Number(key) !== id).slice(-19);
      this.set({ brainJobRecords: { ...Object.fromEntries(kept), [id]: { data, error: null, at: Date.now() } } });
    } catch (error) {
      const previous = this.state.brainJobRecords[id];
      this.set({ brainJobRecords: { ...this.state.brainJobRecords, [id]: { data: previous?.data ?? null, error: error instanceof Error ? error.message : String(error), at: Date.now() } } });
    }
  };

  /**
   * Retry, cancel or exclude one job. Each appends a transition with this reason; the ledger is
   * re-read either way, since a lost acknowledgement may still have applied it.
   */
  brainJobAction = <T>(action: "retry" | "cancel" | "exclude", id: number, reason: string): Promise<T> =>
    this.call<T>("brain", `jobs_${action}`, { "job-id": id, reason: reason.trim() || undefined, actor: "ui" }).finally(() => this.refreshBrainLedger());

  /** Pause or resume a Research source with a reason recorded on its audit evidence. */
  brainSourceAction = <T>(action: "pause" | "resume", id: string, reason: string): Promise<T> =>
    this.call<T>("brain", `sources_${action}`, { "source-id": id, reason: reason.trim() || undefined, actor: "ui" }).finally(() => this.refresh("brainSources"));

  /** Admit discovery Runs for one source or every due one, or report what would be admitted. */
  brainSync = <T>(args: { sourceId?: string; due?: boolean; dryRun?: boolean }): Promise<T> =>
    this.call<T>("brain", "sources_sync", { "source-id": args.sourceId, due: args.due || undefined, "dry-run": args.dryRun || undefined })
      .finally(() => { this.refresh("brainSources"); this.refreshBrainLedger(); });

  /** Delete one Research document permanently. The index is re-read either way. */
  brainDelete = <T>(documentId: number): Promise<T> =>
    this.call<T>("brain", "delete", { "document-id": documentId, confirm: "delete" }).finally(() => {
      if (this.state.brainReader?.documentId === documentId) this.set({ brainReader: null });
      this.invalidateBrainIndex(); this.refreshBrainLedger();
    });

  /** Show a document in the Reader, optionally at the chunk that led there. */
  openBrainDocument = (documentId: number, chunk: { chunk_id: number; start_char: number; end_char: number } | null = null): void => {
    this.set({ brainReader: { seq: (this.state.brainReader?.seq ?? 0) + 1, documentId, chunk } });
  };

  /** Ask the Search window to run a query. */
  searchBrain = (query: string): void => {
    this.set({ brainQuery: { seq: (this.state.brainQuery?.seq ?? 0) + 1, query } });
  };

  /** Keep a document summary for the inspector; bodies are never kept here. */
  rememberBrainDocuments = (records: Array<Record<string, unknown> & { document_id: number }>): void => {
    if (!records.length) return;
    const next = { ...this.state.brainDocumentRecords };
    for (const { content: _content, snippet: _snippet, ...record } of records) next[`research-document:${record.document_id}`] = { ...next[`research-document:${record.document_id}`], ...record };
    this.set({ brainDocumentRecords: next });
  };

  /**
   * Admit a URL or text. The idempotency key belongs to the draft, so a repeated or lost request
   * resolves to the same job instead of a second one. Nothing is resent automatically.
   */
  brainSubmit = async (draft: { key: string; source: string; kind: "url" | "text"; title: string; tags: string[]; collection: string; notes: string }): Promise<BrainSubmission> => {
    const entry: BrainSubmission = { key: draft.key, label: submissionLabel(draft.source, draft.kind, draft.title), kind: draft.kind, at: Date.now(), pending: true, admission: null, error: null, share: null };
    const put = (next: BrainSubmission) => this.set({ brainSubmissions: [next, ...this.state.brainSubmissions.filter((item) => item.key !== next.key)].slice(0, 50) });
    put(entry);
    try {
      const admission = await this.call<BrainAdmission>("brain", "submit", {
        source: draft.source, kind: draft.kind, ingress: "ui", "idempotency-key": draft.key,
        title: draft.title.trim() || undefined, tag: draft.tags.length ? draft.tags : undefined,
        collection: draft.collection.trim() ? [draft.collection.trim()] : undefined, notes: draft.notes.trim() || undefined,
      });
      const done = { ...entry, pending: false, admission };
      put(done);
      void this.refreshBrainSubmissions();
      return done;
    } catch (error) {
      const failed = { ...entry, pending: false, error: brainCallError(error) };
      put(failed);
      this.refreshBrainLedger();
      return failed;
    } finally {
      this.refresh("brainJobStats"); this.refresh("brainJobs");
    }
  };

  dismissBrainSubmission = (key: string): void => {
    this.set({ brainSubmissions: this.state.brainSubmissions.filter((item) => item.key !== key) });
  };

  /** Follow this page's admitted jobs until they reach a terminal state. */
  private async refreshBrainSubmissions(): Promise<void> {
    const ids = [...new Set(this.state.brainSubmissions.flatMap((item) => item.admission && item.admission.status !== "already_indexed" && !(item.share && terminalStates.has(item.share.state)) ? [item.admission.job_id] : []))].slice(0, brainShareIds);
    if (!ids.length) return;
    try {
      const { shares } = await this.call<{ shares: BrainShareState[] }>("brain", "share_read_states", { ids });
      const byJob = new Map(shares.map((share) => [share.job_id, share]));
      this.set({ brainSubmissions: this.state.brainSubmissions.map((item) => {
        const share = item.admission && item.admission.status !== "already_indexed" ? byJob.get(item.admission.job_id) : undefined;
        return share ? { ...item, share } : item;
      }) });
    } catch { /* the next ledger notice reads again */ }
  }

  /** Explicit infer actions. The ledger and model cache are re-read after each attempt, since a lost acknowledgement may still have admitted it. */
  infer = <T>(name: "infer_start" | "infer_discover", args: Record<string, unknown>): Promise<T> => {
    const refresh = () => this.refresh(name === "infer_start" ? "inferRequests" : "inferModels");
    return this.call<T>("infer", name, args).finally(refresh);
  };
  /** Read a Signal list and remember its records for links and inspection. */
  readSignal = async <T>(name: string, args: Record<string, unknown> = {}): Promise<T> => {
    const generation = this.state.signalStatus.data?.contentGeneration;
    const result = await this.call<T>("signal", name, args);
    if (generation !== this.state.signalStatus.data?.contentGeneration) throw new Error("Signal content changed; refresh this view");
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

  /** A fresh read of one Role that starts now, e.g. after a write or a stale-revision refusal. It is applied like any read if that Role is still selected, and returned either way. */
  reloadRole = (roleId: string): Promise<RoleSnapshot> => this.call<RoleSnapshot>("roles", "role_editor_snapshot", { roleId });
  /** The same for the internal MCP list, whose revision is the Role's. */
  reloadRoleInternal = (roleId: string): Promise<RoleInternalMcp> => this.call<RoleInternalMcp>("roles", "role_internal_mcp_list", { roleId });
  /** The same for the catalog, whose revision is its own. */
  reloadRoleCatalog = (): Promise<RoleCatalog> => this.call<RoleCatalog>("roles", "roles_snapshot");

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
        this.set({ notifications: { data: { filter, entries: [...current.entries, ...page.entries.filter((item) => !known.has(item.id))].map(item => this.state.notificationRecords[item.id] ?? item), nextCursor: page.nextCursor }, error: null, at: Date.now() } });
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
    if (entries.length) this.set({ notificationRecords: { ...this.state.notificationRecords, ...Object.fromEntries(entries.map((item) => {
      const held = this.state.notificationRecords[item.id];
      return [item.id, held?.contentClearedAt ? held : item];
    })) } });
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
    const run = this.call<ResourceHistoryPage>("serve", "serve_resource_history", args)
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
        this.readSettings(`worker:${id}`);
      },
      onNotice: (topic) => {
        if (this.workerChannels.get(id) !== channel) return;
        this.bumpWorker(id);
        if (topic === "worker_changed") this.readWorkerStatus(id);
        // Progress also carries native settings observations; reads coalesce while it streams.
        this.readSettings(`worker:${id}`);
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

  private refreshProc(): void {
    this.refresh("procSchedules");
    this.refresh("procRuns");
    this.refresh("procStatus");
  }

  /**
   * Reference-counted scoped subscription to one run's proc_output_changed and
   * proc_runs_changed notices. Every notice and (re)subscription bumps that run's
   * generation, since missed notices are not replayed; the Run window re-reads
   * the record and continues output from its last seq on each bump.
   */
  watchProcRun = (id: string): (() => void) => {
    const watchers = (this.procRunWatchers.get(id) ?? 0) + 1;
    this.procRunWatchers.set(id, watchers);
    if (watchers === 1) this.openProcChannel(id);
    return () => {
      const remaining = (this.procRunWatchers.get(id) ?? 0) - 1;
      if (remaining > 0) { this.procRunWatchers.set(id, remaining); return; }
      this.procRunWatchers.delete(id);
      this.procChannels.get(id)?.dispose();
      this.procChannels.delete(id);
      if (this.state.procRunGenerations[id]) {
        const procRunGenerations = { ...this.state.procRunGenerations };
        delete procRunGenerations[id];
        this.set({ procRunGenerations });
      }
    };
  };

  private openProcChannel(id: string): void {
    const url = this.state.endpoints.proc;
    if (!url || this.state.remote || this.procChannels.has(id)) return;
    const channel = new Channel(url, "proc", {
      onOpen: () => { if (this.procChannels.get(id) === channel) this.bumpProcRun(id); },
      onNotice: () => { if (this.procChannels.get(id) === channel) this.bumpProcRun(id); },
    });
    this.procChannels.set(id, channel);
    channel.subscribe(["proc_output_changed", "proc_runs_changed"], id).connect();
  }

  private bumpProcRun(id: string): void {
    this.set({ procRunGenerations: { ...this.state.procRunGenerations, [id]: (this.state.procRunGenerations[id] ?? 0) + 1 } });
  }

  /**
   * Reference-counted watch of one managed settings view. Every editor of a target shares the saved view and
   * its evidence; each keeps its own draft. A Worker view also holds that Worker's scoped subscription.
   */
  watchSettings = (target: SettingsTarget): (() => void) => {
    const key = settingsKey(target);
    const watcher = this.settingsWatchers.get(key);
    this.settingsWatchers.set(key, { target, count: (watcher?.count ?? 0) + 1 });
    const unwatchWorker = target.kind === "worker" ? this.watchWorker(target.id) : null;
    if (!watcher) this.readSettings(key);
    return () => {
      unwatchWorker?.();
      const current = this.settingsWatchers.get(key);
      if (current && current.count > 1) { this.settingsWatchers.set(key, { ...current, count: current.count - 1 }); return; }
      this.settingsWatchers.delete(key);
      this.settingsDirty.delete(key);
      if (this.state.settingsViews[key]) {
        const settingsViews = { ...this.state.settingsViews };
        delete settingsViews[key];
        this.set({ settingsViews });
      }
    };
  };

  /** Reference-counted watch of a settings catalog; its application defaults change with the defaults document. */
  watchSettingsCatalog = (key: string): (() => void) => {
    const count = (this.settingsCatalogWatchers.get(key) ?? 0) + 1;
    this.settingsCatalogWatchers.set(key, count);
    if (count === 1) this.readSettingsCatalog(key);
    return () => {
      const remaining = (this.settingsCatalogWatchers.get(key) ?? 0) - 1;
      if (remaining > 0) { this.settingsCatalogWatchers.set(key, remaining); return; }
      this.settingsCatalogWatchers.delete(key);
      this.settingsDirty.delete(`catalog:${key}`);
      if (this.state.settingsCatalogs[key]) {
        const settingsCatalogs = { ...this.state.settingsCatalogs };
        delete settingsCatalogs[key];
        this.set({ settingsCatalogs });
      }
    };
  };

  /** Re-read every watched view (optionally of one kind) and catalog of a package. */
  private refreshSettings(pkg: "bots" | "worker", kind?: SettingsTarget["kind"]): void {
    for (const [key, { target }] of this.settingsWatchers) if (settingsPackage(target) === pkg && (!kind || target.kind === kind)) this.readSettings(key);
    if (!kind) for (const key of this.settingsCatalogWatchers.keys()) if ((key === "bots") === (pkg === "bots")) this.readSettingsCatalog(key);
  }

  /** A settings write settled either way: its target, and for a defaults edit the catalogs and views quoting it, are re-read. */
  private settingsSettled(pkg: string, name: string, args: Record<string, unknown>): void {
    if (pkg === "bots") {
      if (typeof args.id === "string") this.readSettings(`bot:${args.id}`);
      else this.refreshSettings("bots");
      return;
    }
    const target = (name === "worker_settings_apply" ? { id: args.id } : args.target) as { id?: unknown; provider?: unknown } | undefined;
    if (typeof target?.id === "string") this.readSettings(`worker:${target.id}`);
    else this.refreshSettings("worker");
  }

  private readSettings(key: string): void {
    const watcher = this.settingsWatchers.get(key);
    if (!watcher) return;
    if (this.settingsInflight.has(key)) { this.settingsDirty.add(key); return; }
    this.settingsInflight.add(key);
    const { pkg, name, args } = readRequest(watcher.target);
    void this.call<SettingsView>(pkg, name, args)
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state.settingsViews[key]?.data ?? null, error: error.message, at: Date.now() }))
      .then((next) => { if (this.settingsWatchers.has(key)) this.set({ settingsViews: { ...this.state.settingsViews, [key]: next } }); })
      .finally(() => {
        this.settingsInflight.delete(key);
        if (this.settingsDirty.delete(key)) this.readSettings(key);
      });
  }

  private readSettingsCatalog(key: string): void {
    if (!this.settingsCatalogWatchers.has(key)) return;
    const flight = `catalog:${key}`;
    if (this.settingsInflight.has(flight)) { this.settingsDirty.add(flight); return; }
    this.settingsInflight.add(flight);
    const { pkg, name, args } = catalogRequest(key);
    void this.call<SettingsCatalog>(pkg, name, args)
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state.settingsCatalogs[key]?.data ?? null, error: error.message, at: Date.now() }))
      .then((next) => { if (this.settingsCatalogWatchers.has(key)) this.set({ settingsCatalogs: { ...this.state.settingsCatalogs, [key]: next } }); })
      .finally(() => {
        this.settingsInflight.delete(flight);
        if (this.settingsDirty.delete(flight)) this.readSettingsCatalog(key);
      });
  }

  /**
   * A HUD collaboration write. The hierarchy is re-read either way, since a lost acknowledgement may
   * still have applied it. Nothing is resent here: the caller keeps the requestId and input for an
   * explicit retry of the same request.
   */
  hud = <T>(name: string, args: Record<string, unknown>): Promise<T> =>
    this.call<T>("hud", name, args).finally(() => this.refresh("hudTree"));

  /** Read more of a hierarchy larger than the loaded rows; the whole tree is re-read as one generation. */
  loadMoreHudTree = (): void => {
    this.set({ hudTreeBudget: this.state.hudTreeBudget + hudTreePage });
    this.refresh("hudTree");
  };

  private invalidateHud(): void {
    this.refresh("hudTree");
    this.set({ hudGeneration: this.state.hudGeneration + 1 });
  }

  private bumpHudResources(): void {
    this.set({ hudResourceGeneration: this.state.hudResourceGeneration + 1 });
  }

  /**
   * Reference-counted scoped subscription to one Work item's work_changed notices. Every notice and
   * (re)subscription bumps its generation, since missed notices are not replayed. An ancestor or
   * dependent notice need not mean the item's stored revision changed; readers compare revisions.
   */
  watchWorkItem = (id: string): (() => void) => {
    const watchers = (this.workItemWatchers.get(id) ?? 0) + 1;
    this.workItemWatchers.set(id, watchers);
    if (watchers === 1) this.openWorkItemChannel(id);
    return () => {
      const remaining = (this.workItemWatchers.get(id) ?? 0) - 1;
      if (remaining > 0) { this.workItemWatchers.set(id, remaining); return; }
      this.workItemWatchers.delete(id);
      this.workItemChannels.get(id)?.dispose();
      this.workItemChannels.delete(id);
      if (this.state.hudItemGenerations[id]) {
        const hudItemGenerations = { ...this.state.hudItemGenerations };
        delete hudItemGenerations[id];
        this.set({ hudItemGenerations });
      }
    };
  };

  private openWorkItemChannel(id: string): void {
    const url = this.state.endpoints.hud;
    if (!url || this.workItemChannels.has(id)) return;
    const bump = () => {
      if (this.workItemChannels.get(id) !== channel) return;
      this.set({ hudItemGenerations: { ...this.state.hudItemGenerations, [id]: (this.state.hudItemGenerations[id] ?? 0) + 1 } });
    };
    const channel = new Channel(url, "hud", { onOpen: bump, onNotice: bump });
    this.workItemChannels.set(id, channel);
    channel.subscribe(["work_changed"], id).connect();
  }

  dismissWorkerAttempt = (accountId: string): void => {
    if (!this.state.workerAttempts[accountId]) return;
    const workerAttempts = { ...this.state.workerAttempts };
    delete workerAttempts[accountId];
    this.set({ workerAttempts });
  };

  private stateSeq = 0;
  private subscriptionSeq = 0;

  private invalidateServeState(): void {
    if (this.state.remote) return;
    this.set({ serveStateGeneration: this.state.serveStateGeneration + 1 });
    void this.refreshStateInventory();
    void this.refreshSubscriptions();
  }

  /** Show one Bot in Fleet's state window. */
  selectBotState = (id: string | null): void => { this.set({ botStateId: id }); };

  private bumpBotState(id: string): void {
    this.set({ botStateGenerations: { ...this.state.botStateGenerations, [id]: (this.state.botStateGenerations[id] ?? 0) + 1 } });
  }

  /** Choose owners and measurement; held pages belong to the previous selection and are dropped at once. */
  selectStateInventory = (selection: StateSelection): Promise<void> => {
    this.set({ stateSelection: selection, stateInventory: { data: null, error: null, at: null } });
    return this.refreshStateInventory();
  };

  /** Re-read the first page of the current selection. A result from an older read never replaces a newer one. */
  refreshStateInventory = async (): Promise<void> => {
    if (this.state.remote) return;
    const seq = ++this.stateSeq, selection = this.state.stateSelection;
    try {
      const data = await loadInventory((name, args) => this.call("serve", name, args), selection);
      if (seq === this.stateSeq) this.set({ stateInventory: { data, error: null, at: Date.now() } });
    } catch (error) {
      if (seq === this.stateSeq) this.set({ stateInventory: { ...this.state.stateInventory, error: callMessage(error) } });
    }
  };

  /** The next page of the held observation, restarting from the first page when the observation changed. */
  moreStateInventory = async (): Promise<void> => {
    const held = this.state.stateInventory.data;
    if (!held || held.nextOffset === null || this.state.remote) return;
    const seq = ++this.stateSeq;
    try {
      const data = await continueInventory((name, args) => this.call("serve", name, args), held);
      if (seq === this.stateSeq) this.set({ stateInventory: { data, error: null, at: Date.now() } });
    } catch (error) {
      if (seq === this.stateSeq) this.set({ stateInventory: { ...this.state.stateInventory, error: callMessage(error) } });
    }
  };

  filterSubscriptions = (filter: SubscriptionFilter): Promise<void> => {
    this.set({ subscriptionFilter: filter, subscriptions: { data: null, error: null, at: null } });
    return this.refreshSubscriptions();
  };

  refreshSubscriptions = async (): Promise<void> => {
    if (this.state.remote) return;
    const seq = ++this.subscriptionSeq, filter = this.state.subscriptionFilter;
    try {
      const data = await loadSubscriptions((name, args) => this.call("serve", name, args), filter);
      if (seq === this.subscriptionSeq) this.set({ subscriptions: { data, error: null, at: Date.now() } });
    } catch (error) {
      if (seq === this.subscriptionSeq) this.set({ subscriptions: { ...this.state.subscriptions, error: callMessage(error) } });
    }
  };

  moreSubscriptions = async (): Promise<void> => {
    const held = this.state.subscriptions.data;
    if (!held || held.nextOffset === null || this.state.remote) return;
    const seq = ++this.subscriptionSeq;
    try {
      const data = await continueSubscriptions((name, args) => this.call("serve", name, args), held);
      if (seq === this.subscriptionSeq) this.set({ subscriptions: { data, error: null, at: Date.now() } });
    } catch (error) {
      if (seq === this.subscriptionSeq) this.set({ subscriptions: { ...this.state.subscriptions, error: callMessage(error) } });
    }
  };

  /**
   * Remove one exact subscription at the revision the operator saw. A lost acknowledgement may still have removed
   * it, so the list is re-read either way; the same absent ID answers `removed: false`.
   */
  removeSubscription = (id: string, expectedRevision: string): Promise<{ id: string; removed: boolean }> =>
    this.call<{ id: string; removed: boolean }>("serve", "serve_subscription_remove", { id, expectedRevision }).finally(() => { void this.refreshSubscriptions(); });

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
    // Role reads wait for a selected Role the catalog lists; the catalog's arrival and a selection start them.
    if (isRoleKey(key) && !this.roleReadable()) return;
    // A read still in flight for another Role or context does not hold up this one; it is dropped when it lands.
    if (this.inflight.has(key) && (!isRoleKey(key) || this.inflightRole.get(key) === this.readScope(key))) {
      this.dirty.add(key);
      return;
    }
    // The Role (and context) a Role-scoped read was started for; its result belongs to no other.
    const scope = isRoleKey(key) ? this.readScope(key) : null;
    const shown = isPreviewKey(key) ? contextKey(this.state.roleContext) : null;
    const run = this.load(key)
      .then((data) => ({ data, error: null, at: Date.now() }), (error: Error) => ({ data: this.state[key]?.data ?? null, error: error.message, at: Date.now() }))
      .then((next) => {
        if (isRoleKey(key)) {
          // Selection or context moved on, or the Role vanished, while this read was in flight: drop it, data or
          // error alike. The read started for the new selection or context serves it.
          if (scope !== this.readScope(key) || !this.roleReadable()) return;
          // A response for any other Role is dropped even at a higher revision; the same Role never rolls back.
          const held = this.state[key].data as RoleData | null;
          if (next.data && !acceptRoleRead(this.state.roleId, held && roleReadOf(held), roleReadOf(next.data as RoleData))) return;
        }
        // A catalog read that started before a write it lost the race to must not roll the catalog back.
        if (key === "roleCatalog" && next.data && !acceptCatalog(this.state.roleCatalog.data, next.data as RoleCatalog)) return;
        const cwds = key === "bots" ? botCwds(this.state.bots.data) : "";
        // Pages for a filter the Inbox has since left are dropped; the follow-up read serves the new one.
        if (key === "notifications" && next.data && (next.data as NotificationPages).filter !== this.state.notificationFilter) { this.dirty.add(key); return; }
        if (key === "notifications" && next.data) {
          const page = next.data as NotificationPages;
          this.upsertNotifications(page.entries);
          page.entries = page.entries.map(item => this.state.notificationRecords[item.id] ?? item);
        }
        const changeSeq = key === "signalStatus" ? this.state.signalStatus.data?.changeSeq : undefined;
        if (key === "signalStatus" && next.data && (next.data as AttentionStatus).contentGeneration !== this.state.signalStatus.data?.contentGeneration)
          this.set({ signalRecords: { items: {}, messages: {}, runs: {} } });
        // A Library scope change while a page read was in flight: read again for the new scope.
        // Jobs for a tab the window has since left are dropped; the follow-up read serves the new one.
        if (key === "brainJobs" && next.data && ((next.data as StackState["brainJobs"]["data"])!.view !== this.state.brainJobView.view || (next.data as StackState["brainJobs"]["data"])!.run !== this.state.brainJobView.run)) { this.dirty.add(key); return; }
        if (key === "contentItems" && next.data && scopeKey((next.data as ContentItemPage).scope) !== scopeKey(this.itemScope)) { this.dirty.add(key); return; }
        if (key === "roleCatalog") this.applyCatalog(next as Resource<RoleCatalog>);
        else if (isPreviewKey(key) && next.data && shown !== null) this.set({ [key]: next, roleContextShown: { ...this.state.roleContextShown, [key]: shown } } as Partial<StackState>);
        else this.set({ [key]: next } as Partial<StackState>);
        if (key === "signalStatus" && next.data && (next.data as AttentionStatus).changeSeq !== changeSeq) this.bumpSignal();
        if (key === "login") this.reconcileAttempt();
        if (key === "workerLogins") this.reconcileWorkerAttempts();
        if (key === "bots") this.reconcileScoped();
        // Trusted project matches depend on where Bots run.
        if (key === "bots" && botCwds(this.state.bots.data) !== cwds) this.refresh("roleLaunch");
        if (key === "workerAccounts") this.reconcileCatalogs(true);
        // Manifest changes do not advance a Role's revision, so a fresh discovery may mean a different internal list.
        if (key === "catalog") this.refresh("roleInternal");
        if (key === "brainStats" && next.data) this.rememberBrainDocuments((next.data as BrainStats).recent);
      })
      .finally(() => {
        // A newer read for another Role owns the entry now.
        if (this.inflight.get(key) !== run) return;
        this.inflight.delete(key);
        this.inflightRole.delete(key);
        if (this.dirty.delete(key)) this.refresh(key);
      });
    this.inflight.set(key, run);
    if (isRoleKey(key)) this.inflightRole.set(key, scope);
  }

  private load(key: ResourceKey): Promise<Resource<unknown>["data"]> {
    const call = <T>(pkg: string, name: string, args?: Record<string, unknown>) => {
      const channel = this.main.get(pkg);
      return channel ? channel.call<T>(name, args) : Promise.reject(new Error(`${pkg} WebSocket is not configured`));
    };
    switch (key) {
      case "access": return call<AccessSnapshot>("access", "access_snapshot");
      case "server": return call<ServerStatus>("serve", "serve_status");
      case "codexTools": return call<CodexToolsStatus>("serve", "serve_codex_tools");
      case "resources": return loadResources((name, args) => call<never>("serve", name, args)) as Promise<ServerResources>;
      case "accounts": return call<{ accounts: Account[] }>("auth", "account_list").then((result) => result.accounts);
      case "workerAccounts": return call<{ accounts: WorkerAccount[] }>("auth", "worker_account_list").then((result) => result.accounts);
      case "workerRuntimes": return call<{ runtimes: WorkerRuntime[] }>("worker", "worker_runtime_list").then((result) => result.runtimes);
      case "workerSessions": return call<{ workers: WorkerListItem[] }>("worker", "worker_list").then((result) => result.workers);
      case "login": return call<{ login: Login | null }>("auth", "account_login_current").then((result) => result.login);
      case "workerLogins": return call<{ logins: WorkerLogin[] }>("auth", "worker_account_login_current").then((result) => result.logins);
      case "bots": return call<{ bots: Bot[] }>("bots", "bot_list").then((result) => result.bots);
      case "botDefaults": return call<BotSettings>("bots", "bot_defaults_get");
      case "voice": return call<{ call: VoiceCall | null }>("bots", "voice_status").then((result) => result.call);
      case "roleCatalog": return call<RoleCatalog>("roles", "roles_snapshot");
      case "roleShims": return call<RoleShims>("roles", "role_shim_list");
      case "role": return call<RoleSnapshot>("roles", "role_editor_snapshot", { roleId: this.state.roleId });
      case "rolePreview": return call<RolePreview>("roles", "role_preview", { roleId: this.state.roleId, ...this.contextArgs() });
      case "roleLaunch": return call<RoleLaunchPreview>("roles", "role_launch_preview", { roleId: this.state.roleId, cwds: botCwds(this.state.bots.data).split("\n").filter(Boolean), ...this.contextArgs() });
      case "roleInternal": return call<RoleInternalMcp>("roles", "role_internal_mcp_list", { roleId: this.state.roleId });
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
      case "browserProfiles": return call<{ profiles: BrowserProfile[] }>("browse", "browser_profile_list").then((result) => result.profiles);
      case "browserControllers": return call<{ controllers: BrowserController[] }>("browse", "browser_controller_list").then((result) => result.controllers);
      case "browserHandoffs": return call<{ handoffs: BrowserHandoff[] }>("browse", "browser_handoff_list").then((result) => result.handoffs);
      case "browserToolchain": return Promise.all([
        call<BrowserStatus>("browse", "browser_status"),
        call<AgentBrowserStatus>("browse", "agent_browser_status"),
        call<{ installations: AgentBrowserInstallation[] }>("browse", "agent_browser_detect"),
        call<{ installations: HypemanInstallation[] }>("browse", "hypeman_detect"),
      ]).then(([status, agentBrowser, detected, hypeman]) => ({ status, agentBrowser, detected: detected.installations, hypeman: hypeman.installations }));
      case "brainStatus": return call<BrainStatus>("brain", "brain_status");
      case "brainStats": return call<BrainStats>("brain", "stats", { "top-tags": 40, recent: 8 });
      case "brainTags": return call<{ tags: BrainTag[] }>("brain", "tags", { limit: 500 }).then((result) => result.tags);
      case "brainJobStats": return call<BrainJobStats>("brain", "jobs_stats");
      case "brainSources": return call<{ sources: BrainSource[] }>("brain", "sources_status").then((result) => result.sources);
      case "brainJobs": {
        const { view, run } = this.state.brainJobView;
        const states = jobViews[view].states;
        const read = (state?: string) => call<{ jobs: BrainJob[] }>("brain", "jobs_list", { state, run: run ?? undefined, limit: brainJobLimit }).then((result) => result.jobs);
        return (states ? Promise.all(states.map(read)) : read().then((jobs) => [jobs])).then((lists) => ({ view, run, jobs: mergeJobs(lists) }));
      }
      case "procSchedules": return call<{ schedules: ProcScheduleListItem[] }>("proc", "proc_schedule_list", { limit: 100, includeRemoved: true }).then((result) => result.schedules);
      case "procRuns": return call<{ runs: ProcRun[]; nextCursor: string | null }>("proc", "proc_run_list", { limit: 100 });
      case "procStatus": return call<ProcStatus>("proc", "proc_status");
      case "hudTree": return loadTree((name, args) => call("hud", name, args), this.state.hudTreeBudget);
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
    // bot_state_changed is local operator state; a remote session never reads it.
    const topics = ["bots_changed", "threads_changed", "chats_changed", "chat_queue_changed", ...this.state.remote ? [] : ["bot_state_changed"]];
    for (const bot of bots.data) if (endpoints.bots) wanted.set(bot.id, { pkg: "bots", topics });
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
          if (status === "closed") { this.invalidateBot(id); this.bumpBotState(id); }
        },
        // onOpen also runs when the underlying socket subscription reconnects
        // without closing the browser WebSocket. Missed notices are not replayed.
        onOpen: () => { if (this.scopedChannels.get(id) !== channel) return; this.invalidateBot(id); this.bumpBotState(id); this.readSettings(`bot:${id}`); },
        onNotice: (topic) => {
          this.log(pkg, topic, id);
          if (topic === "bots_changed") {
            this.refresh("bots");
          }
          if (topic === "bot_state_changed" || topic === "bots_changed" || topic === "chat_queue_changed") this.bumpBotState(id);
          // threads_changed is an invalidation, not proof the main thread changed; the read decides.
          if (topic === "bots_changed" || topic === "threads_changed") this.readSettings(`bot:${id}`);
        },
      });
      this.scopedChannels.set(id, channel);
      channel.subscribe(topics, id).connect();
    }
  }
}
