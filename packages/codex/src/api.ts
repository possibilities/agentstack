import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { stateDir } from "./paths.js";
import { Supervisor, type ServerView } from "./supervisor.js";
import { watchThreadEvents } from "./threads.js";

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
};

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
  operations: [serverStart, serverStop, serverList],
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const supervisor = new Supervisor({ stateDir: dir });
    await supervisor.load();
    await supervisor.reap();
    return { supervisor };
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
      publish("servers_changed");
    };
    sync();
    return () => {
      ctx.supervisor.onChange = undefined;
      for (const stop of watches.values()) stop();
      watches.clear();
    };
  },
  async closeContext(ctx) {
    await ctx.supervisor.stopAll();
  },
};

export type { ServerView };
