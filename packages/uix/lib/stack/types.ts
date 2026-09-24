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
};

export type Account = { id: string; active: boolean; removing: boolean };
export type WorkerAccount = { id: string; provider: "codex" | "grok" | "devin"; enabled: boolean; ready: boolean; removing: boolean };
export type WorkerRuntime = { id: string; provider: WorkerAccount["provider"]; state: "running" | "stopped" | "error"; pid: number | null; error: string | null };
export type WorkerSession = { id: string; botId: string; threadId: string; accountId: string; provider: WorkerAccount["provider"];
  model: string; effort: string | null; repo: string; cwd: string | null; branch: string | null; baseCommit: string | null;
  sourceDirty: boolean; roleRevision: number | null; acpSessionId: string | null;
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
  | { kind: "login" }
  | { kind: "bot"; id: string }
  | { kind: "package"; id: string }
  | { kind: "operation"; id: string; pkg: string };

export function nodeKey(ref: NodeRef): string {
  if (ref.kind === "operation") return `operation:${ref.pkg}.${ref.id}`;
  return "id" in ref ? `${ref.kind}:${ref.id}` : ref.kind;
}
