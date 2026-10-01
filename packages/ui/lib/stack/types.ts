/** GitHub's API-only phase. Existing reference/inspection discovers it generically; dedicated setup and inbox views are a separate UI-team change. */
export type GithubTarget = { kind: "repository"; repository: string } | { kind: "organization"; organization: string }
  | { kind: "enterprise"; enterprise: string } | { kind: "app"; appId?: number } | { kind: "marketplace" } | { kind: "sponsors_listing"; account: string };
export type GithubEndpoint = { id: string; label: string; target: GithubTarget; githubHost: string; publicOrigin: string | null; path: string; webhookUrl: string | null;
  enabled: boolean; revision: number; secretVersion: number; previousSecretExpiresAt: string | null; createdAt: string; updatedAt: string;
  lastDeliveryAt: string | null; lastPingAt: string | null; accepted: number; duplicates: number; rejected: number; lastFailure: string | null; managedHookId: number | null; boundTargetId: number | null };
export type GithubPredicate = { path: string } & ({ op: "equals" | "contains"; value: string | number | boolean | null }
  | { op: "one_of"; values: (string | number | boolean | null)[] } | { op: "starts_with"; value: string } | { op: "exists"; value: boolean });
export type GithubFilter = { endpointIds?: string[]; events?: string[]; actions?: string[]; repositories?: string[]; organizations?: string[];
  enterprises?: string[]; senders?: string[]; installationIds?: number[]; repositoryIds?: number[]; refs?: string[]; predicates?: GithubPredicate[] };
export type GithubDelivery = { sequence: number; endpointId: string; deliveryId: string; event: string; action: string | null; receivedAt: string;
  contentType: "application/json" | "application/x-www-form-urlencoded"; hookId: string | null; targetType: string | null; targetId: string | null;
  repository: string | null; repositoryId: number | null; organization: string | null; enterprise: string | null; sender: string | null; installationId: number | null; ref: string | null; sha: string | null;
  entities: { kind: string; id: number | string | null; number: number | null; title: string | null; url: string | null; state: string | null; conclusion: string | null }[];
  payloadBytes: number; payloadSha256: string; payloadClearedAt: string | null; knownEvent: boolean };
export type GithubWatch = { id: string; label: string; filter: GithubFilter; enabled: boolean; revision: number; startAfter: number; acknowledgedThrough: number;
  createdAt: string; updatedAt: string; scope: string };
export type GithubWatchRead = { watch: GithubWatch; entries: GithubDelivery[]; pending: number; through: number; nextCursor: number | null };
export type GithubRemoteReceipt = { requestId: string; endpointId: string; action: string; status: "running" | "succeeded" | "failed" | "unknown";
  hookId: number | null; startedAt: string; completedAt: string | null; error: string | null };

/** Desktop connection discovery is not a grant; Access remains the server-side authority. */
export type AccessConnectionDescriptor = {
  version: 1; serverId: string; deviceOrigin: string; documentOrigin: string; artifactOrigin: string;
  uiOrigin: string | null; pairing: ("manual" | "invitation" | "sponsor")[];
};
export type AccessSnapshot = {
  serverId: string;
  clients: { id: string; label: string; kind: string; created: number; revoked: number | null }[];
  pairings: { id: string; code: string; label: string; kind: string; scopes: string[]; created: number; expires: number; state: string }[];
  grants: { id: string; client_id: string; network: "tailnet" | "public-cloud"; scopes: string[]; operations: string[]; created: number; revoked: number | null; revision: number; enrollment_id: string | null; sponsor_credential_id: string | null }[];
  invitations: { id: string; kind: string; scopes: string[]; created: number; expires: number; revoked: number | null; request_id: string | null }[];
  enrollments: { id: string; request_id: string; label: string; kind: string; scopes: string[]; created: number; expires: number; sponsor: string | null; invitation_id: string | null; credential_id: string | null; cancelled: number | null }[];
  credentials: { id: string; client_id: string; grant_id: string; generation: number; created: number; expires: number; revoked: number | null }[];
  audit: { seq: number; time: number; action: string; subject: string }[];
  ingress: { host: string; port: number; artifactPort: number; uiPort: number | null } | null;
  uiSessions: { id?: string; credential_id: string; expires: number }[];
};

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  format?: string;
  [key: string]: unknown;
};

export type CompletionWatch = { topic: string; readOperation: string; idArgument: string; terminalField: string; defaultWhen: string[]; retainFields?: string[];
  defaultOnForBot?: boolean; readArguments?: Record<string, { input: string } | { invocation: "botId" | "threadId" }>;
  scope?: { input: string; prefix?: string }; updateField?: string; initialValueField?: string };

export type OperationDoc = {
  standalone: boolean;
  name: string;
  title: string | null;
  description: string;
  annotations: Record<string, boolean | string>;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  completionWatch: CompletionWatch | null;
};

export type TransportDoc = {
  type: string;
  description: string;
  supported: boolean;
  subscriptions: boolean;
  endpoint: string | null;
  operations: string[];
  workerOperations: string[];
  events: string[];
  routes: { surface: string; surfaceDescription: string; kind: "json" | "static"; authentication: "bearer" | "none";
    method: string; path: string; description: string; format: string; operation: string | null;
    inputSchema: JsonSchema | null; querySchema: JsonSchema | null;
    outputSchema: JsonSchema | null; errorSchema: JsonSchema | null }[];
};

export type PackageDoc = {
  name: string;
  description: string;
  packageName: string;
  operations: OperationDoc[];
  events: Record<string, string>;
  eventScope: { description: string; example: string; required: boolean } | null;
  transports: TransportDoc[];
};

export type BotSettings = {
  model?: string;
  reasoningEffort?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never";
};

/** Managed settings are API records; legacy Bot controls edit only the four-field projection above. */
export type SettingValue = string | number | boolean | string[] | null;
export type SettingsBackend = "codex-app-server" | "opencode-codex" | "devin-acp" | "claude-sdk";
export type SettingsSnapshot = { revision: number; values: Record<string, SettingValue>; source: string; sourceRevision: number | null; updatedAt: number };
export type SettingEvidence = { state: "known" | "native" | "unknown"; value: SettingValue; source: string; observedAt: number | null };
export type SettingsBoundary = "bot-start" | "voice-call" | "worker-turn";
export type SettingsView = { backend: SettingsBackend; saved: SettingsSnapshot; defaults: SettingsSnapshot | null;
  loaded: (SettingsSnapshot & { loadedAt: number }) | null; instance: string | null; issues: string[];
  fields: Array<{ key: string; saved: SettingEvidence; loaded: SettingEvidence; resolved: SettingEvidence; effective: SettingEvidence;
    pending: boolean; apply: SettingsBoundary; maskedBy: string[] }> };
export type SettingsCatalog = { version: 1; backend: SettingsBackend; runtime: string | null; sourceRevision: string;
  settings: Array<{ key: string; title: string; description: string; group: string; schema: JsonSchema; nativeDefault: SettingEvidence;
    applicationDefault: SettingEvidence; apply: SettingsBoundary; stability: "native" | "experimental";
    choices: "static" | "models" | "efforts" | "service-tiers" | "voices" | "native"; dependencies: string[] }>;
  resources: Array<{ name: string; package: string; operation: string }>; limitations: string[] };
export type SettingsPatch = { expectedRevision: number; requestId: string; set?: Record<string, SettingValue>; reset?: string[] };
export type SettingsPlan = { revision: number; values: Record<string, SettingValue>;
  changes: Array<{ key: string; beforeSet: boolean; afterSet: boolean; before: SettingValue; after: SettingValue; apply: string }>; issues: string[] };
export type SettingsReceipt = { requestId: string; revision: number; duplicate: boolean; applied: false };
export type SettingsDiscovery<T> = { available: boolean; data: T | null; issue: string | null };
export type BotSettingsOptions = { instance: string; observedAt: number;
  models: SettingsDiscovery<Array<{ id: string; model: string; displayName: string; supportedReasoningEfforts: Array<{ reasoningEffort: string; description: string }>;
    defaultReasoningEffort: string; serviceTiers?: Array<{ id: string; name: string; description: string }>; isDefault: boolean; [key: string]: unknown }>>;
  voices: SettingsDiscovery<{ voices: { v1: string[]; v2: string[]; defaultV1: string; defaultV2: string; [key: string]: unknown } }>;
  features: SettingsDiscovery<Array<{ name: string; enabled: boolean; defaultEnabled: boolean; stage: string; [key: string]: unknown }>>;
  requirements: SettingsDiscovery<Record<string, unknown>> };

export type Bot = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: "running" | "stopped";
  account: string | null;
  runningAccount: string | null;
  mainThreadId: string | null;
  orientation?: { admissionId: string; state: "pending" | "creating" | "ready" | "submitting" | "running" | "completed" | "failed" | "interrupted" | "unknown" | "retired";
    threadId: string | null; turnId: string | null; issue: string | null; updatedAt: number } | null;
  recoveryIssue: string | null;
  /** The Role and revision of its last launch; a record of what was applied, not an assignment. Null ID: legacy launch. */
  roleId: string | null;
  roleRevision: number | null;
  settings: BotSettings | null;
};

