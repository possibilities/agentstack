import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { stateDir } from "./paths.js";
import { Supervisor, type ServerView } from "./supervisor.js";
import { watchThreadEvents } from "./threads.js";
import { StateStore } from "./store.js";
import { LoginManager } from "./login.js";

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
  account: z.string().nullable().describe("Codex account bound at launch; null for older records."),
});

const serverListSchema = z.object({
  servers: z.array(serverViewSchema).describe("Codex app-servers this process has started."),
});

export type CodexContext = {
  supervisor: Supervisor;
  store: StateStore;
  login: LoginManager;
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

const accountSchema = z.object({ name: z.string(), active: z.boolean() });
const accountName = z.string().regex(/^codex-[1-9][0-9]*$/);
const loginStateSchema = z.object({
  id: z.string(), status: z.enum(["pending", "complete", "failed"]),
  authUrl: z.string().nullable(), userCode: z.string().nullable(),
  account: z.string().nullable(), error: z.string().nullable(), targetAccount: z.string().nullable(),
});

export const accountList = operation({
  name: "account_list", description: "List Codex accounts and the active choice without exposing credentials.",
  input: z.object({}), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "List accounts", readOnlyHint: true },
  async call(ctx: CodexContext) { return { accounts: ctx.store.listAccounts() }; },
});

export const accountActivate = operation({
  name: "account_activate", description: "Use this Codex account for newly created app servers.",
  input: z.object({ name: accountName }), output: accountSchema,
  annotations: { title: "Select active account" },
  async call(ctx: CodexContext, { name }) {
    ctx.store.activate(name);
    ctx.login.onChange?.();
    return { name, active: true };
  },
});

export const accountRemove = operation({
  name: "account_remove", description: "Delete a saved Codex account. Running servers retain their launch identity until stopped.",
  input: z.object({ name: accountName }), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "Remove account", destructiveHint: true },
  async call(ctx: CodexContext, { name }) {
    ctx.store.removeAccount(name);
    ctx.login.onChange?.();
    return { accounts: ctx.store.listAccounts() };
  },
});

export const accountLoginStart = operation({
  name: "account_login_start", description: "Start a Codex device sign-in in an isolated temporary home, superseding any attempt already in progress. Optionally replace credentials for an existing name. Poll account_login_status for its verification URL, one-time code, and result.",
  input: z.object({ name: accountName.optional() }), output: loginStateSchema,
  annotations: { title: "Sign in to Codex" },
  async call(ctx: CodexContext, { name }) { return ctx.login.start(name ?? null); },
});

export const accountLoginStatus = operation({
  name: "account_login_status", description: "Read an in-progress or completed Codex sign-in, without credentials.",
  input: z.object({ id: z.string() }), output: loginStateSchema,
  annotations: { title: "Check Codex sign-in", readOnlyHint: true },
  async call(ctx: CodexContext, { id }) { return ctx.login.status(id); },
});

export const accountLoginCurrent = operation({
  name: "account_login_current", description: "Read the Codex sign-in currently in progress, if any, without credentials.",
  input: z.object({}), output: z.object({ login: loginStateSchema.nullable() }),
  annotations: { title: "Current Codex sign-in", readOnlyHint: true },
  async call(ctx: CodexContext) { return { login: ctx.login.current() }; },
});

export const accountLoginCancel = operation({
  name: "account_login_cancel", description: "Cancel an in-progress Codex sign-in.",
  input: z.object({ id: z.string() }), output: loginStateSchema,
  annotations: { title: "Cancel Codex sign-in" },
  async call(ctx: CodexContext, { id }) { ctx.login.cancel(id); return ctx.login.status(id); },
});

export const api: PackageApi<CodexContext> = {
  operations: [serverStart, serverStop, serverList, accountList, accountActivate, accountRemove, accountLoginStart, accountLoginStatus, accountLoginCurrent, accountLoginCancel],
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const store = new StateStore(dir);
    const supervisor = new Supervisor({ stateDir: dir, store });
    await supervisor.load();
    await supervisor.reap();
    return { supervisor, store, login: new LoginManager(store) };
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
    ctx.login.onChange = () => publish("accounts_changed");
    sync();
    return () => {
      ctx.supervisor.onChange = undefined;
      ctx.login.onChange = undefined;
      for (const stop of watches.values()) stop();
      watches.clear();
    };
  },
  async closeContext(ctx) {
    await ctx.login.close();
    await ctx.supervisor.stopAll();
    await ctx.supervisor.runtime.close();
    ctx.store.close();
  },
};

export type { ServerView };
