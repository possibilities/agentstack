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
/** Bot tools expose these records; a dedicated transcript reader can build on them. */
export type MainChatLive = { threadId: string | null; instance: string | null; revision: number; activeTurnId: string | null;
  coverage: "partial"; items: Array<{ turnId: string; item: Record<string, unknown>; complete: boolean; completed: boolean; omitted: boolean }> };
export type MainChatItems = { threadId: string; data: Array<Record<string, unknown>>; nextCursor: string | null };
export type ChatHit = Chat & { line: number; role: string; snippet: string; score: number };
export type ChatQueueEntry = { id: string; botId: string; threadId: string; input: unknown[];
  state: "pending" | "dispatching" | "sent" | "unknown" | "cancelled"; turnId: string | null; issue: string | null };

export type Account = { id: string; enabled: boolean; removing: boolean; linkedAccounts: Array<{ scope: "bot" | "worker"; id: string }> };
export type WorkerAccount = Account & { provider: "codex" | "grok" | "devin"; ready: boolean };
export type WorkerRuntime = { id: string; provider: WorkerAccount["provider"]; state: "running" | "stopped" | "error"; pid: number | null; instance: string | null; error: string | null };
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
export type UsageAccount = UsageObservation & { id: string; enabled: boolean; ready: boolean; linkedAccounts: Account["linkedAccounts"] } & (
  | { provider: "codex"; scope: "bot" | "worker"; usage: CodexUsage | null }
  | { provider: "grok"; scope: "worker"; usage: GrokUsage | null }
  | { provider: "devin"; scope: "worker"; usage: DevinUsage | null });
export type UsageSnapshot = { atMs: number; inventoryAtMs: number | null; inventoryError: "not_observed" | "auth_unavailable" | null;
  accounts: UsageAccount[]; grokBot: UsageObservation & { usage: { usedPercent: number; periodStart: string; resetsAt: string;
    hasAvailableUsage: boolean; planLabel: string | null; fundingPlan: string | null; onDemandEligible: boolean | null;
    onDemandEnabled: boolean | null; trial: boolean | null; teamSeat: boolean | null } | null } };
export type WorkerSession = { id: string; botId: string; threadId: string; accountId: string; provider: WorkerAccount["provider"];
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleRevision: number | null; acpSessionId: string | null; runtimeInstance: string | null;
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
};

export type OwnerStatus = {
  pid: number;
  docsUrl: string | null;
  indexUrl: string | null;
  uixUrl: string | null;
  inspectorUrl: string | null;
  mcpUrls: Record<string, string>;
  children: OwnerChild[];
};

export type VoiceCall = {
  sessionId: string;
  botId: string;
  threadId: string;
  phase: "dialing" | "connected";
};

/** Bot tools expose the voice_speak receipt; submission does not confirm audible playback. */
export type VoiceSpeechSubmission = { sessionId: string; status: "submitted" };

export type Resource<T> = { data: T | null; error: string | null; at: number | null };

export type Snapshot = {
  owner: Resource<OwnerStatus>;
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
  catalog: Resource<PackageDoc[]>;
  endpoints: Record<string, string>;
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
  | { kind: "owner" }
  | { kind: "child"; id: string }
  | { kind: "account"; id: string }
  | { kind: "worker-account"; id: string }
  | { kind: "worker-catalog"; id: string }
  | { kind: "usage" }
  | { kind: "usage-account"; id: string }
  | { kind: "grok-bot-usage" }
  | { kind: "login" }
  | { kind: "bot"; id: string }
  | { kind: "package"; id: string }
  | { kind: "operation"; id: string; pkg: string };

export function nodeKey(ref: NodeRef): string {
  if (ref.kind === "operation") return `operation:${ref.pkg}.${ref.id}`;
  return "id" in ref ? `${ref.kind}:${ref.id}` : ref.kind;
}