/** Bot chat APIs expose sanctioned Codex threads, inspectable through Bot tools. */
export type Chat = { botId: string; threadId: string; parentThreadId: string | null; title: string; cwd: string;
  createdAt: string; updatedAt: string; messageCount: number };
/** Tree snapshots are inspectable through Bot tools; dedicated tree presentation is separate. */
export type ChatTreeRow = {
  botId: string; threadId: string; parentThreadId: string | null; depth: number;
  name: string | null; preview: string; agentNickname: string | null; agentRole: string | null; agentPath: string | null;
  model: string | null; reasoningEffort: string | null; modelProvider: string | null;
  configurationSource: "nativeLoaded" | "nativePersisted" | "rollout" | "unknown"; configurationAt: string | null;
  status: { type: "active" | "idle" | "notLoaded" | "systemError" | "unknown"; activeFlags: string[]; freshness: "live" | "unknown" };
  loaded: boolean | null; cwd: string | null; createdAt: string | null; updatedAt: string | null;
  sessionId: string | null; forkedFromId: string | null; source: string | null; threadSource: string | null;
  originator: string | null; cliVersion: string | null; historyMode: string | null; ephemeral: boolean | null;
  archived: boolean | null; projectId: string | null; sources: Array<"rollout" | "native">; metadataTruncated: boolean;
};
export type ChatTreeCoverage = { history: "scanned" | "unavailable"; native: "scanned" | "partial" | "unavailable" | "stopped"; issues: string[] };
export type ChatTree = { rootThreadId: string | null; rows: ChatTreeRow[]; total: number; nextOffset: number | null;
  snapshot: string; observedAt: string; coverage: ChatTreeCoverage };
export type ChatTreeDetailChunk = { text: string; totalChars: number; nextOffset: number | null; revision: string; observedAt: string };
export type ChatTreeEvidence = { source: "rollout" | "nativeItems"; threadId: string; line?: number; itemId?: string; value: unknown };
/** JSON document reconstructed from chat_tree_detail chunks with one matching revision. */
export type ChatTreeDetail = { thread: ChatTreeRow; nativeThread: Record<string, unknown> | null;
  sessionMeta: ChatTreeEvidence | null; initialContext: ChatTreeEvidence | null; startingInput: ChatTreeEvidence | null;
  spawn: ChatTreeEvidence | null; spawnArguments: ChatTreeEvidence | null;
  coverage: ChatTreeCoverage & { detail: "bestEffort" } };
/** Chat windows follow these; `after` reads return only rows changed since that instance and revision unless `reset`. */
export type MainChatLive = { threadId: string | null; instance: string | null; revision: number; activeTurnId: string | null; activeTurnStartedAt: number | null;
  coverage: "partial"; reset: boolean; items: Array<{ turnId: string; item: Record<string, unknown>; complete: boolean; completed: boolean; omitted: boolean }> };
/** Newest first; entries are native `{ turnId, item, startedAtMs, completedAtMs }` or an `omitted` summary. */
export type MainChatItems = { threadId: string; data: Array<Record<string, unknown>>; nextCursor: string | null };
export type ChatHit = Chat & { line: number; role: string; snippet: string; score: number };
/** Receipt-time native status before send; admission and model consumption may happen later. */
export type ChatThreadState = { status: Record<string, unknown> | null; activity: "working" | "waiting" | "idle" | "unknown"; observedAt: string; error: string | null };
export type ChatSendResult = { turn: Record<string, unknown>; threadState: ChatThreadState };
export type ChatOpenResult = ChatSendResult & { threadId: string };
export type ChatSteerResult = { turnId: string; threadState: ChatThreadState };
export type ChatEnqueueResult = ChatQueueEntry & { threadState: ChatThreadState };
export type ChatQueueEntry = { id: string; botId: string; threadId: string; input: unknown[];
  state: "pending" | "dispatching" | "sent" | "unknown" | "cancelled"; turnId: string | null; issue: string | null;
  bytes: number; admissionDigest: string; generation: string | null; contentClearedAt: string | null };

export type Account = { id: string; enabled: boolean; removing: boolean; linkedAccounts: Array<{ scope: "bot" | "worker"; id: string }> };
export type WorkerAccount = Account & { provider: "codex" | "devin" | "claude"; ready: boolean };
export type WorkerRuntime = { id: string; provider: WorkerAccount["provider"]; backend: "acp" | "claude-sdk"; processModel: "account" | "session"; pids: number[];
  state: "running" | "stopped" | "error"; pid: number | null; instance: string | null; error: string | null };
export type WorkerCatalog = { accountId: string; provider: WorkerAccount["provider"]; observedAt: string;
  source: string; runtimeVersion: string; modelConfigId: string | null;
  models: Array<{ id: string; name: string; efforts: string[]; effortConfigId: string | null }>;
  nativeModelIds: string[]; stale: boolean; error: string | null };

export type UsageObservation = { observedAtMs: number | null; lastAttemptAtMs: number | null; fresh: boolean; error: string | null };
export type CodexUsage = { planType: string | null; limitReached: boolean | null; resetCreditsAvailable: number | null;
  resetCreditExpirations: Array<string | null> | null;
  lanes: Array<{ id: string; title: string; windows: Array<{ role: "primary" | "secondary" | "code_review" | "other";
    label: string; windowSeconds: number | null; usedPercent: number; remainingPercent: number; resetsAt: string | null;
    limitName: string | null; meteredFeature: string | null }> }> };
export type DevinUsage = { planLabel: string | null; billing: string | null; dailyRemainingPercent: number | null;
  weeklyRemainingPercent: number | null; dailyResetsAt: string | null; weeklyResetsAt: string | null; periodStart: string | null;
  periodEnd: string | null; promptCreditsMonthly: number | null; promptCreditsAvailable: number | null; weeklyQuotaHidden: boolean | null; displayName: string | null };
export type ClaudeUsage = { windows: Array<{ id: string; label: string; usedPercent: number; remainingPercent: number; resetsAt: string | null }>;
  extraUsage: { enabled: boolean | null; monthlyLimit: number | null; usedCredits: number | null; utilization: number | null } | null };
export type UsageSubscription = { endsAt: string; source: "plan_period" | "sign_in_claim"; checkedAtMs: number | null };
export type UsageAccount = UsageObservation & { id: string; enabled: boolean; ready: boolean; linkedAccounts: Account["linkedAccounts"];
  subscription: UsageSubscription | null } & (
  | { provider: "codex"; scope: "bot" | "worker"; usage: CodexUsage | null }
  | { provider: "devin"; scope: "worker"; usage: DevinUsage | null }
  | { provider: "claude"; scope: "worker"; usage: ClaudeUsage | null });
export type UsageSnapshot = { atMs: number; inventoryAtMs: number | null; inventoryError: "not_observed" | "auth_unavailable" | null;
  accounts: UsageAccount[] };
export type WorkerSession = { id: string; botId: string; threadId: string; accountId: string; provider: WorkerAccount["provider"];
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleId: string | null; roleRevision: number | null; sessionId: string | null; runtimeInstance: string | null; contentClearedAt: number | null;
  phase: "preparing" | "idle" | "running" | "awaiting_input" | "cancelling" | "closed" | "failed" | "needs_recovery";
  currentTurnId: string | null; issue: string | null; createdAt: number; updatedAt: number };

/** worker_list's compact most recent turn. */
export type WorkerListTurn = Pick<WorkerTurn, "id" | "phase" | "stopReason" | "issue" | "dispatchedAt" | "createdAt" | "updatedAt" | "workContext">;
/** A worker_list row: the Worker plus its latest turn and pending permission count. */
export type WorkerListItem = WorkerSession & { turn: WorkerListTurn | null; pendingPermissions: number };
export type WorkerDiffFile = { path: string; oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed" | "copied" | "typechange" | "unmerged" | "untracked" | "unknown";
  additions: number | null; deletions: number | null; binary: boolean };
/** worker_diff: the retained worktree against its base commit. */
export type WorkerDiff = { workerId: string; branch: string | null; baseCommit: string; head: string;
  commits: Array<{ sha: string; subject: string; at: number }>; commitsTruncated: boolean; files: WorkerDiffFile[]; filesTruncated: boolean;
  uncommitted: boolean; path: string | null; patch: string | null; truncated: boolean };
/** Worker conversation details, read by the Workers space. */
export type WorkerObservedSettings = { model: string | null; effort: string | null; mode: string | null; at: number; recordSeq: number };
export type WorkerTurn = { id: string; workerId: string;
  contentClearedAt: number | null;
  workContext: WorkContext | null;
  phase: "queued" | "running" | "awaiting_input" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";
  stopReason: string | null; issue: string | null; requestId: string; prompt: string | null;
  requestedModel: string | null; requestedEffort: string | null; observedSettings: WorkerObservedSettings | null;
  dispatchedAt: number | null; dispatchedPromptSeq: number | null; createdAt: number; updatedAt: number };
export type WorkerTurnSummary = Omit<WorkerTurn, "prompt"> & { promptChars: number | null };

