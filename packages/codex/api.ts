import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, workspaceRoot, type PackageApi } from "@agentstack/api";
import { stateDir } from "./src/paths.js";
import { Supervisor, type ServerView } from "./src/supervisor.js";
import { watchThreadEvents } from "./src/threads.js";
import { StateStore } from "./src/store.js";
import { ownerMcpUrls } from "./src/owner-mcp.js";

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
  account: z.uuid().nullable().describe("Stable Codex account ID bound to this Server, or null while unbound."),
  runningAccount: z.uuid().nullable().describe("Account used by the running process, or null when stopped or launched unbound. If different from account, stop and start to apply the assignment."),
  mainThreadId: z.string().nullable().describe("The first durable root thread created through this Server, or null until a UI sends its first turn."),
  recoveryIssue: z.string().nullable().describe("Why a recorded process is fenced for inspection; null when recovery has no known ownership issue. A reported running state is unverified while this is set."),
});

const serverListSchema = z.object({
  servers: z.array(serverViewSchema).describe("Codex app-servers this process has started."),
});

export type CodexContext = {
  supervisor: Supervisor;
  store: StateStore;
};

export const serverStart = operation({
  name: "server_start",
  description:
    "Start codexnk without creating a thread, or return the live Server. The first durable root thread from a connected UI becomes its main thread. A new Server binds the active Codex account; existing Servers change account through server_assign, then stop/start. Omit args to reuse them; [] clears them while stopped. A running Server rejects changed args. Do not pass --listen.",
  input: z.strictObject({
    cwd: z.string().describe("Working directory for the app-server."),
    id: idSchema.optional().describe("Existing server id to reuse. A new id is generated when omitted."),
    args: z.array(z.string()).optional().describe("Extra Codex arguments saved for future launches. Omit to reuse saved args; [] clears them when stopped. Do not include --listen."),
  }),
  output: serverViewSchema,
  annotations: { title: "Start server" },
  async call(ctx: CodexContext, input) {
    return ctx.supervisor.start(input);
  },
});

export const serverAssign = operation({
  name: "server_assign",
  description: "Assign a Codex account to an existing Server. Does not restart. A running Server keeps its launched identity until it is stopped and started again.",
  input: z.strictObject({
    id: idSchema.describe("Existing Server id."),
    account: z.uuid().describe("Codex account ID from account_list."),
  }),
  output: serverViewSchema,
  annotations: { title: "Assign server account", idempotentHint: true },
  async call(ctx: CodexContext, { id, account }) {
    return ctx.supervisor.assign(id, account);
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

export const serverRemove = operation({
  name: "server_remove",
  description: "Stop and delete a Server record and its private runtime, log, and per-Server history. Legacy shared history is retained.",
  input: z.strictObject({ id: idSchema }), output: z.strictObject({ id: idSchema }),
  annotations: { title: "Remove server", destructiveHint: true, idempotentHint: true },
  async call(ctx: CodexContext, { id }) { return ctx.supervisor.remove(id); },
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

export const topics = {
  servers_changed: "Published when a Codex app-server record starts, stops, exits, is reaped, or becomes fenced for recovery inspection.",
  threads_changed: "Published when a loaded Codex thread starts, changes status, or closes.",
} as const;

export type CodexTopic = keyof typeof topics;

export const api: PackageApi<CodexContext, CodexTopic> = {
  operations: [serverStart, serverStop, serverAssign, serverRemove, serverList],
  events: {
    topics,
    scope: {
      description: "Optional Codex Server id. Scoped subscriptions receive changes only for that Server.",
      example: "bot-1",
      valid: (_ctx, scope) => idSchema.safeParse(scope).success,
    },
    start(ctx: CodexContext, publish: (topic: CodexTopic, scope?: string) => void) {
      const watches = new Map<string, { url: string; stop: () => void }>();
      const sync = () => {
        const active = new Map(ctx.supervisor.list().flatMap((server) => server.state === "running" && !server.recoveryIssue && server.url ? [[server.id, server.url] as const] : []));
        for (const [id, watch] of watches) {
          if (active.get(id) !== watch.url) {
            watch.stop();
            watches.delete(id);
          }
        }
        for (const [id, url] of active) {
          if (!watches.has(id)) watches.set(id, { url, stop: watchThreadEvents(url, () => {
            publish("threads_changed", id);
            void ctx.supervisor.adoptMainThread(id, url).catch((error) => console.error(`failed to adopt main thread for ${id}: ${error}`));
          }) });
        }
      };
      ctx.supervisor.onChange = (id) => {
        sync();
        publish("servers_changed", id);
      };
      sync();
      return () => {
        ctx.supervisor.onChange = undefined;
        for (const watch of watches.values()) watch.stop();
        watches.clear();
      };
    },
  },
  async createContext(env) {
    const dir = stateDir(env);
    const ownerMcpPort = env.AGENTSTACK_OWNER_MCP_PORT;
    if (ownerMcpPort !== undefined && (!/^[1-9][0-9]*$/.test(ownerMcpPort) || Number(ownerMcpPort) > 65535)) {
      throw new Error("AGENTSTACK_OWNER_MCP_PORT must be a bound TCP port");
    }
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const store = new StateStore(dir);
    const supervisor = new Supervisor({
      stateDir: dir,
      store,
      mcpServers: ownerMcpPort === undefined ? undefined : () => ownerMcpUrls(workspaceRoot(import.meta.dirname), Number(ownerMcpPort)),
    });
    await supervisor.load();
    await supervisor.reap();
    await supervisor.resumeAll();
    return { supervisor, store };
  },
  async closeContext(ctx) {
    await ctx.supervisor.stopAll();
    await ctx.supervisor.runtime.close();
    ctx.store.close();
  },
};

export type { ServerView };
