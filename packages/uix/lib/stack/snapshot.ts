import { socketCall, socketPath, websocketPort } from "@agentstack/api";
import { loadCatalog } from "./catalog";
import { loadResources } from "./resources";
import type { Account, Bot, BotSettings, Login, OwnerStatus, PackageDoc, Resource, RolePreview, RoleSnapshot, Snapshot, UsageSnapshot, VoiceCall, WorkerAccount, WorkerLogin, WorkerRuntime, WorkerSession } from "./types";

const knownPackages = ["api", "auth", "bots", "brain", "browse", "content", "infer", "notify", "roles", "owner", "scrape", "signal", "usage", "worker"];

function call<T>(pkg: string, name: string, args: Record<string, unknown> = {}): Promise<T> {
  return socketCall(socketPath(pkg), "tools/call", { name, arguments: args }, { timeoutMs: 2_000 }) as Promise<T>;
}

async function resource<T>(load: () => Promise<T>): Promise<Resource<T>> {
  try {
    return { data: await load(), error: null, at: Date.now() };
  } catch (error) {
    return { data: null, error: error instanceof Error ? error.message : String(error), at: Date.now() };
  }
}

export function websocketEndpoints(catalog: PackageDoc[] | null): Record<string, string> {
  if (catalog) {
    return Object.fromEntries(catalog.flatMap((doc) => {
      const endpoint = doc.transports.find((transport) => transport.type === "websocket")?.endpoint;
      return endpoint ? [[doc.name, endpoint]] : [];
    }));
  }
  let port = 0;
  try {
    port = websocketPort(process.env);
  } catch {
    return {};
  }
  return port === 0 ? {} : Object.fromEntries(knownPackages.map((name) => [name, `ws://127.0.0.1:${port}/websocket`]));
}

export async function loadSnapshot(): Promise<Snapshot> {
  const [owner, resources, accounts, workerAccounts, workerRuntimes, workerSessions, login, workerLogins, bots, botDefaults, voice, role, rolePreview, catalog, usage] = await Promise.all([
    resource(() => call<OwnerStatus>("owner", "owner_status")),
    resource(() => loadResources((name, args) => call<never>("owner", name, args))),
    resource(async () => (await call<{ accounts: Account[] }>("auth", "account_list")).accounts),
    resource(async () => (await call<{ accounts: WorkerAccount[] }>("auth", "worker_account_list")).accounts),
    resource(async () => (await call<{ runtimes: WorkerRuntime[] }>("worker", "worker_runtime_list")).runtimes),
    resource(async () => (await call<{ workers: WorkerSession[] }>("worker", "worker_list")).workers),
    resource(async () => (await call<{ login: Login | null }>("auth", "account_login_current")).login),
    resource(async () => (await call<{ logins: WorkerLogin[] }>("auth", "worker_account_login_current")).logins),
    resource(async () => (await call<{ bots: Bot[] }>("bots", "bot_list")).bots),
    resource(() => call<BotSettings>("bots", "bot_defaults_get")),
    resource(async () => (await call<{ call: VoiceCall | null }>("bots", "voice_status")).call),
    resource(() => call<RoleSnapshot>("roles", "role_snapshot")),
    resource(() => call<RolePreview>("roles", "role_preview")),
    resource(() => loadCatalog((name, args) => call("api", name, args))),
    resource(() => call<UsageSnapshot>("usage", "usage_snapshot")),
  ]);
  return { owner, resources, accounts, workerAccounts, workerRuntimes, workerSessions, login, workerLogins, bots, botDefaults, voice, role, rolePreview, catalog, usage, endpoints: websocketEndpoints(catalog.data) };
}
