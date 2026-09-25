import { chmod, mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import { operation, socketCall, socketPath, type PackageApi } from "@agentstack/api";
import { stateDir } from "./src/paths.js";
import { AuthStore, type Account } from "./src/store.js";
import { LoginManager, type LoginState } from "./src/login.js";
import { accountRoot, credentialEvidence, loginCommand, prepareAccountProfile, type WorkerAccount, type WorkerProvider } from "./src/worker-accounts.js";

const accountId = z.uuid().describe("Stable account ID. Obtain it from account_list.");
const providerSchema = z.enum(["codex", "grok", "devin"]);
const accountSchema = z.strictObject({ id: accountId, provider: providerSchema, enabled: z.boolean(), ready: z.boolean(), removing: z.boolean() });
const loginStateSchema = z.object({
  id: z.string(), status: z.enum(["pending", "complete", "failed"]),
  authUrl: z.string().nullable(), userCode: z.string().nullable(),
  account: accountId.nullable(), error: z.string().nullable(), targetAccount: accountId.nullable(),
});

export type AuthContext = {
  store: AuthStore;
  login: LoginManager;
  botsSocket: string;
  workersSocket?: string;
  onAccountsChanged: (() => void) | undefined;
};

export const accountList = operation({
  name: "account_list", description: "List Codex, Grok and Devin accounts without credentials. Ready means an ACP sign-in is confirmed; Codex Bot sign-in is separate.",
  input: z.object({}), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "List accounts", readOnlyHint: true },
  async call(ctx: AuthContext) { return { accounts: ctx.store.listAccounts() }; },
});

