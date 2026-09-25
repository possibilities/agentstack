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

/** Bot chat APIs expose sanctioned Codex threads; the canvas does not yet browse them. */
export type Chat = { botId: string; threadId: string; parentThreadId: string | null; title: string; cwd: string;
  createdAt: string; updatedAt: string; messageCount: number };
export type ChatHit = Chat & { line: number; role: string; snippet: string; score: number };
export type ChatQueueEntry = { id: string; botId: string; threadId: string; input: unknown[];
  state: "pending" | "dispatching" | "sent" | "unknown" | "cancelled"; turnId: string | null; issue: string | null };

export type Account = { id: string; enabled: boolean; removing: boolean; linkedAccounts: Array<{ scope: "bot" | "worker"; id: string }> };
export type WorkerAccount = Account & { provider: "codex" | "grok" | "devin"; ready: boolean };
export type WorkerRuntime = { id: string; provider: WorkerAccount["provider"]; state: "running" | "stopped" | "error"; pid: number | null; instance: string | null; error: string | null };
export type WorkerSession = { id: string; botId: string; threadId: string; accountId: string; provider: WorkerAccount["provider"];
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleRevision: number | null; acpSessionId: string | null; runtimeInstance: string | null;
  phase: "preparing" | "idle" | "running" | "awaiting_input" | "cancelling" | "closed" | "failed" | "needs_recovery";
  currentTurnId: string | null; issue: string | null; createdAt: number; updatedAt: number };

export type Login = {
  id: string;
  status: "pending" | "complete" | "failed";
  authUrl: string | null;
  userCode: string | null;
  account: string | null;
  error: string | null;
  targetAccount: string | null;
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

export type Resource<T> = { data: T | null; error: string | null; at: number | null };

export type Snapshot = {
  owner: Resource<OwnerStatus>;
  accounts: Resource<Account[]>;
  workerAccounts: Resource<WorkerAccount[]>;
  workerRuntimes: Resource<WorkerRuntime[]>;
  workerSessions: Resource<WorkerSession[]>;
  login: Resource<Login | null>;
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
  | { kind: "login" }
  | { kind: "bot"; id: string }
  | { kind: "package"; id: string }
  | { kind: "operation"; id: string; pkg: string };

export function nodeKey(ref: NodeRef): string {
  if (ref.kind === "operation") return `operation:${ref.pkg}.${ref.id}`;
  return "id" in ref ? `${ref.kind}:${ref.id}` : ref.kind;
}
