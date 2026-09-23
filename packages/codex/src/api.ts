import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { stateDir } from "./paths.js";
import { Supervisor, type ServerView } from "./supervisor.js";
import { watchThreadEvents } from "./threads.js";
import { InputObserver } from "./input-observer.js";

const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  .describe("Server id.");

const serverViewSchema = z.object({
  id: idSchema,
  pid: z.number().int().nullable().describe("Process id while running, otherwise null."),
  cwd: z.string().describe("Working directory."),
  url: z.string().nullable().describe("WebSocket endpoint while running, otherwise null."),
  state: z.enum(["running", "stopped"]).describe("running or stopped."),
});

const serverListSchema = z.object({
  servers: z.array(serverViewSchema).describe("Codex app-servers this process has started."),
});

export type CodexContext = {
  supervisor: Supervisor;
  observer: InputObserver;
};

const observationTargetSchema = z.strictObject({
  serverId: idSchema,
  threadId: z.string().min(1),
});

const observationSchema = observationTargetSchema.extend({
  inputId: z.string(),
  origin: z.enum(["client", "realtime"]),
  originalText: z.string(),
  selectedText: z.string().nullable(),
  observedAt: z.string(),
  disposition: z.enum(["pending", "passed", "replaced", "intercepted", "rejected", "unresolved"]),
  operationId: z.string().nullable(),
  effect: z.object({ status: z.enum(["succeeded", "failed", "unknown"]), summary: z.string() }).nullable(),
});
const observationIssueSchema = observationTargetSchema.extend({ message: z.string(), at: z.string() });

export const inputObserveStart = operation({
  name: "input_observe_start",
  description: "Register a pass-through human-input observer for one loaded Codex thread. Its candidates and resolutions appear in the bounded UI log.",
  input: observationTargetSchema,
  output: observationTargetSchema.extend({ status: z.enum(["observing", "failed"]), message: z.string().nullable() }),
  annotations: { title: "Observe input" },
  async call(ctx: CodexContext, input) {
    const server = ctx.supervisor.list().find((item) => item.id === input.serverId);
    if (!server) return { ...input, status: "failed" as const, message: `unknown Codex server: ${input.serverId}` };
    try {
      await ctx.observer.start(server, input.threadId);
      return { ...input, status: "observing" as const, message: null };
    } catch (error) {
      return { ...input, status: "failed" as const, message: String(error instanceof Error ? error.message : error).slice(0, 256) };
    }
  },
});

export const inputObserveStop = operation({
  name: "input_observe_stop",
  description: "Detach the input observer from a Codex thread and restore its unregistered input path.",
  input: observationTargetSchema,
  output: observationTargetSchema,
  annotations: { title: "Stop observing", idempotentHint: true },
  async call(ctx: CodexContext, input) {
    await ctx.observer.stop(input.serverId, input.threadId);
    return input;
  },
});

export const inputObserveList = operation({
  name: "input_observe_list",
  description: "Read current observation targets and the latest 200 input middleware candidates and outcomes.",
  input: z.strictObject({}),
  output: z.strictObject({ targets: z.array(observationTargetSchema), entries: z.array(observationSchema), issues: z.array(observationIssueSchema) }),
  annotations: { title: "Input observations", readOnlyHint: true },
  async call(ctx: CodexContext) { return ctx.observer.snapshot(); },
});

export const serverStart = operation({
  name: "server_start",
  description:
    "Start the required codexnk runtime on a private Unix socket, or return the live one with this id. Extra args are passed through. Do not pass --listen.",
  input: z.strictObject({
    cwd: z.string().describe("Working directory for the app-server."),
    id: idSchema.optional().describe("Existing server id to reuse. A new id is generated when omitted."),
    args: z.array(z.string()).optional().describe("Extra Codex arguments. Do not include --listen."),
  }),
  output: serverViewSchema,
  annotations: { title: "Start server" },
  async call(ctx: CodexContext, input) {
    return ctx.supervisor.start(input);
  },
});

export const serverStop = operation({
  name: "server_stop",
  description: "Stop a Codex app-server process. Stopping an already stopped server succeeds.",
  input: z.object({
    id: idSchema.describe("Server id to stop."),
  }),
  output: serverViewSchema,
  annotations: { title: "Stop server", destructiveHint: true, idempotentHint: true },
  async call(ctx: CodexContext, input) {
    return ctx.supervisor.stop(input.id);
  },
});

export const serverList = operation({
  name: "server_list",
  description: "List Codex app-server processes started here, including ones that have stopped.",
  input: z.object({}),
  output: serverListSchema,
  annotations: { title: "List servers", readOnlyHint: true },
  async call(ctx: CodexContext) {
    return { servers: ctx.supervisor.list() };
  },
});

export const api: PackageApi<CodexContext> = {
  operations: [serverStart, serverStop, serverList, inputObserveStart, inputObserveStop, inputObserveList],
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const supervisor = new Supervisor({ stateDir: dir });
    await supervisor.load();
    await supervisor.reap();
    return { supervisor, observer: new InputObserver() };
  },
  subscribe(ctx, publish) {
    const watches = new Map<string, () => void>();
    const sync = () => {
      const active = new Set(ctx.supervisor.list().flatMap((server) => server.state === "running" && server.url ? [server.url] : []));
      for (const [url, stop] of watches) {
        if (!active.has(url)) {
          stop();
          watches.delete(url);
        }
      }
      for (const url of active) {
        if (!watches.has(url)) watches.set(url, watchThreadEvents(url, () => publish("threads_changed")));
      }
    };
    ctx.supervisor.onChange = () => {
      sync();
      ctx.observer.reconcile(ctx.supervisor.list());
      publish("servers_changed");
    };
    ctx.observer.setPublisher(() => publish("inputs_changed"));
    sync();
    return () => {
      ctx.supervisor.onChange = undefined;
      ctx.observer.setPublisher(undefined);
      for (const stop of watches.values()) stop();
      watches.clear();
    };
  },
  async closeContext(ctx) {
    ctx.observer.close();
    await ctx.supervisor.stopAll();
  },
};

export type { ServerView };