/** HUD semantic work is separate from Worker/Bot runtime phase; the HUD space presents it. */
export type WorkContext = { workItemId: string; scopeRevision: number; source: "explicit" | "focus" | "continuation" };
export type WorkState = "planned" | "active" | "blocked" | "waiting" | "paused" | "review" | "completed" | "cancelled";
export type WorkActor = { kind: "operator" } | { kind: "bot"; botId: string; mainThreadId: string; threadId: string };
export type WorkReference = { kind: "operator" } | { kind: "bot"; botId: string; mainThreadId: string }
  | { kind: "chat"; botId: string; mainThreadId: string; threadId: string }
  | { kind: "worker"; workerId: string; turnId: string | null }
  | { kind: "work"; workItemId: string }
  | { kind: "resource"; package: string; resource: string; id: string; version: string | null }
  | { kind: "url"; url: string };
export type WorkLink = { relation: "lead" | "contributor" | "context" | "evidence" | "output" | "related"; target: WorkReference; label: string };
export type WorkItem = { id: string; sequence: number; revision: number; scopeRevision: number; title: string; objective: string; summary: string;
  state: WorkState; parentId: string | null; order: number; priority: "low" | "normal" | "high" | "urgent";
  nextAction: string; attention: "none" | "human" | "agent"; dependencies: string[]; labels: string[]; links: WorkLink[];
  createdBy: WorkActor; updatedBy: WorkActor; createdAt: number; updatedAt: number;
  contentGeneration?: number; contentClearedAt?: number | null; contentDigest?: string | null };
export type WorkTreeRow = { item: WorkItem; depth: number; childCount: number; openDescendants: number; unmetDependencies: string[] };
export type WorkTree = { rows: WorkTreeRow[]; total: number; nextOffset: number | null; snapshot: number };
export type WorkFocus = { botId: string; mainThreadId: string; threadId: string; revision: number; workItemId: string | null; updatedAt: number | null; updatedBy: WorkActor | null };
export type WorkActivity = { sequence: number; workItemId: string; revision: number; scopeRevision: number; requestId: string; actor: WorkActor; at: number;
  kind: "created" | "updated" | "metadata" | "note" | "progress" | "result" | "decision" | "handoff" | "focus" | "maintenance";
  fields: string[]; changes: Array<{ field: string; before: unknown; after: unknown }>; body: string | null; references: WorkReference[]; contentClearedAt?: number };
export type WorkReceipt = { requestId: string; duplicate: boolean; cursor: number; items: Array<{ id: string; revision: number; scopeRevision: number }> };
export type WorkAdmission = { sequence: number; workerId: string; turnId: string; context: WorkContext; botId: string; threadId: string; accountId: string;
  provider: WorkerAccount["provider"]; model: string | null; effort: string | null; workerPhase: WorkerSession["phase"]; turnPhase: WorkerTurn["phase"];
  current: boolean; createdAt: number; updatedAt: number };
export type WorkResources = { workItemId: string; scopeRevision: number; links: WorkLink[]; focuses: { entries: WorkFocus[]; total: number; truncated: boolean };
  workers: { entries: WorkAdmission[]; nextCursor: number | null } | null;
  observation: { state: "available" | "unavailable"; at: number; issue: string | null; visibility: "all" | "own_bot" } };
export type WorkerTurnPage = { turns: WorkerTurn[]; nextId: string | null; hasMore: boolean };
export type WorkerRecord = { seq: number; workerId: string; turnId: string | null; kind: string;
  source: "live" | "replay" | "response" | "submitted"; at: number; data: Record<string, unknown> | null; dataChars: number; oversized: boolean };
export type WorkerCapture = { records: number; retainedChars: number; droppedRecords: number; lastObservedAt: number | null;
  maxRecords: number; maxChars: number; truncated: boolean };
export type WorkerDetail = { worker: WorkerSession; observedSettings: WorkerObservedSettings | null; metadata: WorkerRecord[]; capture: WorkerCapture;
  freshness: { connected: boolean; stale: boolean; readAt: number; reason: string | null };
  subagents: { coverage: "partial" | "unavailable"; hierarchyAvailable: false; childTranscriptsAvailable: false; reason: string } };
export type WorkerPermission = { id: string; workerId: string; turnId: string; acpRequestId: number; kind: "permission"; title: string;
  runtimeInstance: string | null; toolCallId: string | null; recordSeq: number | null;
  options: Array<{ optionId: string; name: string; kind: string }>; state: "pending" | "responded" | "unknown" };
export type WorkerStatus = { worker: WorkerSession; turn: WorkerTurnSummary | null; pending: WorkerPermission[] };
export type WorkerTurnObservation = {
  result: { workerId: string; turnId: string; requestId: string; phase: "completed" | "cancelled" | "failed" | "unknown";
    stopReason: string | null; issue: string | null; workContext: WorkContext | null; contentClearedAt: number | null } | null;
  update: { workerId: string; turnId: string; requestId: string; phase: "queued" | "running" | "awaiting_input" | "cancelling";
    pending: Array<{ permissionId: string; optionCount: number }>; pendingCount: number; pendingTruncated: boolean } | null;
};
export type WorkerAdmission = { worker: WorkerSession; turn: WorkerTurnSummary; duplicate: boolean; subscription: CompletionReceipt | null; observation: WorkerTurnObservation | null };
export type WorkerRecordPage = { entries: WorkerRecord[]; nextSeq: number; hasMore: boolean; capture: WorkerCapture };
export type WorkerRecordChunk = { seq: number; offset: number; data: string; nextOffset: number; totalChars: number; hasMore: boolean; encoding: "json-utf16" };
export type WorkerTool = { toolCallId: string; turnId: string | null; firstSeq: number; lastSeq: number;
  title: string | null; kind: string | null; status: string | null; record: WorkerRecord };
export type WorkerTask = { toolCallId: string; sessionId: string; callingSessionId: string; toolStatus: string | null; background: boolean;
  model: { providerID: string | null; modelID: string | null } | null; recordSeq: number;
  visibility: "task_reference"; hierarchyVerified: false; childStatus: "unknown" };
export type WorkerToolPage = { tools: WorkerTool[]; tasks: WorkerTask[]; nextSeq: number; hasMore: boolean };
/** worker_read: bounded user, agent, tool, plan and turn-outcome text by sequence. Agent text arrives as chunks. */
export type WorkerTranscriptEntry = { seq: number; workerId: string; turnId: string; kind: string; text: string; at: number };
export type WorkerTranscriptPage = { entries: WorkerTranscriptEntry[]; nextSeq: number; hasMore: boolean };

export type Login = {
  id: string;
  status: "pending" | "complete" | "failed";
  authUrl: string | null;
  userCode: string | null;
  account: string | null;
  error: string | null;
  targetAccount: string | null;
};

export type WorkerLogin = {
  id: string;
  account: string;
  provider: WorkerAccount["provider"];
  status: "pending" | "complete" | "failed";
  authUrl: string | null;
  userCode: string | null;
  needsCode: boolean;
  error: string | null;
};

export type ServerChild = {
  name: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: string | null;
  exitedAt: string | null;
};

export type ServerStatus = {
  pid: number;
  startedAt: string;
  nodeVersion: string;
  indexUrl: string | null;
  uiUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: ServerChild[];
};

/** `serve_codex_tools`: sanitized server-wide observations of the Codex tool bridges; they reset on server restart. */
export type CodexToolsProblem = { code: "runtime_missing" | "config_invalid" | "plugin_unavailable" | "browser_module_missing" | "no_browser" | "multiple_browsers"
  | "approval_required" | "probe_failed" | "probe_timeout"; message: string; recovery: string };
export type CodexToolsConnection = {
  name: string; title: string; description: string; upstream: string;
  /** available: the upstream catalog listed it. Not proof a consumer connected, a site/app is approved, or recording is on. */
  catalog: { state: "not_checked" | "available" | "unavailable" | "failed"; checkedAt: string | null; tools: number | null; evidence: string | null; problem: CodexToolsProblem | null };
  /** Chrome only: the extension's browser list when last asked. */
  browser: { state: "not_checked" | "connected" | "none" | "multiple" | "failed"; checkedAt: string | null; evidence: string | null; problem: CodexToolsProblem | null } | null;
};
export type CodexToolsStatus = {
  checking: { startedAt: string; chromeBrowser: boolean } | null;
  checkedAt: string | null;
  runtime: { state: "not_checked" | "found" | "missing" | "invalid"; source: "override" | "standalone" | "chatgpt-app" | "codex-app" | null; checkedAt: string | null; problem: CodexToolsProblem | null };
  connections: CodexToolsConnection[];
};

