import { z } from "zod";
import { operation, withLocalAuth, localOrigin, type PackageApi } from "@agentstack/api";
import { statusSource, type StatusSource } from "./src/status.js";
import { ResourceMonitor } from "./src/resources/monitor.js";
import { serverResourcesInput, serverResourcesOutput, serverResourceHistoryInput, serverResourceHistoryOutput } from "./src/resources/schema.js";

const childStatusSchema = z.object({
  name: z.string().describe("Required child name."),
  pid: z.number().int().nullable().describe("Process id while running, otherwise null."),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  error: z.string().nullable().describe("Spawn failure message, if any."),
  startedAt: z.iso.datetime().nullable().describe("Time the child's spawn event fired; null if it never spawned."),
  exitedAt: z.iso.datetime().nullable().describe("Time the child exited or its spawn failed; null while running."),
});

export type ServerContext = {
  source: StatusSource;
  resources: ResourceMonitor;
  env?: NodeJS.ProcessEnv;
};

export const serverLocalConnect = operation({
  name: "serve_local_connect", description: "Private-socket-only operator bootstrap. Mint a 60-second single-use browser capability, bound to the exact local UI or Inspector origin. The returned fragment URL is a secret; never log or put it in discovery. The CLI opens it directly. An explicit UI origin is allowed only for the configured development WebSocket origin.",
  input: z.strictObject({ target: z.enum(["ui", "inspector"]).default("ui"), origin: z.string().optional() }),
  output: z.strictObject({ url: z.string(), expiresInSeconds: z.literal(60) }),
  async call(ctx: ServerContext, input, invocation) {
    if (invocation) throw new Error("local bootstrap requires private socket authority");
    const env = ctx.env ?? process.env;
    const origin = input.origin ?? `http://127.0.0.1:${input.target === "ui" ? env.AGENTSTACK_UI_PORT ?? 8745 : env.AGENTSTACK_INSPECTOR_PORT ?? 6274}`;
    localOrigin(origin);
    if (input.origin && !(input.target === "ui" && input.origin === env.AGENTSTACK_WEBSOCKET_ORIGIN)) throw new Error("development origin is not configured");
    const token = withLocalAuth(env, auth => auth.bootstrap(origin, input.target));
    return { url: `${origin}/connect/local#${token}`, expiresInSeconds: 60 as const };
  },
});
export const serverLocalRevoke = operation({
  name: "serve_local_revoke", description: "Private-socket-only operator reset of local TCP authority. Rotates the operator bearer credential and invalidates all local browser sessions, bootstrap links and WebSocket tickets. Active local connections are fenced. Remote Access grants and signed Bot/Worker identities remain independently authorized. Native operator clients must reload their private credential.",
  input: z.strictObject({}), output: z.strictObject({ revoked: z.literal(true) }),
  async call(ctx: ServerContext, _input, invocation) {
    if (invocation) throw new Error("local revocation requires private socket authority");
    withLocalAuth(ctx.env ?? process.env, auth => auth.rotate());
    return { revoked: true as const };
  },
});

export const serverStatus = operation({
  name: "serve_status",
  description: "Read the server process, its start time and runtime, its local URLs, and each required child's status: pid, running, start/exit times, exit code, signal, and spawn error.",
  input: z.strictObject({}),
  output: z.object({
    pid: z.number().int().describe("Server process id."),
    startedAt: z.iso.datetime().describe("Time the server process started."),
    nodeVersion: z.string().describe("Node.js version string of the server process."),
    indexUrl: z.string().nullable().describe("Loopback UI entry URL for the Fleet bench while the server runs it."),
    uiUrl: z.string().nullable().describe("Loopback UI canvas URL at / while the server runs it."),
    inspectorUrl: z.string().nullable().describe("Loopback Inspector URL while the server runs it."),
    mcpUrls: z.record(z.string(), z.string()).describe("Loopback MCP URLs by Package API name."),
    children: z.array(childStatusSchema),
  }),
  annotations: { title: "Server status", readOnlyHint: true },
  async call(ctx: ServerContext) {
    return ctx.source.snapshot();
  },
});

export const serverResources = operation({
  name: "serve_resources",
  description: "Read cached CPU, memory and process-tree observations for AgentStack, components, Bots, accounts, observed Worker runtimes or individual processes/subtrees. Pin snapshotId when paging. Costs overlap across scope kinds; RSS is not unique RAM. Unknown/expired IDs are errors. No collection is triggered by a read.",
  input: serverResourcesInput, output: serverResourcesOutput,
  annotations: { title: "Server resource snapshot", readOnlyHint: true },
  async call(ctx: ServerContext, input) { return ctx.resources.resources(input); },
});

export const serverResourceHistory = operation({
  name: "serve_resource_history",
  description: "Read bounded in-memory resource history for one returned scope ID (default total), oldest first. Failed attempts are explicit gaps, absent scopes are null, retention may shorten under process pressure. Shared runtimes cannot allocate costs to Worker sessions or chats.",
  input: serverResourceHistoryInput, output: serverResourceHistoryOutput,
  annotations: { title: "Server resource history", readOnlyHint: true },
  async call(ctx: ServerContext, input) { return ctx.resources.history(input); },
});

export const topics = {
  pids_changed: "Published when the set of owned child process ids changes.",
  resources_changed: "Published after a resource sampling attempt, including failures. Refresh serve_resources or serve_resource_history; notices carry no metrics.",
} as const;

export type ServerTopic = keyof typeof topics;

export const api: PackageApi<ServerContext, ServerTopic> = {
  operations: [serverStatus, serverResources, serverResourceHistory, serverLocalConnect, serverLocalRevoke],
  events: {
    topics,
    start(ctx: ServerContext, publish: (topic: ServerTopic) => void) {
      ctx.source.onChange = () => publish("pids_changed");
      ctx.resources.onChange = () => publish("resources_changed");
      return () => {
        ctx.source.onChange = undefined;
        ctx.resources.onChange = undefined;
      };
    },
  },
  async createContext(env) {
    const resources = new ResourceMonitor({ roots: () => statusSource.resourceRoots(), env });
    resources.start();
    return { source: statusSource, resources, env };
  },
  async closeContext(ctx) {
    await ctx.resources.close();
    ctx.source.detach();
  },
};
