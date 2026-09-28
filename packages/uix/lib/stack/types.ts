export type AccessSnapshot = {
  serverId: string;
  clients: { id: string; label: string; kind: string; created: number; revoked: number | null }[];
  pairings: { id: string; code: string; label: string; kind: string; scopes: string[]; created: number; expires: number; state: string }[];
  grants: { id: string; client_id: string; network: "tailnet" | "public-cloud"; scopes: string[]; operations: string[]; created: number; revoked: number | null; revision: number }[];
  credentials: { id: string; client_id: string; grant_id: string; generation: number; created: number; expires: number; revoked: number | null }[];
  audit: { seq: number; time: number; action: string; subject: string }[];
  ingress: { host: string; port: number; artifactPort: number; uixPort: number | null } | null;
  uixSessions: { credential_id: string; expires: number }[];
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

export type OperationDoc = {
  name: string;
  title: string | null;
  description: string;
  annotations: Record<string, boolean | string>;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
};

export type TransportDoc = {
  type: string;
  description: string;
  supported: boolean;
  subscriptions: boolean;
  endpoint: string | null;
  operations: string[];
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
  model: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
  approvalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
};

export type Bot = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: "running" | "stopped";
  account: string | null;
  runningAccount: string | null;
  mainThreadId: string | null;
  recoveryIssue: string | null;
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
export type ChatQueueEntry = { id: string; botId: string; threadId: string; input: unknown[];
  state: "pending" | "dispatching" | "sent" | "unknown" | "cancelled"; turnId: string | null; issue: string | null };

export type Account = { id: string; enabled: boolean; removing: boolean; linkedAccounts: Array<{ scope: "bot" | "worker"; id: string }> };
export type WorkerAccount = Account & { provider: "codex" | "grok" | "devin" | "claude"; ready: boolean };
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
export type GrokUsage = { subscriptionTier: string | null;
  included: { usedPercent: number | null; remainingPercent: number | null; periodType: string | null; periodStart: string | null; resetsAt: string | null; allocatedUsd: number | null };
  prepaidBalanceUsd: number | null; paygEnabled: boolean | null; paygUsedUsd: number | null; paygCapUsd: number | null; paygRemainingUsd: number | null };
export type DevinUsage = { planLabel: string | null; billing: string | null; dailyRemainingPercent: number | null;
  weeklyRemainingPercent: number | null; dailyResetsAt: string | null; weeklyResetsAt: string | null; periodStart: string | null;
  periodEnd: string | null; promptCreditsMonthly: number | null; promptCreditsAvailable: number | null; weeklyQuotaHidden: boolean | null; displayName: string | null };
export type ClaudeUsage = { windows: Array<{ id: string; label: string; usedPercent: number; remainingPercent: number; resetsAt: string | null }>;
  extraUsage: { enabled: boolean | null; monthlyLimit: number | null; usedCredits: number | null; utilization: number | null } | null };
export type UsageSubscription = { endsAt: string; source: "plan_period" | "sign_in_claim"; checkedAtMs: number | null };
export type UsageAccount = UsageObservation & { id: string; enabled: boolean; ready: boolean; linkedAccounts: Account["linkedAccounts"];
  subscription: UsageSubscription | null } & (
  | { provider: "codex"; scope: "bot" | "worker"; usage: CodexUsage | null }
  | { provider: "grok"; scope: "worker"; usage: GrokUsage | null }
  | { provider: "devin"; scope: "worker"; usage: DevinUsage | null }
  | { provider: "claude"; scope: "worker"; usage: ClaudeUsage | null });
export type UsageSnapshot = { atMs: number; inventoryAtMs: number | null; inventoryError: "not_observed" | "auth_unavailable" | null;
  /** Null unless a signed-in Grok Worker account exists. */
  accounts: UsageAccount[]; grokBot: null | UsageObservation & { usage: { usedPercent: number; periodStart: string; resetsAt: string;
    hasAvailableUsage: boolean; planLabel: string | null; fundingPlan: string | null; onDemandEligible: boolean | null;
    onDemandEnabled: boolean | null; trial: boolean | null; teamSeat: boolean | null } | null } };
export type WorkerSession = { id: string; botId: string; threadId: string; accountId: string; provider: WorkerAccount["provider"];
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleRevision: number | null; sessionId: string | null; runtimeInstance: string | null;
  phase: "preparing" | "idle" | "running" | "awaiting_input" | "cancelling" | "closed" | "failed" | "needs_recovery";
  currentTurnId: string | null; issue: string | null; createdAt: number; updatedAt: number };

/** API-only conversation details; existing Worker account cards still read worker_list. */
export type WorkerObservedSettings = { model: string | null; effort: string | null; mode: string | null; at: number; recordSeq: number };
export type WorkerTurn = { id: string; workerId: string;
  phase: "queued" | "running" | "awaiting_input" | "cancelling" | "completed" | "cancelled" | "failed" | "unknown";
  stopReason: string | null; issue: string | null; requestId: string; prompt: string | null;
  requestedModel: string | null; requestedEffort: string | null; observedSettings: WorkerObservedSettings | null;
  dispatchedAt: number | null; dispatchedPromptSeq: number | null; createdAt: number; updatedAt: number };
export type WorkerTurnSummary = Omit<WorkerTurn, "prompt"> & { promptChars: number | null };
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
export type WorkerRecordPage = { entries: WorkerRecord[]; nextSeq: number; hasMore: boolean; capture: WorkerCapture };
export type WorkerRecordChunk = { seq: number; offset: number; data: string; nextOffset: number; totalChars: number; hasMore: boolean; encoding: "json-utf16" };
export type WorkerTool = { toolCallId: string; turnId: string | null; firstSeq: number; lastSeq: number;
  title: string | null; kind: string | null; status: string | null; record: WorkerRecord };
export type WorkerTask = { toolCallId: string; sessionId: string; callingSessionId: string; toolStatus: string | null; background: boolean;
  model: { providerID: string | null; modelID: string | null } | null; recordSeq: number;
  visibility: "task_reference"; hierarchyVerified: false; childStatus: "unknown" };
export type WorkerToolPage = { tools: WorkerTool[]; tasks: WorkerTask[]; nextSeq: number; hasMore: boolean };

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

export type OwnerChild = {
  name: string;
  pid: number | null;
  running: boolean;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  startedAt: string | null;
  exitedAt: string | null;
};

export type OwnerStatus = {
  pid: number;
  startedAt: string;
  nodeVersion: string;
  indexUrl: string | null;
  uixUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: OwnerChild[];
};

/** Mirror of the owner resource API's wire shapes (packages/owner resources schema). */
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
  mode: "owner_tree" | "self_only";
  observedHostProcesses: number;
  ownedProcesses: number;
  unreadableProcesses: number;
  vanishedDuringCollection: number;
  retainedProcesses: number;
  excludedCollectorProcesses: number;
  domains: DomainStatus[];
};
export type ResourceError = "unsupported_platform" | "collection_failed" | "collection_timeout" | "process_limit" | "owner_missing" | "process_capacity";
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
export type OwnerRuntime = {
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
/** `owner_resource_history` wire page. */
export type ResourceHistoryPage = {
  scopeId: string;
  intervalMs: number;
  retention: ResourceRetention;
  truncated: boolean;
  points: ResourceHistoryPoint[];
};
/** `owner_resources` flattened to what the bench needs: every scope plus the paged process list of `total`. */
export type OwnerResources = {
  observation: ResourceObservation;
  host: ResourceHost | null;
  capabilities: ResourceCapabilities;
  retention: ResourceRetention;
  runtime: OwnerRuntime | null;
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
export type AttentionStatus = { enabled: boolean; activatedAt: number | null; baselined: boolean; settings: AttentionDefaults;
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
export type AttentionMessage = { cursor: number; seq: number; id: string; logicalId: string; revision: string; current: boolean;
  source: "bots" | "workers"; conversation: string; key: string; role: "user" | "assistant"; authorKind: "human" | "agent" | "unknown";
  audienceHint?: "human" | "agent" | "unknown"; botId: string | null; text: string; textChars: number; complete: boolean; occurredAt: string | null; observedAt: number };
/** `failed` is definite; `unknown` may have dispatched and needs an explicit replay decision. */
export type AttentionRun = { cursor: number; id: string; jobId: string; messageId: string | null; replay: boolean; replayOf: string | null; promptVersion: string | null;
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
export type RoleFragment = { id: string; categoryId: string; title: string; description: string; body: string; enabled: boolean;
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
/** `role_snapshot`: one revision covers instructions, skills, MCP servers and trusted projects. */
export type RoleSnapshot = { revision: number; categories: RoleCategory[]; skills: RoleSkill[]; mcpServers: RoleMcpServer[]; trustedProjects: RoleTrustedProject[] };
/** `role_preview`: the exact SYSTEM_APPEND.md text for the next launch, with each fragment's [start, end) span. */
export type RolePreview = { revision: number; rendered: string; bytes: number; limitBytes: number;
  segments: Array<{ categoryId: string; fragmentId: string; start: number; end: number }> };

/** How a Notification was dismissed: once, with the chosen action label or reply text as `response`. */
export type NotificationOutcome = "closed" | "opened" | "action" | "replied" | "replaced";
/** A `notify` Notification; open until `dismissedAt`. Actions, reply and open are data; nothing executes. */
export type Notification = { id: string; sequence: number; title: string; message: string; subtitle: string | null; source: string | null;
  group: string | null; open: string | null; actions: string[]; reply: string | null; createdAt: string;
  dismissedAt: string | null; outcome: NotificationOutcome | null; response: string | null };
/** `notification_counts`. A null source counts notifications sent without one. */
export type NotificationCounts = { open: number; total: number; sources: Array<{ source: string | null; open: number; total: number }> };
/** The Inbox's view of `notification_list`: which filter it shows and the pages loaded so far. */
export type NotificationFilter = { dismissed?: boolean; source?: string };
export type NotificationPages = { filter: NotificationFilter; entries: Notification[]; nextCursor: number | null };
/** `role_launch_preview`: what the next launch receives besides instructions, matched against given working directories. */
export type RoleLaunchPreview = {
  revision: number;
  instructions: { bytes: number; limitBytes: number; fragments: number };
  skills: Array<{ id: string; name: string; description: string; files: number; bytes: number }>;
  internalMcpServers: string[];
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
/** Loopback HTTP origins of the Content backends, known to the UIX server from its environment. */
export type ContentOrigins = { document: string; artifact: string };
/** One browser upload through resumable blob stages; `stalled` resumes from the server's acknowledged offset. */
export type ContentUpload = { key: string; name: string; bytes: number; received: number; collection: string | null;
  phase: "hashing" | "uploading" | "storing" | "done" | "stalled" | "failed"; error: string | null; itemId: string | null; stageId: string | null;
  /** False once item_put may have stored the item: retrying could create a duplicate. */
  retryable: boolean };

export type Resource<T> = { data: T | null; error: string | null; at: number | null };

export type Snapshot = {
  owner: Resource<OwnerStatus>;
  resources: Resource<OwnerResources>;
  accounts: Resource<Account[]>;
  workerAccounts: Resource<WorkerAccount[]>;
  workerRuntimes: Resource<WorkerRuntime[]>;
  workerSessions: Resource<WorkerSession[]>;
  usage: Resource<UsageSnapshot>;
  login: Resource<Login | null>;
  workerLogins: Resource<WorkerLogin[]>;
  bots: Resource<Bot[]>;
  botDefaults: Resource<BotSettings>;
  voice: Resource<VoiceCall | null>;
  role: Resource<RoleSnapshot>;
  rolePreview: Resource<RolePreview>;
  catalog: Resource<PackageDoc[]>;
  endpoints: Record<string, string>;
  /** Null when this server cannot name them, e.g. a random port; older snapshots omit it. */
  contentOrigins?: ContentOrigins | null;
  remote?: { scope: "view" | "control"; scopes: string[]; contentOrigins: ContentOrigins };
};

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
  | { kind: "owner" }
  | { kind: "child"; id: string }
  | { kind: "resource"; id: string }
  | { kind: "process"; id: string }
  | { kind: "account"; id: string }
  | { kind: "worker-account"; id: string }
  | { kind: "worker-catalog"; id: string }
  | { kind: "usage" }
  | { kind: "usage-account"; id: string }
  | { kind: "grok-bot-usage" }
  | { kind: "login" }
  | { kind: "bot"; id: string }
  /** A chat window on the bench, by window ID; it has no inspectable record. */
  | { kind: "chat"; id: string }
  | { kind: "category"; id: string }
  | { kind: "fragment"; id: string }
  | { kind: "notification"; id: string }
  | { kind: "skill"; id: string }
  | { kind: "mcp-server"; id: string }
  | { kind: "trusted-project"; id: string }
  | { kind: "signal" }
  | { kind: "attention-item" | "attention-message" | "attention-run"; id: string }
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