/** Mirror of the server resource API's wire shapes (packages/serve resources schema). */
export type ResourceMetrics = {
  processCount: number;
  rssBytes: number | null;
  virtualBytes: number | null;
  cpuTimeMs: number | null;
  cpuPercent: number | null;
  cpuMeasuredProcessCount: number;
  threads: number | null;
};
export type ResourceScopeKind = "total" | "component" | "bot" | "account" | "runtime" | "process" | "subtree";
export type ResourceScope = {
  id: string;
  kind: ResourceScopeKind;
  name: string;
  component: string | null;
  botId: string | null;
  accountId: string | null;
  runtimeInstance: string | null;
  provider: string | null;
  shared: boolean;
  metrics: ResourceMetrics;
};
export type ResourceProcess = {
  id: string;
  subtreeId: string;
  pid: number;
  ppid: number;
  birth: string;
  name: string;
  parentId: string | null;
  ancestryParentId: string | null;
  ownership: "root" | "descendant" | "retained";
  component: string;
  botId: string | null;
  accountId: string | null;
  runtimeInstance: string | null;
  provider: string | null;
  attribution: "component" | "current" | "retained";
  attributedAt: string | null;
  cpuIntervalMs: number | null;
  cpuStatus: "measured" | "warmup" | "reset";
  self: ResourceMetrics;
  subtree: ResourceMetrics;
};
export type ResourceHost = {
  platform: string;
  logicalCpuCount: number;
  hostname: string;
  arch: string;
  release: string;
  cpuModel: string | null;
  uptimeSeconds: number | null;
  totalMemoryBytes: number | null;
  freeMemoryBytes: number | null;
  loadAverage: [number, number, number] | null;
};
export type DomainStatus = {
  source: "bots" | "worker";
  capturedAt: string | null;
  error: "source_unavailable" | "invalid_source" | null;
  state: "current" | "stale" | "unavailable" | "not_attached";
  unmatched: number;
};
export type ResourceCoverage = {
  mode: "server_tree" | "self_only";
  observedHostProcesses: number;
  ownedProcesses: number;
  unreadableProcesses: number;
  vanishedDuringCollection: number;
  retainedProcesses: number;
  excludedCollectorProcesses: number;
  domains: DomainStatus[];
};
export type ResourceError = "unsupported_platform" | "collection_failed" | "collection_timeout" | "process_limit" | "server_missing" | "process_capacity";
export type ResourceObservation = {
  snapshotId: string | null;
  capturedAt: string | null;
  ageMs: number | null;
  freshness: "fresh" | "stale" | "unavailable";
  lastAttemptAt: string | null;
  error: ResourceError | null;
  source: "darwin_ps" | "linux_proc" | "unsupported";
  intervalMs: number;
  staleAfterMs: number;
  collectionDurationMs: number | null;
  coverage: ResourceCoverage | null;
};
export type ResourceRetention = {
  maxSamples: number;
  maxProcessRecords: number;
  retainedSamples: number;
  oldestAttemptAt: string | null;
  newestAttemptAt: string | null;
  droppedSamples: number;
};
export type ResourceCapabilities = {
  rssBytes: boolean;
  virtualBytes: boolean;
  cpuTimeMs: boolean;
  cpuPercent: boolean;
  threads: boolean;
  diskIoBytes: false;
  openFileDescriptors: false;
  networkBytes: false;
  gpu: false;
  perSessionAllocation: false;
};
export type ServerRuntime = {
  pid: number;
  nodeVersion: string;
  uptimeSeconds: number | null;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  eventLoopUtilization: number | null;
};
export type ResourceHistoryPoint = {
  attemptId: string;
  attemptedAt: string;
  snapshotId: string | null;
  capturedAt: string | null;
  state: "measured" | "absent" | "gap";
  error: ResourceError | null;
  metrics: ResourceMetrics | null;
  host: ResourceHost | null;
  coverage: ResourceCoverage | null;
};
/** `serve_resource_history` wire page. */
export type ResourceHistoryPage = {
  scopeId: string;
  intervalMs: number;
  retention: ResourceRetention;
  truncated: boolean;
  points: ResourceHistoryPoint[];
};
/** `serve_resources` flattened to what the bench needs: every scope plus the paged process list of `total`. */
export type ServerResources = {
  observation: ResourceObservation;
  host: ResourceHost | null;
  capabilities: ResourceCapabilities;
  retention: ResourceRetention;
  runtime: ServerRuntime | null;
  scopes: ResourceScope[];
  processes: ResourceProcess[];
  /** Total processes in the selected scope before paging. */
  processTotal: number;
};

export type VoiceCall = {
  sessionId: string;
  botId: string;
  threadId: string;
  phase: "dialing" | "connected";
};

/** Bot tools expose the voice_speak receipt; submission does not confirm audible playback. */
export type VoiceSpeechSubmission = { sessionId: string; status: "submitted" };

export type InferEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

/** One picker-visible model from `infer_models`; discovery runs no inference. */
export type InferModel = { id: string; defaultEffort: InferEffort; supportedEfforts: InferEffort[] };

/** Cached `infer_model_list` discovery for one Bot account; reading it never starts discovery. */
export type InferModelObservation = { accountId: string; models: InferModel[] | null; observedAt: string | null; discovering: boolean; error: string | null };

/** `failed` is definite; `unknown` may have been charged. */
export type InferRequestState = "running" | "completed" | "failed" | "unknown";

type InferRequestFields = {
  contentClearedAt: string | null;
  requestId: string;
  accountId: string;
  model: string;
  effort: InferEffort;
  maxOutputTokens: number;
  state: InferRequestState;
  error: string | null;
  reportedModel: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; reasoningTokens: number | null } | null;
  createdAt: string;
  finishedAt: string | null;
};

/** One row of the durable `infer_request_list` ledger, with previews instead of bodies. */
export type InferRequestSummary = InferRequestFields & { inputPreview: string; textPreview: string | null; textChars: number | null };

/** `infer_request_get`: the full ledger record. */
export type InferRequest = InferRequestFields & { instructions: string; input: string; text: string | null };

/** Signal's revisioned attention inference defaults; a null account uses the first available enabled Bot account. */
export type AttentionDefaults = { model: string; reasoningEffort: InferEffort; accountId: string | null; revision: number };
/** `attention_status`. `changeSeq` advances only when attention records may have changed, never for source-read polling. */
export type AttentionStatus = { contentGeneration: number; enabled: boolean; activatedAt: number | null; baselined: boolean; settings: AttentionDefaults;
  checkpointGeneration?: number; checkpointResets?: { source: string; at: number; generation: number }[];
  lastScan: number | null; lastInference: { at?: number; runId?: string; requestId?: string; state?: string; model?: string; reportedModel?: string | null; error?: string } | null;
  sourceErrors: Array<{ source: string; error: string }>; jobs: Array<{ state: string; count: number }>; messages: number; runs: number; changeSeq: number };
/** `attention_models`: account-bound choices for the effective account; no inference. */
export type AttentionModels = { accountId: string; observedAt: string; models: InferModel[] };
export type AttentionItemState = "informational" | "open" | "partial" | "answered" | "satisfied" | "declined" | "withdrawn" | "superseded" | "unclear";
export type AttentionReason = "none" | "awareness" | "review" | "response" | "action";
export type AttentionAudience = "human" | "agent" | "team" | "unspecified" | "none";
export type AttentionUrgency = "routine" | "soon" | "immediate" | "unspecified";
/** One current semantic item from `attention_list`, with its list cursor flattened in. `start`/`end` locate its evidence in the message text (UTF-16). */
export type AttentionItem = {
  cursor: number; id: string; messageId: string; runId: string; conversation: string; botId: string | null; start: number; end: number; current: boolean;
  acts: string[]; forms: string[]; summary: string; evidence: { quote: string; occurrence: number }; subject: string; scope: string | null;
  audience: { kind: AttentionAudience; id: string | null }; engagement: string[];
  attention: { reason: AttentionReason; rationale: string; basis: "explicit" | "inferred" };
  timing: { urgency: AttentionUrgency; deadline: string | null; blockingScope: string | null };
  conditions: string[]; uncertainty: string[]; state: AttentionItemState;
  relations: Array<{ type: string; targetId: string | null; referenceText: string }>;
};
/** A captured message revision from `attention_message_list`; `text` is a preview of at most 2,000 characters. */
export type AttentionMessage = { contentClearedAt: string | null; cursor: number; seq: number; id: string; logicalId: string; revision: string; current: boolean;
  source: "bots" | "workers"; conversation: string; key: string; role: "user" | "assistant"; authorKind: "human" | "agent" | "unknown";
  audienceHint?: "human" | "agent" | "unknown"; botId: string | null; text: string; textChars: number; complete: boolean; occurredAt: string | null; observedAt: number };
/** `failed` is definite; `unknown` may have dispatched and needs an explicit replay decision. */
export type AttentionRun = { contentClearedAt: string | null; cursor: number; id: string; jobId: string; messageId: string | null; replay: boolean; replayOf: string | null; promptVersion: string | null;
  at: number; finished: number | null; state: string; requestId: string; settings: AttentionDefaults; error: string | null };
export type AttentionFeedbackKind = "correction" | "label" | "outcome" | "behavior";
export type AttentionFeedback = { cursor: number; id: string; at: number; messageId: string; runId: string | null; kind: AttentionFeedbackKind; author: string; body: string };
export type AttentionEvent = { cursor: number; seq: number; at: number; kind: string; body: Record<string, unknown> | null; bodyChars: number; omitted: boolean };
export type AttentionPage<T> = { entries: T[]; nextCursor: number; hasMore: boolean };
/** A revision-fenced UTF-16 chunk from the attention_*_read exports. */
export type AttentionChunk = { text: string; nextOffset: number; totalChars: number; revision: string };
export type InferTraceChunk = { text: string; nextOffset: number; totalChars: number; complete: boolean; revision: string };
export type ChatMessageCursor = { sourceId: string; line: number; prefixHash: string };
export type ChatMessagePage = { cursor: ChatMessageCursor; reset: boolean; hasMore: boolean; entries: Array<{
  key: string; revision: string; line: number; role: "user" | "assistant"; text: string | null;
  textChars: number; timestamp: string | null; phase: string | null;
}> };

