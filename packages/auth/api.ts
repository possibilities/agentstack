import { chmod, mkdir, rm } from "node:fs/promises";
import { z } from "zod";
import { operation, socketCall, socketPath, type PackageApi } from "@agentstack/api";
import { stateDir } from "./src/paths.js";
import { AuthStore, type Account } from "./src/store.js";
import { LoginManager, type LoginState } from "./src/login.js";
import { WorkerLoginManager, type WorkerLoginState } from "./src/worker-login.js";
import { accountRoot, credentialEvidence, loginCommand, prepareAccountProfile, type WorkerAccount, type WorkerProvider } from "./src/worker-accounts.js";
import { removeClaudeCredentials, type ClaudeCredentialOptions } from "./src/claude-credentials.js";

const accountId = z.uuid().describe("Stable account ID from the corresponding Bot or Worker account list.");
const providerSchema = z.enum(["codex", "grok", "devin", "claude"]);
const linkedAccounts = z.array(z.strictObject({ scope: z.enum(["bot", "worker"]), id: accountId }))
  .describe("Independent accounts with a matching native sign-in identity. IDs only; no provider identity or credentials.");
const accountSchema = z.strictObject({ id: accountId, enabled: z.boolean(), removing: z.boolean(), linkedAccounts });
const workerAccountSchema = accountSchema.extend({ provider: providerSchema, ready: z.boolean() });
const loginStateSchema = z.object({
  id: z.string(), status: z.enum(["pending", "complete", "failed"]),
  authUrl: z.string().nullable(), userCode: z.string().nullable(),
  account: accountId.nullable(), error: z.string().nullable(), targetAccount: accountId.nullable(),
});
const workerLoginStateSchema = z.object({
  id: z.string(), account: accountId, provider: providerSchema,
  status: z.enum(["pending", "complete", "failed"]),
  authUrl: z.string().nullable(), userCode: z.string().nullable(), needsCode: z.boolean(), error: z.string().nullable(),
});

export type AuthContext = {
  store: AuthStore;
  login: LoginManager;
  workerLogin: WorkerLoginManager;
  botsSocket: string;
  workersSocket?: string;
  claude?: ClaudeCredentialOptions;
  onAccountsChanged: (() => void) | undefined;
  onWorkerAccountsChanged: (() => void) | undefined;
};

export type BotAccountView = Account & { linkedAccounts: Array<{ scope: "worker"; id: string }> };
export type WorkerAccountView = WorkerAccount & { linkedAccounts: Array<{ scope: "bot"; id: string }> };

/** Correlate native identities without exposing or persisting them or coupling account lifecycles. */
async function inventories(store: AuthStore): Promise<{
  bots: BotAccountView[];
  workers: WorkerAccountView[];
}> {
  const bots = store.listAccounts();
  const workers = store.workerAccounts();
  const identities = await Promise.all(workers.map(async (account) => {
    if (account.provider !== "codex" || !account.ready || account.removing) return null;
    try { return (await credentialEvidence(store.stateDir, account)).identity; }
    catch { return null; }
  }));
  const botIdentity = new Map(bots.map((account) => [account.id, store.botAccountIdentity(account.id)]));
  return {
    bots: bots.map((account) => ({ ...account, linkedAccounts: workers.flatMap((worker, index) =>
      botIdentity.get(account.id) && identities[index] === botIdentity.get(account.id) ? [{ scope: "worker" as const, id: worker.id }] : []) })),
    workers: workers.map((account, index) => ({ ...account, linkedAccounts: identities[index] ? bots.flatMap((bot) =>
      botIdentity.get(bot.id) === identities[index] ? [{ scope: "bot" as const, id: bot.id }] : []) : [] })),
  };
}

export const accountList = operation({
  name: "account_list", description: "List Codex Bot accounts and optional native-identity links without exposing credentials. Worker sign-ins are independent.",
  input: z.object({}), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "List accounts", readOnlyHint: true },
  async call(ctx: AuthContext) { return { accounts: (await inventories(ctx.store)).bots }; },
});

