import { z } from "zod";
import { operation, withLocalAuth, localOrigin, type PackageApi } from "@agentstack/api";
import { statusSource, type StatusSource } from "./src/status.js";
import { ResourceMonitor } from "./src/resources/monitor.js";
import { ownerResourcesInput, ownerResourcesOutput, ownerResourceHistoryInput, ownerResourceHistoryOutput } from "./src/resources/schema.js";

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

export type OwnerContext = {
  source: StatusSource;
  resources: ResourceMonitor;
  env?: NodeJS.ProcessEnv;
};

export const ownerLocalConnect = operation({
  name: "owner_local_connect", description: "Private-socket-only operator bootstrap. Mint a 60-second single-use browser capability, bound to the exact local UIX or Inspector origin. The returned fragment URL is a secret; never log or put it in discovery. The CLI opens it directly. An explicit UIX origin is allowed only for the configured development WebSocket origin.",
  input: z.strictObject({ target: z.enum(["uix", "inspector"]).default("uix"), origin: z.string().optional() }),
  output: z.strictObject({ url: z.string(), expiresInSeconds: z.literal(60) }),
  async call(ctx: OwnerContext, input, invocation) {
    if (invocation) throw new Error("local bootstrap requires private socket authority");
    const env = ctx.env ?? process.env;
    const origin = input.origin ?? `http://127.0.0.1:${input.target === "uix" ? env.AGENTSTACK_UIX_PORT ?? 8745 : env.AGENTSTACK_INSPECTOR_PORT ?? 6274}`;
    localOrigin(origin);
    if (input.origin && !(input.target === "uix" && input.origin === env.AGENTSTACK_WEBSOCKET_ORIGIN)) throw new Error("development origin is not configured");
    const token = withLocalAuth(env, auth => auth.bootstrap(origin, input.target));
    return { url: `${origin}/connect/local#${token}`, expiresInSeconds: 60 as const };
  },
});
export const ownerLocalRevoke = operation({
  name: "owner_local_revoke", description: "Private-socket-only operator reset of local TCP authority. Rotates the operator bearer credential and invalidates all local browser sessions, bootstrap links and WebSocket tickets. Active local connections are fenced. Remote Access grants and signed Bot/Worker identities remain independently authorized. Native operator clients must reload their private credential.",
  input: z.strictObject({}), output: z.strictObject({ revoked: z.literal(true) }),
  async call(ctx: OwnerContext, _input, invocation) {
    if (invocation) throw new Error("local revocation requires private socket authority");
    withLocalAuth(ctx.env ?? process.env, auth => auth.rotate());
    return { revoked: true as const };
  },
});

export const ownerStatus = operation({
  name: "owner_status",
  description: "Read the owner process, its start time and runtime, its local URLs, and each required child's status: pid, running, start/exit times, exit code, signal, and spawn error.",
  input: z.strictObject({}),
  output: z.object({
    pid: z.number().int().describe("Owner process id."),
    startedAt: z.iso.datetime().describe("Time the owner process started."),
    nodeVersion: z.string().describe("Node.js version string of the owner process."),
    indexUrl: z.string().nullable().describe("Loopback UI entry URL; / redirects to the /x canvas while the owner runs it."),
    uixUrl: z.string().nullable().describe("Loopback /x canvas URL while the owner runs it."),
    inspectorUrl: z.string().nullable().describe("Loopback Inspector URL while the owner runs it."),
    mcpUrls: z.record(z.string(), z.string()).describe("Loopback MCP URLs by Package API name."),
    children: z.array(childStatusSchema),
  }),
  annotations: { title: "Owner status", readOnlyHint: true },
  async call(ctx: OwnerContext) {
    return ctx.source.snapshot();
  },
});

export const ownerResources = operation({
  name: "owner_resources",
  description: "Read cached CPU, memory and process-tree observations for AgentStack, components, Bots, accounts, observed Worker runtimes or individual processes/subtrees. Pin snapshotId when paging. Costs overlap across scope kinds; RSS is not unique RAM. Unknown/expired IDs are errors. No collection is triggered by a read.",
  input: ownerResourcesInput, output: ownerResourcesOutput,
  annotations: { title: "Owner resource snapshot", readOnlyHint: true },
  async call(ctx: OwnerContext, input) { return ctx.resources.resources(input); },
});

export const ownerResourceHistory = operation({
  name: "owner_resource_history",
  description: "Read bounded in-memory resource history for one returned scope ID (default total), oldest first. Failed attempts are explicit gaps, absent scopes are null, retention may shorten under process pressure. Shared runtimes cannot allocate costs to Worker sessions or chats.",
  input: ownerResourceHistoryInput, output: ownerResourceHistoryOutput,
  annotations: { title: "Owner resource history", readOnlyHint: true },
  async call(ctx: OwnerContext, input) { return ctx.resources.history(input); },
});

export const topics = {
  pids_changed: "Published when the set of owned child process ids changes.",
  resources_changed: "Published after a resource sampling attempt, including failures. Refresh owner_resources or owner_resource_history; notices carry no metrics.",
} as const;

export type OwnerTopic = keyof typeof topics;

export const api: PackageApi<OwnerContext, OwnerTopic> = {
  operations: [ownerStatus, ownerResources, ownerResourceHistory, ownerLocalConnect, ownerLocalRevoke],
  events: {
    topics,
    start(ctx: OwnerContext, publish: (topic: OwnerTopic) => void) {
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