/** A Role Fragment: an ordered developer-instruction body. Title and description are for people and never render. */
export type RoleRenderContext = { model?: string; harness?: string };
export type RoleFragment = { id: string; categoryId: string; title: string; description: string; body: string; enabled: boolean; conditions?: RoleRenderContext;
  createdAt: number | null; updatedAt: number | null };
export type RoleCategory = { id: string; title: string; description: string; enabled: boolean; fragments: RoleFragment[];
  createdAt: number | null; updatedAt: number | null };
/** A supporting file beside a skill's generated SKILL.md; bytes travel as canonical base64. */
export type RoleSkillFile = { path: string; contentBase64: string };
/** A Role-owned skill. Its name and description become SKILL.md frontmatter, so both reach Bots. */
export type RoleSkill = { id: string; name: string; description: string; body: string; files: RoleSkillFile[]; enabled: boolean };
export type RoleMcpDefinition =
  | { type: "http"; url: string; bearerTokenEnvVar?: string; httpHeaders?: Record<string, string>; envHttpHeaders?: Record<string, string> }
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string>; envVars?: string[] };
/** An additional MCP server for new Bot launches; its description is for people only. */
export type RoleMcpServer = { id: string; name: string; description: string; definition: RoleMcpDefinition; enabled: boolean };
/** A canonical project root whose project config Bots launched inside it may load. */
export type RoleTrustedProject = { id: string; path: string; description: string; enabled: boolean };
/** A named Role in `roles_snapshot`. `revision` is the Role's own; names are unique ignoring ASCII case. */
export type Role = { id: string; name: string; description: string; revision: number; createdAt: number | null; updatedAt: number | null };
/** `roles_snapshot`: Roles in creation order. `revision` is the catalog-wide edit fence, not any Role's. */
export type RoleCatalog = { revision: number; defaultRoleId: string | null; workerDefaultRoleId: string | null; roles: Role[] };
/** Local-only `role_shim_list`: installed executable wrappers, not Role records. */
export type RoleShim = { name: string; args: string[]; path: string; revision: string };
export type RoleShims = { binDir: string; shims: RoleShim[] };
/** `role_editor_snapshot`: operator-only definitions; ordinary snapshots and write replies use MCP summaries. */
export type RoleSnapshot = Role & { botMarkdown?: string; categories: RoleCategory[]; skills: RoleSkill[]; mcpServers: RoleMcpServer[]; trustedProjects: RoleTrustedProject[];
  /** Internal Package API names switched off for this Role. Not an inventory: an empty list means every configured server is on. */
  disabledInternalMcpServers: string[] };
export type RoleSummary = Omit<RoleSnapshot, "mcpServers"> & { mcpServers: Array<Omit<RoleMcpServer, "definition"> & { transport: "http" | "stdio" }> };
/** What a Role write returns instead of a snapshot: reread the Role for its content. */
export type RoleReceipt = { roleId: string; revision: number };
/** `role_preview`: exact instruction fragments and their spans, plus the separate Bot-only bot.md personality. */
export type RolePreview = { roleId: string; revision: number; rendered: string; bytes: number; limitBytes: number; botMarkdown?: string; botBytes?: number;
  segments: Array<{ categoryId: string; fragmentId: string; start: number; end: number }> };
/** A configured internal Stack MCP server and whether the Role's later launches connect to it. `title` is the key for Package APIs. */
export type RoleInternalServer = { name: string; title: string; description: string; kind: "package" | "codex"; transport: "stdio"; enabled: boolean };
/** `role_internal_mcp_list`: the servers configured now, each with this Role's switch. */
export type RoleInternalMcp = { roleId: string; revision: number; servers: RoleInternalServer[] };

/** How a Notification was dismissed: once, with the chosen action label or reply text as `response`. */
export type NotificationOutcome = "closed" | "opened" | "action" | "replied" | "replaced";
/** A `notify` Notification; open until `dismissedAt`. Actions, reply and open are data; nothing executes. */
export type Notification = { id: string; sequence: number; title: string; message: string; subtitle: string | null; source: string | null; contentClearedAt: string | null;
  group: string | null; open: string | null; actions: string[]; reply: string | null; createdAt: string;
  dismissedAt: string | null; outcome: NotificationOutcome | null; response: string | null };
export type CompletionReceipt = { id: string; state: "pending" | "error" | "observed" | "delivered" | "unknown" | "cancelled"; lastDeliveredAt: number | null; lastError: string | null; lastDeliveryKind: "update" | "terminal" | null };
export type NotificationSend = Notification & { subscription: CompletionReceipt | null };
/** `notification_counts`. A null source counts notifications sent without one. */
export type NotificationCounts = { open: number; total: number; sources: Array<{ source: string | null; open: number; total: number }> };
/** The Inbox's view of `notification_list`: which filter it shows and the pages loaded so far. */
export type NotificationFilter = { dismissed?: boolean; source?: string };
export type NotificationPages = { filter: NotificationFilter; entries: Notification[]; nextCursor: number | null };
/** `role_launch_preview`: what the next launch receives besides instructions, matched against given working directories. */
export type RoleLaunchPreview = {
  roleId: string;
  revision: number;
  instructions: { bytes: number; botBytes?: number; limitBytes: number; fragments: number };
  skills: Array<{ id: string; name: string; description: string; files: number; bytes: number }>;
  /** Every configured internal server with this Role's switch; only enabled ones reach a launch. */
  internalMcpServers: RoleInternalServer[];
  mcpServers: Array<{ id: string; name: string; type: "http" | "stdio" }>;
  config: string;
  trustedProjects: Array<{ id: string; path: string }>;
  cwds: Array<{ cwd: string; path: string | null; trustedProjectIds: string[] }>;
  issues: Array<{ id: string; name: string; message: string }>;
  snapshotChars: number;
  snapshotLimitChars: number;
};
/** A Vault document row from `list`; `search` hits add a snippet and score. */
export type ContentDocument = { slug: string; title: string; tags: string[]; updated?: string | null; bytes?: number };
export type ContentHit = { slug: string; title: string; snippet: string; score: number; tags: string[] };
/** `get`: the body without frontmatter, plus the whole file's SHA-256 edit fence. */
export type ContentDocumentBody = { slug: string; title: string; digest: string; content?: string; tags?: string[];
  created?: string | null; updated?: string | null; frontmatter: Record<string, unknown>; bytes?: number };
export type ContentLinks = { slug: string; title: string; outgoing: Array<{ to: string; title: string; kind: string }>; dangling: unknown[] };
export type ContentBacklinks = { slug: string; title: string; incoming: Array<{ from: string; title: string; kind: string }> };
export type ContentTag = { tag: string; documents: number };
export type ContentCollection = { slug: string; title: string; description: string; createdAt: string; updatedAt: string };
export type ContentItemKind = "document" | "file" | "image";
/** A Content item: stable ID and revision, optional collection, immutable content-addressed bytes. */
export type ContentItem = { id: string; collection: string | null; name: string; kind: ContentItemKind; mediaType: string;
  bytes: number; digest: string; revision: number; createdAt: string; updatedAt: string; url: string };
/** An Artifact at one version; `url` is the latest path and `version_url` the immutable citation. */
export type ContentArtifact = { name: string; version: string; kind: string; url: string; version_url: string;
  title?: string | null; tags?: string[]; created_at?: string | null; bytes?: number; files?: number; media_type?: string | null;
  latest?: boolean; deleted?: string | null; deleted_reason?: string | null; [key: string]: unknown };
export type ContentStage = { id: string; bytes: number; received: number; digest: string; blob: string | null };
/** `collection_list` plus per-scope item totals from `item_list`. */
export type ContentLibrary = { collections: ContentCollection[]; counts: { all: number; ungrouped: number; byCollection: Record<string, number> } };
/** The Library's current item scope: undefined for all, null for ungrouped, or a collection slug. */
export type ContentItemScope = string | null | undefined;
export type ContentItemPage = { scope: ContentItemScope; items: ContentItem[]; total: number; nextOffset: number | null };
/** Loopback HTTP origins of the Content backends, known to the UI server from its environment. */
export type ContentOrigins = { document: string; artifact: string };
/** One browser upload through resumable blob stages; `stalled` resumes from the server's acknowledged offset. */
export type ContentUpload = { key: string; name: string; bytes: number; received: number; collection: string | null;
  phase: "hashing" | "uploading" | "storing" | "done" | "stalled" | "failed"; error: string | null; itemId: string | null; stageId: string | null;
  /** False once item_put may have stored the item: retrying could create a duplicate. */
  retryable: boolean };

export type Resource<T> = { data: T | null; error: string | null; at: number | null };

/** A `scrape` extraction preset. `domain` "*" presets are explicit-only link modes; any other domain (and its aliases) is claimed, so an unmatched URL there fails rather than falling back. */
export type ScrapePreset = { name: string; summary: string; domain: string; mode: "content" | "links" | "nav-links"; aliases: string[]; browser_profile?: string; url_patterns: string[];
  handler?: string; schema?: string; selector?: string; section_selector?: string; category_selector?: string; toggle_selector?: string; source: "official" | "local" };