export const accountSetEnabled = operation({
  name: "account_set_enabled", description: "Enable or disable a Codex, Grok or Devin account. Disabling fences new Bot launches and Worker turns and drains its ACP process; existing running Bots keep their identity.",
  input: z.strictObject({ id: accountId, enabled: z.boolean() }), output: accountSchema,
  annotations: { title: "Set account availability", idempotentHint: true },
  async call(ctx: AuthContext, { id, enabled }, invocation) {
    operatorOnly(invocation);
    const updated = ctx.store.setEnabled(id, enabled);
    ctx.onAccountsChanged?.();
    if (!enabled && updated.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    return updated;
  },
});

export const accountRemove = operation({
  name: "account_remove", description: "Remove a Codex, Grok or Devin account. Codex removal stops and deletes bound bots; all providers drain ACP and delete their private credentials. Retry the same ID after interruption.",
  input: z.strictObject({ id: accountId }), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "Remove account", destructiveHint: true },
  async call(ctx: AuthContext, { id }, invocation) {
    operatorOnly(invocation);
    const account = ctx.store.listAccounts().find((item) => item.id === id);
    if (!account) throw new Error("unknown account");
    if (account.provider === "codex") ctx.store.beginRemoval(id);
    else ctx.store.beginWorkerRemoval(id);
    ctx.onAccountsChanged?.();
    if (account.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    if (account.provider === "codex") {
      for (const serverId of ctx.store.boundServerIds(id))
        await socketCall(ctx.botsSocket, "tools/call", { name: "bot_remove", arguments: { id: serverId } }, { timeoutMs: 30_000 });
    }
    if (ctx.store.hasWorkerBinding(id)) {
      if (account.provider === "codex") ctx.store.beginWorkerRemoval(id);
      await rm(accountRoot(ctx.store.stateDir, id), { recursive: true, force: true });
      ctx.store.finishWorkerRemoval(id);
    }
    if (account.provider === "codex") ctx.store.removeAccount(id);
    ctx.onAccountsChanged?.();
    return { accounts: ctx.store.listAccounts() };
  },
});

function operatorOnly(invocation?: { botId: string | null; workerId?: string | null }): void {
  if (invocation?.botId || invocation?.workerId) throw new Error("account management is operator-only");
}

export const workerAccountPrepare = operation({
  name: "worker_account_prepare", description: "Prepare a private native sign-in for Grok or Devin, or bind an existing Codex ID to OpenCode. Run the returned command in a terminal, then call worker_account_confirm. Pass id to reauthenticate an existing binding.",
  input: z.strictObject({ provider: providerSchema, id: accountId.optional() }),
  output: z.strictObject({ account: accountSchema, command: z.string() }),
  annotations: { title: "Prepare worker sign-in" },
  async call(ctx: AuthContext, { provider, id }, invocation) {
    operatorOnly(invocation);
    const existing = id ? ctx.store.workerAccounts().find((account) => account.id === id) : undefined;
    if (id && (!existing || existing.provider !== provider || existing.removing)) throw new Error("worker account is unavailable");
    if (existing?.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    const account = ctx.store.prepareWorker(provider as WorkerProvider, id);
    await prepareAccountProfile(ctx.store.stateDir, account);
    ctx.onAccountsChanged?.();
    return { account, command: loginCommand(ctx.store.stateDir, account) };
  },
});

export const workerAccountConfirm = operation({
  name: "worker_account_confirm", description: "Verify the isolated native sign-in and mark its ACP binding ready without changing account availability. A Codex OpenCode login must identify the same ChatGPT account as the existing Codex sign-in.",
  input: z.strictObject({ id: accountId }), output: accountSchema,
  annotations: { title: "Confirm worker sign-in" },
  async call(ctx: AuthContext, { id }, invocation) {
    operatorOnly(invocation);
    const account = ctx.store.workerAccounts().find((item) => item.id === id);
    if (!account) throw new Error("unknown worker account");
    const evidence = await credentialEvidence(ctx.store.stateDir, account);
    if (account.provider === "codex") {
      const auth = JSON.parse(ctx.store.accountCredentials(id).auth) as { tokens?: { account_id?: string } };
      if (!evidence.identity || evidence.identity !== auth.tokens?.account_id) throw new Error("OpenCode login cannot be verified against this Codex account");
    }
    if (account.ready && ctx.workersSocket) await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    const confirmed = ctx.store.confirmWorker(id, evidence.digest);
    ctx.onAccountsChanged?.();
    return confirmed;
  },
});

export const accountLoginStart = operation({
  name: "account_login_start", description: "Create a Codex account by device sign-in in an isolated temporary home. Supersedes any attempt already in progress. Poll account_login_status for its verification URL, one-time code, and result.",
  input: z.strictObject({}), output: loginStateSchema,
  annotations: { title: "Sign in to Codex" },
  async call(ctx: AuthContext) { return ctx.login.start(); },
});

export const accountLoginReplace = operation({
  name: "account_login_replace", description: "Sign in again to an existing Codex account, replacing its credentials without changing its identity.",
  input: z.strictObject({ id: accountId }), output: loginStateSchema,
  annotations: { title: "Sign in again" },
  async call(ctx: AuthContext, { id }) { return ctx.login.start(id); },
});

export const accountLoginStatus = operation({
  name: "account_login_status", description: "Read an in-progress or completed Codex sign-in, without credentials.",
  input: z.object({ id: z.string() }), output: loginStateSchema,
  annotations: { title: "Check Codex sign-in", readOnlyHint: true },
  async call(ctx: AuthContext, { id }) { return ctx.login.status(id); },
});

export const accountLoginCurrent = operation({
  name: "account_login_current", description: "Read the Codex sign-in currently in progress, if any, without credentials.",
  input: z.object({}), output: z.object({ login: loginStateSchema.nullable() }),
  annotations: { title: "Current Codex sign-in", readOnlyHint: true },
  async call(ctx: AuthContext) { return { login: ctx.login.current() }; },
});

export const accountLoginCancel = operation({
  name: "account_login_cancel", description: "Cancel an in-progress Codex sign-in.",
  input: z.object({ id: z.string() }), output: loginStateSchema,
  annotations: { title: "Cancel Codex sign-in" },
  async call(ctx: AuthContext, { id }) { ctx.login.cancel(id); return ctx.login.status(id); },
});

export const topics = {
  accounts_changed: "Published when an account signs in, is prepared, confirmed, enabled, disabled or removed. Refresh account_list.",
  login_changed: "Published when a Codex device sign-in starts, shows its prompt, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
} as const;

export type AuthTopic = keyof typeof topics;

export const api: PackageApi<AuthContext, AuthTopic> = {
  operations: [accountList, accountSetEnabled, accountRemove, accountLoginStart, accountLoginReplace, accountLoginStatus, accountLoginCurrent, accountLoginCancel,
    workerAccountPrepare, workerAccountConfirm],
  events: {
    topics,
    start(ctx: AuthContext, publish: (topic: AuthTopic) => void) {
      ctx.onAccountsChanged = () => publish("accounts_changed");
      ctx.login.onAccountsChange = () => publish("accounts_changed");
      ctx.login.onChange = () => publish("login_changed");
      return () => {
        ctx.onAccountsChanged = undefined;
        ctx.login.onAccountsChange = undefined;
        ctx.login.onChange = undefined;
      };
    },
  },
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const store = new AuthStore(dir);
    return { store, login: new LoginManager(store), botsSocket: socketPath("bots", env), workersSocket: socketPath("workers", env), onAccountsChanged: undefined };
  },
  async closeContext(ctx) {
    await ctx.login.close();
    ctx.store.close();
  },
};

export type { Account, LoginState };
export type { WorkerAccount };