export const accountSetEnabled = operation({
  name: "account_set_enabled", description: "Enable or disable a Codex Bot account. Disabling fences new Bot launches but does not stop running Bots or affect Worker accounts.",
  input: z.strictObject({ id: accountId, enabled: z.boolean() }), output: accountSchema,
  annotations: { title: "Set account availability", idempotentHint: true },
  async call(ctx: AuthContext, { id, enabled }, invocation) {
    operatorOnly(invocation);
    const updated = ctx.store.setEnabled(id, enabled);
    ctx.onAccountsChanged?.();
    return (await inventories(ctx.store)).bots.find((account) => account.id === updated.id)!;
  },
});

export const accountRemove = operation({
  name: "account_remove", description: "Remove a Codex Bot account and its bound Bots and credentials. Worker accounts are independent, even when an older Worker has the same ID. Retry after interruption.",
  input: z.strictObject({ id: accountId }), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "Remove account", destructiveHint: true },
  async call(ctx: AuthContext, { id }, invocation) {
    operatorOnly(invocation);
    if (!ctx.store.listAccounts().some((item) => item.id === id)) throw new Error("unknown Codex Bot account");
    ctx.store.beginRemoval(id);
    ctx.onAccountsChanged?.();
    for (const serverId of ctx.store.boundServerIds(id))
      await socketCall(ctx.botsSocket, "tools/call", { name: "bot_remove", arguments: { id: serverId } }, { timeoutMs: 30_000 });
    ctx.store.removeAccount(id);
    ctx.onAccountsChanged?.();
    return { accounts: (await inventories(ctx.store)).bots };
  },
});

function operatorOnly(invocation?: { botId: string | null; workerId?: string | null }): void {
  if (invocation?.botId || invocation?.workerId) throw new Error("account management is operator-only");
}