/** `scrape_status`: optional route capabilities, never a claim that every route works. */
export type ScrapeStatus = { stateRoot: string; browser: boolean; github: boolean; pdf: boolean; pandoc: boolean; summary: boolean };
export type ScrapeFailureClass = "invalid_request" | "authentication_required" | "upstream_unavailable" | "timeout" | "browser_error" | "provider_error"
  | "malformed_provider_output" | "empty_content" | "output_limit_exceeded" | "cancelled" | "internal_error";
/** `scrape_fetch`'s schema-version-1 extraction envelope. Metadata is what the page reported, not verified fact. */
export type ScrapeEnvelope = {
  schema_version: "1"; status: "success" | "failure"; requested_url: string; final_url: string | null;
  extractor: { name: string; version: string; implementation: string; implementation_version: string };
  artifacts: Array<{ artifact_type: "document"; media_type: "text/markdown"; encoding: "utf-8"; content: string; size_bytes: number; sha256: string }>;
  metadata: { content_type: "web_page" | "social_post" | "article"; content_kind?: "post" | "thread" | "article"; content_item_count?: number; title: string; author_name: string;
    author_handle: string; published_at: string; source_id: string; warnings: Array<"partial_content"> } | null;
  relations: Array<{ relation_type: "references"; target_url: string }>;
  failure: { failure_class: ScrapeFailureClass; retryable: boolean; message: string; evidence: string } | null;
};
/** `scrape_links`: navigation links or an X timeline. `structured` and `links` are preset-shaped. */
export type ScrapeLinks = { markdown: string; structured: unknown; links?: unknown[] };
export type ScrapeFeedValidators = { etag: string | null; last_modified: string | null };
/** `scrape_feed_discover` / `scrape_feed_parse`. A missing item never implies deletion. */
export type ScrapeFeed = {
  schema_version: "1"; status: "success" | "partial" | "failure"; source_url: string; source_format: "rss" | "atom" | "archive" | "mixed" | "unknown"; validators: ScrapeFeedValidators;
  cursor: { validators: ScrapeFeedValidators; newest_seen_at: string | null; next_url: string | null };
  items: Array<{ stable_id: string; upstream_id: string | null; identity_source: "upstream_id" | "canonical_url" | "hashed_upstream_id"; url: string | null; candidate_urls: string[];
    title: string; published_at: string | null; updated_at: string | null; tombstone: boolean }>;
  pagination: { pages: Array<{ url: string; page_format: "rss" | "atom" | "archive"; validators: ScrapeFeedValidators; item_count: number; next_url: string | null }>; complete: boolean; stop_reason: string; next_url: string | null };
  warnings: Array<{ code: string; message: string; page_url?: string }>; absence_implies_deletion: false; failure: { code: string; retryable: boolean; message: string } | null;
};
/** One scrape-to-file job from `scrape_queue_list`; `id` is its generation ID where derivable, so it survives state moves. */
export type ScrapeQueueJob = { id: string; state: "pending" | "retrying" | "failed"; file: string; submitted_at: string | null; url: string | null; destination: string | null;
  maintenanceFence?: { requestId: string; action: string; status: string };
  summarize: boolean; allow_private_network: boolean | null; frontmatter_keys: string[]; completed_failures: number; max_attempts: number | null; next_attempt_at: string | null; problem: string | null };
export type ScrapeQueue = { jobs: ScrapeQueueJob[]; counts: Record<ScrapeQueueJob["state"], number>; truncated: boolean };
export type ScrapeQueueResult = { processed: number; failed: number; retry_scheduled: number; retry_waiting: number; retry_exhausted: number };
/** `scrape_presets_check`: `not_configured` is never a pass. */
export type ScrapeCanaryStatus = "pass" | "drift" | "operational_failure" | "not_configured";
export type ScrapeCanaryRun = { checked_at: string; results: Array<{ preset: string; status: ScrapeCanaryStatus; detail: string }> };
export type ScrapeReplay = { passed: number; failed: number; lines: string[] };

/** A durable Browser profile from `browser_profile_list`. `observation` follows the visible tab; its delivery is never verified. */
export type BrowserProfile = {
  generation: number; maintenanceRequestId: string | null;
  id: string; botId: string | null; label: string; default: boolean; createdAt: string;
  state: "starting" | "ready" | "recovering" | "failed"; error: string | null; observedAt: string | null; cdpUrl: string | null;
  observation: { url: string; udpPort: number; follows: "visible-tab"; verified: false } | null;
};
/** A controller's selection and last confirmed binding. `connected` is a timestamped observation, never liveness; `unknown` never asserts attachment. */
export type BrowserController = {
  botId: string; instance: string; session: string; profileId: string; actualProfileId: string | null; targetId: string | null; cdpUrl: string | null;
  state: "connecting" | "connected" | "disconnected" | "unknown"; revision: number; observedAt: string | null; error: string | null;
};
/** A durable Browser handoff. `issue` is a runtime problem separate from the human outcome; completed is a report, not verification. */
export type BrowserHandoff = {
  contentClearedAt: string | null; requestDigest: string | null;
  id: string; profileId: string; botId: string; threadId: string; instance: string; requestId: string;
  targetId: string | null; targetStatus: "unspecified" | "present" | "missing" | "unknown"; message: string;
  state: "preparing" | "awaiting_human" | "human_controlling" | "returning" | "resolved";
  outcome: "completed" | "skipped" | "cancelled" | null; note: string | null;
  revision: number; createdAt: string; resolvedAt: string | null; issue: string | null; quiesced: boolean;
};
/** `browser_handoff_take` / `browser_handoff_finish`. `controlUrl` is a human input grant: keep it in memory only. */
export type BrowserHandoffAction = { handoff: BrowserHandoff; controlUrl: string | null };
export type BrowserHandoffObservation = { result: BrowserHandoff | null };
export type BrowserHandoffRequest = BrowserHandoff & { subscription: CompletionReceipt | null; observation: BrowserHandoffObservation | null };
/** `browser_status`: provider policy and counts; it does not probe Hypeman or promise launch capacity. */
export type BrowserStatus = { provider: "hypeman"; mode: "durable"; sessions: number; profiles: number };
/** `agent_browser_status`: the managed installation and its update observation. */
export type AgentBrowserStatus = {
  installed: boolean; version: string | null; location: string | null; latest: string | null; pending: string | null;
  checkedAt: string | null; checkError: string | null; policy: "manual" | "automatic";
};
export type AgentBrowserInstallation = { location: string; version: string | null; source: "stack" | "agentstart" };
export type HypemanInstallation = { root: string; installed: boolean; selected: boolean; source: "stack" | "legacy" | "custom"; running: boolean; issue: string | null };
export type BrowserToolchain = { status: BrowserStatus; agentBrowser: AgentBrowserStatus; detected: AgentBrowserInstallation[]; hypeman: HypemanInstallation[] };
export type BrainJobState = "queued" | "running" | "retry_wait" | "blocked" | "failed" | "completed" | "excluded" | "cancelled";
export type BrainSensitivity = "public" | "normal" | "sensitive" | "private";
export type BrainContentKind = "post" | "thread" | "article";
/** `brain_status`: isolated paths and ingestion worker health. The share token is never returned. */
export type BrainStatus = { stateRoot: string; database: string; artifactStore: string; shareUrl: string; shareTokenFile: null; worker: "running" | "stopped" | "failed"; health: string | null };
export type BrainStats = {
  db_path: string; db_size_bytes: number; document_count: number; chunk_count: number; total_chars: number;
  by_source_type: Array<{ source_type: string; count: number }>; top_tags: Array<{ tag: string; count: number }>;
  recent: Array<{ document_id: number; title: string | null; source_uri: string; source_type: string; updated_at: string }>;
  relation_count: number; failed_relation_count: number;
};
export type BrainTag = { tag: string; count: number };
/** Search and context filters, spelled as the operations' own input properties. */
export type BrainFilters = { tag?: string; "source-type"?: string; "content-kind"?: BrainContentKind; collection?: string; sensitivity?: BrainSensitivity; "date-from"?: string; "date-to"?: string };
export type BrainRelationSummary = { relation_id: number; direction: "outbound" | "inbound"; relation_type: string; status: string; linked_document_id: number; linked_resource_id: number | null;
  linked_title: string | null; linked_resource_kind: string; linked_sensitivity: BrainSensitivity };
type BrainHitBase = { document_id: number; resource_id: number | null; resource_kind: string; sensitivity: BrainSensitivity; collections: string[]; sources: Array<{ source_type: string; identifier: string }>;
  relations: BrainRelationSummary[]; chunk_id: number; chunk_index: number; title: string | null; source_uri: string; source_type: string; content_kind: BrainContentKind | null;
  content_item_count: number | null; tags: string[]; start_char: number; end_char: number; score: number };
