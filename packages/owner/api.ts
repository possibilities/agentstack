import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
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
});

export type OwnerContext = {
  source: StatusSource;
  resources: ResourceMonitor;
};

export const ownerStatus = operation({
  name: "owner_status",
  description: "Read the owner process, its local URLs, and each required child's status: pid, running, exit code, signal, and spawn error.",
  input: z.strictObject({}),
  output: z.object({
    pid: z.number().int().describe("Owner process id."),
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
  operations: [ownerStatus, ownerResources, ownerResourceHistory],
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
    return { source: statusSource, resources };
  },
  async closeContext(ctx) {
    await ctx.resources.close();
    ctx.source.detach();
  },
};