export const workerAccountPrepare = operation({
  name: "worker_account_prepare", description: "Terminal fallback: create a private native Codex, Grok, Devin or Claude Worker sign-in independent of Bot accounts. Run the returned command, then call worker_account_confirm. Pass an existing Worker ID to reauthenticate it. Prefer worker_account_login_start, which runs the sign-in itself.",
  input: z.strictObject({ provider: providerSchema, id: accountId.optional() }),
  output: z.strictObject({ account: workerAccountSchema, command: z.string() }),
  annotations: { title: "Prepare worker sign-in" },
  async call(ctx: AuthContext, { provider, id }, invocation) {
    operatorOnly(invocation);
    const existing = id ? ctx.store.workerAccounts().find((account) => account.id === id) : undefined;
    if (id && (!existing || existing.provider !== provider || existing.removing)) throw new Error("worker account is unavailable");
    if (id) await ctx.workerLogin.cancelAccount(id);
    if (existing?.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    const account = ctx.store.prepareWorker(provider as WorkerProvider, id);
    await prepareAccountProfile(ctx.store.stateDir, account, ctx.claude);
    ctx.onWorkerAccountsChanged?.();
    return { account: (await inventories(ctx.store)).workers.find((item) => item.id === account.id)!, command: loginCommand(ctx.store.stateDir, account) };
  },
});

export const workerAccountConfirm = operation({
  name: "worker_account_confirm", description: "Terminal fallback: verify an isolated native Worker sign-in and mark it ready without changing availability or Bot accounts. The API-driven flow confirms by itself; see worker_account_login_start.",
  input: z.strictObject({ id: accountId }), output: workerAccountSchema,
  annotations: { title: "Confirm worker sign-in" },
  async call(ctx: AuthContext, { id }, invocation) {
    operatorOnly(invocation);
    const account = ctx.store.workerAccounts().find((item) => item.id === id);
    if (!account) throw new Error("unknown worker account");
    const evidence = await credentialEvidence(ctx.store.stateDir, account, ctx.claude);
    if (account.ready && ctx.workersSocket) await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    const confirmed = ctx.store.confirmWorker(id, evidence.digest, evidence.identity);
    ctx.onWorkerAccountsChanged?.();
    return (await inventories(ctx.store)).workers.find((account) => account.id === confirmed.id)!;
  },
});

export const workerAccountList = operation({
  name: "worker_account_list", description: "List independent Codex, Grok, Devin and Claude Worker accounts and optional native-identity links without credentials. Ready means the native Worker sign-in is confirmed.",
  input: z.strictObject({}), output: z.strictObject({ accounts: z.array(workerAccountSchema) }),
  annotations: { title: "List worker accounts", readOnlyHint: true },
  async call(ctx: AuthContext) { return { accounts: (await inventories(ctx.store)).workers }; },
});

export const workerAccountSetEnabled = operation({
  name: "worker_account_set_enabled", description: "Enable or disable a Codex, Grok, Devin or Claude Worker account. Disabling fences new Worker turns and drains its runtime; Bot accounts are unaffected.",
  input: z.strictObject({ id: accountId, enabled: z.boolean() }), output: workerAccountSchema,
  annotations: { title: "Set worker account availability", idempotentHint: true },
  async call(ctx: AuthContext, { id, enabled }, invocation) {
    operatorOnly(invocation);
    const updated = ctx.store.enableWorker(id, enabled);
    ctx.onWorkerAccountsChanged?.();
    if (!enabled && updated.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    return (await inventories(ctx.store)).workers.find((account) => account.id === updated.id)!;
  },
});

export const workerAccountRemove = operation({
  name: "worker_account_remove", description: "Fence and remove one Codex, Grok, Devin or Claude Worker account, its runtime and private credentials, including Claude's exact profile-bound keychain item. Bot accounts remain untouched, even for an older Worker with the same ID. Retry after interruption.",
  input: z.strictObject({ id: accountId }), output: z.strictObject({ id: accountId }),
  annotations: { title: "Remove worker account", destructiveHint: true },
  async call(ctx: AuthContext, { id }, invocation) {
    operatorOnly(invocation);
    const account = ctx.store.workerAccounts().find((item) => item.id === id);
    if (!account) throw new Error("unknown worker account");
    ctx.store.beginWorkerRemoval(id);
    ctx.onWorkerAccountsChanged?.();
    await ctx.workerLogin.cancelAccount(id);
    if (account.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    if (account.provider === "claude") await removeClaudeCredentials(ctx.store.stateDir, id, ctx.claude);
    await rm(accountRoot(ctx.store.stateDir, id), { recursive: true, force: true });
    ctx.store.finishWorkerRemoval(id);
    ctx.onWorkerAccountsChanged?.();
    return { id };
  },
});

export const workerAccountLoginStart = operation({
  name: "worker_account_login_start", description: "Create or re-sign-in a Codex, Grok, Devin or Claude Worker account. The API runs the native sign-in itself and returns a link to copy into your browser, with a one-time code for Codex and Grok; Devin and Claude support pasted codes through worker_account_login_submit when needsCode is true. Finishing marks the Worker ready. Poll worker_account_login_status or subscribe to worker_login_changed.",
  input: z.strictObject({ provider: providerSchema, id: accountId.optional() }), output: workerLoginStateSchema,
  annotations: { title: "Start worker sign-in" },
  async call(ctx: AuthContext, { provider, id }, invocation) {
    operatorOnly(invocation);
    const existing = id ? ctx.store.workerAccounts().find((account) => account.id === id) : undefined;
    if (id && (!existing || existing.provider !== provider || existing.removing)) throw new Error("worker account is unavailable");
    if (id) await ctx.workerLogin.cancelAccount(id);
    if (existing?.ready && ctx.workersSocket)
      await socketCall(ctx.workersSocket, "tools/call", { name: "worker_account_drain", arguments: { id } }, { timeoutMs: 30_000 });
    const account = ctx.store.prepareWorker(provider as WorkerProvider, id);
    await prepareAccountProfile(ctx.store.stateDir, account, ctx.claude);
    ctx.onWorkerAccountsChanged?.();
    return ctx.workerLogin.start(account);
  },
});

export const workerAccountLoginStatus = operation({
  name: "worker_account_login_status", description: "Read an in-progress or completed Worker sign-in, without credentials or prompt output.",
  input: z.object({ id: z.string() }), output: workerLoginStateSchema,
  annotations: { title: "Check worker sign-in", readOnlyHint: true },
  async call(ctx: AuthContext, { id }) { return ctx.workerLogin.status(id); },
});

export const workerAccountLoginCurrent = operation({
  name: "worker_account_login_current", description: "List the Worker sign-ins currently in progress, without credentials or prompt output.",
  input: z.object({}), output: z.object({ logins: z.array(workerLoginStateSchema) }),
  annotations: { title: "Current worker sign-ins", readOnlyHint: true },
  async call(ctx: AuthContext) { return { logins: ctx.workerLogin.current() }; },
});

export const workerAccountLoginSubmit = operation({
  name: "worker_account_login_submit", description: "Paste the code a Devin or Claude Worker sign-in asks for after visiting its copied link. Only valid while the attempt reports needsCode.",
  input: z.strictObject({ id: z.string(), code: z.string() }), output: workerLoginStateSchema,
  annotations: { title: "Submit worker sign-in code" },
  async call(ctx: AuthContext, { id, code }, invocation) {
    operatorOnly(invocation);
    return ctx.workerLogin.submit(id, code);
  },
});

export const workerAccountLoginCancel = operation({
  name: "worker_account_login_cancel", description: "Cancel an in-progress Worker sign-in.",
  input: z.object({ id: z.string() }), output: workerLoginStateSchema,
  annotations: { title: "Cancel worker sign-in" },
  async call(ctx: AuthContext, { id }, invocation) {
    operatorOnly(invocation);
    await ctx.workerLogin.cancel(id);
    return ctx.workerLogin.status(id);
  },
});

export const accountLoginStart = operation({
  name: "account_login_start", description: "Create a Codex Bot account by device sign-in in an isolated temporary home. Supersedes any attempt already in progress. Poll account_login_status for its verification URL, one-time code, and result.",
  input: z.strictObject({}), output: loginStateSchema,
  annotations: { title: "Sign in to Codex" },
  async call(ctx: AuthContext) { return ctx.login.start(); },
});

export const accountLoginReplace = operation({
  name: "account_login_replace", description: "Sign in again to an existing Codex Bot account, replacing its credentials without changing its identity or a Worker account.",
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
  accounts_changed: "Published when Bot account state or cross-inventory identity links change. Refresh account_list.",
  login_changed: "Published when a Codex device sign-in starts, shows its prompt, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
  worker_accounts_changed: "Published when Worker account state or cross-inventory identity links change. Refresh worker_account_list.",
  worker_login_changed: "Published when a Worker sign-in starts, shows its link or code, needs a pasted code, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
} as const;

export type AuthTopic = keyof typeof topics;

export const api: PackageApi<AuthContext, AuthTopic> = {
  operations: [accountList, accountSetEnabled, accountRemove, accountLoginStart, accountLoginReplace, accountLoginStatus, accountLoginCurrent, accountLoginCancel,
    workerAccountList, workerAccountPrepare, workerAccountConfirm, workerAccountSetEnabled, workerAccountRemove,
    workerAccountLoginStart, workerAccountLoginStatus, workerAccountLoginCurrent, workerAccountLoginSubmit, workerAccountLoginCancel],
  events: {
    topics,
    start(ctx: AuthContext, publish: (topic: AuthTopic) => void) {
      ctx.onAccountsChanged = () => { publish("accounts_changed"); publish("worker_accounts_changed"); };
      ctx.onWorkerAccountsChanged = () => { publish("worker_accounts_changed"); publish("accounts_changed"); };
      ctx.login.onAccountsChange = () => { publish("accounts_changed"); publish("worker_accounts_changed"); };
      ctx.login.onChange = () => publish("login_changed");
      ctx.workerLogin.onAccountsChange = () => { publish("worker_accounts_changed"); publish("accounts_changed"); };
      ctx.workerLogin.onChange = () => publish("worker_login_changed");
      return () => {
        ctx.onAccountsChanged = undefined;
        ctx.onWorkerAccountsChanged = undefined;
        ctx.login.onAccountsChange = undefined;
        ctx.login.onChange = undefined;
        ctx.workerLogin.onAccountsChange = undefined;
        ctx.workerLogin.onChange = undefined;
      };
    },
  },
  async createContext(env) {
    const dir = stateDir(env);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const store = new AuthStore(dir);
    return { store, login: new LoginManager(store), workerLogin: new WorkerLoginManager(store, { env }), botsSocket: socketPath("bots", env), workersSocket: socketPath("workers", env), onAccountsChanged: undefined, onWorkerAccountsChanged: undefined };
  },
  async closeContext(ctx) {
    await ctx.login.close();
    await ctx.workerLogin.close();
    ctx.store.close();
  },
};

export type { Account, LoginState };
export type { WorkerAccount, WorkerLoginState };