/** One ranked chunk from `search`. Scores are FTS5 ranks: lower is better. */
export type BrainHit = BrainHitBase & { updated_at: string; snippet: string };
export type BrainSearch = { query: string; normalized_query: string; mode: "any" | "all" | "raw"; limit: number; offset: number; filters: BrainFilters; results: BrainHit[]; next_offset: number | null };
/** `context`: bounded, citation-ready chunk content. */
export type BrainContextHit = BrainHitBase & { citation: string; content: string; truncated: boolean };
export type BrainContext = { query: string; filters: BrainFilters; limit: number; max_chars: number; returned_chars: number; truncated: boolean; hits: BrainContextHit[] };
export type BrainLink = { id: number; from_document_id: number; to_document_id: number | null; relation_type: string; discovered_url: string | null; resolved_url: string | null; status: string;
  error: string | null; created_at: string; updated_at: string };
/** A Research document from `get`. Content may be head/tail truncated; `truncation` says by how much. */
export type BrainDocument = {
  document_id: number; title: string | null; source_uri: string; source_type: string; content_kind: BrainContentKind | null; content_item_count: number | null; tags: string[];
  notes: string | null; size_chars: number; content_hash: string; created_at: string; updated_at: string; content: string; outbound_links: BrainLink[]; inbound_links: BrainLink[];
  truncation: { requested_char_limit: number | null; returned_chars: number; omitted_chars: number };
};
export type BrainChunk = { chunk_id: number; document_id: number; chunk_index: number; start_char: number; end_char: number; content: string };
/** A content-safe Ingestion job: no intent, URL, title or body. */
export type BrainJob = { id: number; kind: string; state: BrainJobState; sensitivity: string; resource_id: number | null; source_id: number | null; run_id: number | null;
  content_cleared_at?: string | null;
  attempt_count: number; item_retry_count: number; run_at: string; failure_class: string | null; created_at: string; updated_at: string };
export type BrainAttempt = { id: number; job_id: number; attempt_number: number; state: "failed" | "cancelled" | "leased" | "succeeded" | "stale"; lease_expires_at: string; heartbeat_at: string;
  started_at: string; finished_at: string | null; failure_class: string | null; failure_summary: string | null };
export type BrainTransition = { id: number; job_id: number; attempt_id: number | null; from_state: BrainJobState | null; to_state: BrainJobState; created_at: string };
/** `jobs_show`: bounded, sanitized diagnostics with URLs redacted. */
export type BrainJobRecord = BrainJob & { failure_summary: string | null; attempts: BrainAttempt[]; transitions: BrainTransition[];
  /** Present on jobs_show; sensitive jobs_reveal has its own legacy projection. */
  network_policy?: { scope: { kind: "job"; id: number } | { kind: "source"; id: number; version: number }; grantId: number | null; policy: { privateDestinations: Array<{ address: string; port: number }> } } };
/** `jobs_reveal`: submitted intent and captured bodies. Reading it appends an audit record. */
export type BrainRevealedJob = BrainJobRecord & { intent: unknown; artifacts: Array<{ content_digest: string; media_type: string; byte_size: number; body: string }> };
export type BrainJobStats = { total: number; by_state: Record<BrainJobState, number>; runnable_due: number; active_leases: number; stale_leases: number; oldest_runnable_at: string | null };
export type BrainRunState = "pending" | "failed" | "completed" | "cancelled" | "active" | "completed_with_review";
/** One Research source from `sources_status`: its definition, health, latest Run and checkpoint. */
export type BrainSource = {
  removed_at?: string | null; checkpoint_generation?: number;
  id: string; database_id: number; version: number; kind: string; display_name: string; enabled: boolean; paused: boolean; executable: boolean;
  schedule: { cadence_seconds: number } | null; sensitivity: BrainSensitivity; collections: string[]; limits: { max_items_per_run: number; max_pages_per_run: number } | null;
  credential_reference_count: number; created_at: string; updated_at: string; due: boolean; payload: Record<string, unknown>; pause_reason: string | null;
  health: { state: "warning" | "never" | "healthy" | "unhealthy"; detail: string | null; last_evaluated_at: string | null; last_success_at: string | null; next_due_at: string | null };
  checkpoint: { present: boolean; run_id: number | null; committed_at: string | null };
  latest_run: { id: number; state: BrainRunState; outcome: "failed" | "cancelled" | "success" | "partial" | null; warnings: number; counts: { discovered: number; admitted: number; suppressed: number };
    created_at: string; finished_at: string | null } | null;
};
/** `submit`: admission proves a durable job exists, never that indexing finished. */
export type BrainSubmissionObservation = { result: { kind: "already_indexed"; document_id: number } |
  { kind: "job"; job_id: number; state: BrainJobState; failure_class: string | null; document_id: number | null; requires_attention: boolean; scope: "exact_job" } | null };
export type BrainSourcesObservation = { result: { scope: "discovery_and_admission"; admission_count: number; run_count: number; no_run_count: number;
  admission_outcomes: Partial<Record<BrainSyncAdmission["status"], number>>; outcomes: Record<string, number>; runs: Array<{ run_id: number; job_id: number | null; outcome: "success" | "partial" | "failed" | "cancelled" | null;
    discovered: number; admitted: number; suppressed: number; warnings: number; checkpoint_committed: boolean }>;
  truncated: boolean; nextOffset: number | null; read: { operation: "sources_sync_completion"; requestId: string; offset: number | null } } | null };
export type BrainAdmission = (
  | { version: 1; status: "queued" | "duplicate"; job_id: number; idempotency_key: string; intent_hash: string; state: BrainJobState; wait_status?: "terminal" | "timeout" }
  | { version: 1; status: "already_indexed"; document_id: number; resource_key: string }) &
  { requestId: string | null; subscription: CompletionReceipt | null; observation: BrainSubmissionObservation | null };
export type BrainSyncAdmission = { source_id: string; source_database_id: number; status: "queued" | "duplicate" | "would_queue" | "not_due" | "disabled" | "paused" | "unsupported";
  run_id: number | null; job_id: number | null; scheduled_for: string | null; dry_run: boolean };
export type BrainSyncResult = { results: BrainSyncAdmission[]; requestId: string | null; subscription: CompletionReceipt | null; observation: BrainSourcesObservation | null };
/** `share_read_states`: a job's state and, once indexed, its document. */
export type BrainShareState = { job_id: number; state: BrainJobState; failure_class: string | null; document_id: number | null };

/** Proc's durable authority: the operator, a Bot bound to its root thread, or the protected system task. */
export type ProcAuthority =
  | { kind: "operator" }
  | { kind: "bot"; botId: string; mainThreadId: string; threadId: string }
  | { kind: "system"; name: string };
/** A schedule's creator and editor may predate attribution. */
export type ProcActor = ProcAuthority | { kind: "legacy_unknown" };
export type ProcProcessSpec = { command: string; args: string[]; cwd?: string; env?: Record<string, string>; timeoutMs: number | null; retainOutput: boolean };
export type ProcAction =
  | { type: "api"; package: string; operation: string; input: unknown }
  | { type: "process"; process: ProcProcessSpec };
/** `proc_schedule_get`: the durable schedule record, with a tombstone's `removedAt` when removed. */
export type ProcSchedule = { id: string; label: string | null; action: ProcAction; firstAt: string; everyMs: number | null; enabled: boolean;
  contentClearedAt?: string | null; specDigest?: string | null;
  revision: number; system: boolean; createdBy: ProcActor; lastEditedBy: ProcActor; authority: ProcAuthority | null;
  blockedReason: string | null; retryAt: string | null; removedAt: string | null; nextAt: string | null; createdAt: string; updatedAt: string };
export type ProcExecutionState = "running" | "completed" | "failed" | "refused" | "unknown";
export type ProcExecutionSummary = { id: string; state: ProcExecutionState; dueAt: string; startedAt: string; finishedAt: string | null; error: string | null };
/** `proc_schedule_list` entries embed up to 12 newest executions, newest first. */
export type ProcScheduleListItem = ProcSchedule & { recent: ProcExecutionSummary[] };
export type ProcExecution = { id: string; scheduleId: string; dueAt: string; state: ProcExecutionState; authority: ProcAuthority | null;
  action: ProcAction | null; processId: string | null; result: unknown; error: string | null; startedAt: string; finishedAt: string | null };
export type ProcRunState = "starting" | "running" | "exited" | "failed" | "cancelled" | "unknown";
/** `proc_run_list` records carry the label and executable path, never arguments, environment or output. */
export type ProcRun = { id: string; label: string | null; command: string | null; scheduleId: string | null; scheduleExecutionId: string | null;
  createdBy: ProcActor; state: ProcRunState; pid: number | null; exitCode: number | null; signal: string | null; error: string | null;
  lineCount: number; outputTruncated: boolean; retainOutput: boolean; startedAt: string; finishedAt: string | null };
