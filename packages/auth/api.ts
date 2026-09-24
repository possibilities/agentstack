import { chmod, mkdir } from "node:fs/promises";
import { z } from "zod";
import { operation, type PackageApi } from "@agentstack/api";
import { stateDir } from "./src/paths.js";
import { AuthStore, type Account } from "./src/store.js";
import { LoginManager, type LoginState } from "./src/login.js";

const accountSchema = z.object({ name: z.string(), active: z.boolean() });
const accountName = z.string().regex(/^codex-[1-9][0-9]*$/);
const loginStateSchema = z.object({
  id: z.string(), status: z.enum(["pending", "complete", "failed"]),
  authUrl: z.string().nullable(), userCode: z.string().nullable(),
  account: z.string().nullable(), error: z.string().nullable(), targetAccount: z.string().nullable(),
});

export type AuthContext = {
  store: AuthStore;
  login: LoginManager;
  onAccountsChanged: (() => void) | undefined;
};

export const accountList = operation({
  name: "account_list", description: "List Codex accounts and the active choice without exposing credentials.",
  input: z.object({}), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "List accounts", readOnlyHint: true },
  async call(ctx: AuthContext) { return { accounts: ctx.store.listAccounts() }; },
});

export const accountActivate = operation({
  name: "account_activate", description: "Use this Codex account for newly created app servers.",
  input: z.object({ name: accountName }), output: accountSchema,
  annotations: { title: "Select active account" },
  async call(ctx: AuthContext, { name }) {
    ctx.store.activate(name);
    ctx.onAccountsChanged?.();
    return { name, active: true };
  },
});

export const accountRemove = operation({
  name: "account_remove", description: "Delete a saved Codex account. Running servers retain their launch identity until stopped.",
  input: z.object({ name: accountName }), output: z.object({ accounts: z.array(accountSchema) }),
  annotations: { title: "Remove account", destructiveHint: true },
  async call(ctx: AuthContext, { name }) {
    ctx.store.removeAccount(name);
    ctx.onAccountsChanged?.();
    return { accounts: ctx.store.listAccounts() };
  },
});

export const accountLoginStart = operation({
  name: "account_login_start", description: "Start a Codex device sign-in in an isolated temporary home, superseding any attempt already in progress. Optionally replace credentials for an existing name. Poll account_login_status for its verification URL, one-time code, and result.",
  input: z.object({ name: accountName.optional() }), output: loginStateSchema,
  annotations: { title: "Sign in to Codex" },
  async call(ctx: AuthContext, { name }) { return ctx.login.start(name ?? null); },
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
  accounts_changed: "Published when a Codex account signs in, is selected, or is removed.",
  login_changed: "Published when a Codex device sign-in starts, shows its prompt, is superseded or cancelled, or finishes. Never carries the prompt or credentials.",
} as const;

export type AuthTopic = keyof typeof topics;

export const api: PackageApi<AuthContext, AuthTopic> = {
  operations: [accountList, accountActivate, accountRemove, accountLoginStart, accountLoginStatus, accountLoginCurrent, accountLoginCancel],
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
    return { store, login: new LoginManager(store), onAccountsChanged: undefined };
  },
  async closeContext(ctx) {
    await ctx.login.close();
    ctx.store.close();
  },
};

export type { Account, LoginState };