/** The persisted process summary: environment variable names only, never values. */
export type ProcProcessSummary = { command: string; args: string[]; cwd: string | null; envKeys: string[]; timeoutMs: number | null; retainOutput: boolean };
export type ProcRunDetail = ProcRun & { process: ProcProcessSummary | null };
export type ProcRunObservation = { result: Pick<ProcRun, "id" | "state" | "exitCode" | "signal" | "error" | "startedAt" | "finishedAt"> | null };
export type ProcRunAdmission = ProcRun & { subscription: CompletionReceipt | null; observation: ProcRunObservation | null };
export type ProcOutputLine = { seq: number; stream: "stdout" | "stderr"; text: string; partial: boolean };
export type ProcOutputPage = { run: ProcRun; lines: ProcOutputLine[]; nextAfter: number; done: boolean; gap: boolean };
export type ProcStatus = { running: number; capacity: number; inFlightCalls: number; callCapacity: number;
  schedules: { total: number; enabled: number; held: number; blocked: number; legacy: number; removed: number };
  lastSweepAt: string | null; lastPruneAt: string | null; closing: boolean; retentionDays: number;
  output: { maxBytes: number; maxLines: number; lineChunkChars: number } };

export type Snapshot = {
  server: Resource<ServerStatus>;
  resources: Resource<ServerResources>;
  accounts: Resource<Account[]>;
  workerAccounts: Resource<WorkerAccount[]>;
  workerRuntimes: Resource<WorkerRuntime[]>;
  workerSessions: Resource<WorkerListItem[]>;
  usage: Resource<UsageSnapshot>;
  login: Resource<Login | null>;
  workerLogins: Resource<WorkerLogin[]>;
  bots: Resource<Bot[]>;
  botDefaults: Resource<BotSettings>;
  voice: Resource<VoiceCall | null>;
  /** The Role catalog only: Role-scoped reads need a selected Role ID, which the page chooses after it loads. */
  roleCatalog: Resource<RoleCatalog>;
  catalog: Resource<PackageDoc[]>;
  endpoints: Record<string, string>;
  /** Null when this server cannot name them, e.g. a random port; older snapshots omit it. */
  contentOrigins?: ContentOrigins | null;
  remote?: { scope: "view" | "control"; scopes: string[]; contentOrigins: ContentOrigins };
};

/**
 * Owner state wire contracts, mirrored from `@stack/api` (`packages/api/src/state.ts` and `state-files.ts`) so no
 * Node-backed module reaches the browser bundle. See docs/state-control.md and ADR 0135.
 */
export type StateSubject = { kind: string; id: string };
/** An operation link. Empty `arguments` describe a drill-down: choose an exact resource through the owner's read first. */
export type StateLink = { package: string; operation: string; arguments: Record<string, unknown> };
export type StateRelationship = { relation: string; package: string; kind: string; id: string };
export type StateEntry = {
  id: string;
  ownerPackage: string;
  subject: StateSubject | null;
  kind: "workspace" | "conversation" | "queue" | "history" | "configuration" | "credentials" | "cache" | "runtime" | "storage";
  authority: "authoritative" | "derived" | "receipt";
  location: "server" | "client" | "external";
  ownership: "stack" | "external" | "shared" | "unknown";
  revision: string | null;
  observedAt: string;
  coverage: "complete" | "partial" | "unavailable";
  /** Null is unmeasured, never zero. */
  items: number | null;
  /** Null is unmeasured, never zero. Overlapping or shared stores must not be summed. */
  bytes: number | null;
  sensitivity: "ordinary" | "content" | "credential";
  relationships: StateRelationship[];
  reads: StateLink[];
  actions: (StateLink & { blockedBy: string[] })[];
  retention: string;
  regeneration: string;
  issues: string[];
};
export type StatePage = { entries: StateEntry[]; revision: string; observedAt: string; nextOffset: number | null };
/** Availability of one owner in `serve_state_list`: an unavailable owner is a gap, not an empty store. */
export type StateOwner = { package: string; available: boolean; issue: string | null };
export type ServeStateList = StatePage & { owners: StateOwner[] };
export type StateOutcome = { resource: string; outcome: "removed" | "retained" | "blocked" | "unknown" | "pending"; detail: string };
export type StatePlan = {
  id: string; ownerPackage: string; subject: StateSubject | null; action: string; revision: string;
  createdAt: string; expiresAt: string; resources: string[]; blockedBy: string[]; retained: string[]; regeneration: string[];
};
export type StateApplyInput = { planId: string; expectedRevision: string; requestId: string };
export type StateReceiptStatus = "running" | "completed" | "partial" | "blocked" | "unknown";
export type StateReceipt = {
  requestId: string; planId: string; ownerPackage: string; subject: StateSubject | null; action: string;
  status: StateReceiptStatus; startedAt: string; completedAt: string | null;
  outcomes: StateOutcome[]; retained: string[]; regeneration: string[];
};
export type StateFile = { path: string; type: "file" | "directory" | "symlink" | "special"; bytes: number; modifiedAt: string; revision: string };
export type StateFilePage = { entries: StateFile[]; revision: string; nextOffset: number | null };
/** One bounded chunk (at most 256 KiB) of base64 bytes. */
export type StateFileRead = { data: string; encoding: "base64"; bytes: number; totalBytes: number; nextOffset: number | null; revision: string };

/** A durable Bot event subscription as `serve_subscription_list` pages it: read arguments and error text are excluded. */
export type ServeSubscription = {
  id: string; botId: string; threadId: string; instance: string; pkg: string; topic: string; scope: string | null;
  readOperation: string; state: "connecting" | "active" | "delivering" | "error"; lastDeliveredAt: number | null; revision: string;
  completion: { operation: string; terminalField: string; retainFields?: string[]; updateField?: string; declaration?: CompletionWatch } | null;
};
/** `serve_subscription_get`'s explicit drill-down, which can reveal sensitive read arguments and the last error. */
export type ServeSubscriptionDetail = ServeSubscription & { readArguments: Record<string, unknown>; lastError: string | null };
export type ServeSubscriptionPage = { subscriptions: ServeSubscription[]; revision: string; nextOffset: number | null };

export type ChannelStatus = "idle" | "connecting" | "open" | "closed";

export type StackEvent = {
  seq: number;
  at: number;
  pkg: string;
  topic: string;
  scope: string | null;
};

export type NodeRef =
  | { kind: "access-client" | "access-pairing" | "access-grant" | "access-credential"; id: string }
  | { kind: "server" }
  | { kind: "child"; id: string }
  /** A Codex tool bridge's server-wide availability observation, by connection key. */
  | { kind: "codex-tool"; id: string }
  | { kind: "resource"; id: string }
  | { kind: "process"; id: string }
  | { kind: "account"; id: string }
  | { kind: "worker-account"; id: string }
  | { kind: "worker-catalog"; id: string }
  /** A durable Worker session, by Worker ID. */
  | { kind: "worker"; id: string }
  /** A Worker account's runtime, by account ID. */
  | { kind: "worker-runtime"; id: string }
  /** A Worker window on the bench, by window ID; it has no inspectable record. */
  | { kind: "worker-window"; id: string }
  | { kind: "usage" }
  | { kind: "usage-account"; id: string }
  | { kind: "login" }
  | { kind: "bot"; id: string }
  /** A chat window on the bench, by window ID; it has no inspectable record. */
  | { kind: "chat"; id: string }
  /** A named Role from the catalog, by Role ID. */
  | { kind: "role"; id: string }
  | { kind: "category"; id: string }
  | { kind: "fragment"; id: string }
  | { kind: "notification"; id: string }
  | { kind: "skill"; id: string }
  | { kind: "mcp-server"; id: string }
  | { kind: "trusted-project"; id: string }
  /** An installed Role shim, by command name. It belongs to no Role. */
  | { kind: "role-shim"; id: string }
  | { kind: "signal" }
  | { kind: "attention-item" | "attention-message" | "attention-run"; id: string }
  /** A Scrape extraction preset by name, and a scrape-to-file job by its `scrape_queue_list` ID. */
  | { kind: "preset" | "scrape-job"; id: string }
  /** Browse records: a profile and a handoff by ID, a controller by `botId/instance/session`, and a viewer window by window ID. */
  | { kind: "browser-profile" | "browser-handoff" | "browser-controller" | "browser-viewer"; id: string }
  /** Brain records by their numeric document or job ID, and a Research source by its definition ID. */
  | { kind: "research-document" | "ingestion-job" | "research-source"; id: string }
  /** Proc records: a schedule, a scheduled execution and a process run, each by ID. */
  | { kind: "proc-schedule" | "proc-execution" | "proc-run"; id: string }
  /** A Run window on the bench, by window ID; it has no inspectable record. */
  | { kind: "proc-run-window"; id: string }
  /** A shared HUD Work item, by its UUID. */
  | { kind: "work-item"; id: string }
  /** An owner state inventory entry by its `<owner>:<category>` ID, and a durable Bot event subscription by UUID. Local only. */
  | { kind: "state-entry" | "subscription"; id: string }
  /** Fleet's state view of one Bot, by Bot ID. Local only. */
  | { kind: "bot-state"; id: string }
  | { kind: "package"; id: string }
  | { kind: "operation"; id: string; pkg: string }
  /** Content records: a Vault document by slug, a collection by slug, an item by stable ID, an Artifact by name. */
  | { kind: "document"; id: string }
  | { kind: "collection"; id: string }
  | { kind: "item"; id: string }
  | { kind: "artifact"; id: string };

export function nodeKey(ref: NodeRef): string {
  if (ref.kind === "operation") return `operation:${ref.pkg}.${ref.id}`;
  return "id" in ref ? `${ref.kind}:${ref.id}` : ref.kind;
}
