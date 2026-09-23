"use server";

import { socketCall, socketPath } from "@agentstack/api";
import { installedRuntimeVersion, listActiveThreads, runningTree } from "../dist/src/index.js";
import type { ServerView } from "../src/supervisor";
import type { ActiveThread } from "../src/threads";
import type { TreeNode } from "./agent-tree";

export type Account = { name: string; active: boolean };
export type LoginState = { id: string; status: "pending" | "complete" | "failed"; authUrl: string | null; account: string | null; error: string | null };

async function call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return socketCall(socketPath("codex"), "tools/call", { name, arguments: args }) as Promise<T>;
}

export async function codexAccounts(): Promise<Account[]> {
  return (await call<{ accounts: Account[] }>("account_list")).accounts;
}

export async function selectCodexAccount(name: string): Promise<Account[]> {
  await call("account_activate", { name });
  return codexAccounts();
}

export async function removeCodexAccount(name: string): Promise<Account[]> {
  return (await call<{ accounts: Account[] }>("account_remove", { name })).accounts;
}

export async function startCodexLogin(name?: string): Promise<LoginState> { return call("account_login_start", name ? { name } : {}); }
export async function codexLoginStatus(id: string): Promise<LoginState> { return call("account_login_status", { id }); }
export async function cancelCodexLogin(id: string): Promise<void> { await call("account_login_cancel", { id }); }

export async function codexVersion(): Promise<string | null> {
  return installedRuntimeVersion();
}

async function listServers(): Promise<ServerView[]> {
  const result = (await socketCall(socketPath("codex"), "tools/call", {
    name: "server_list",
    arguments: {},
  })) as { servers: ServerView[] };
  return result.servers;
}

function mapThread(thread: ActiveThread): TreeNode {
  return {
    id: thread.id,
    kind: "native",
    label: thread.label,
    detail: thread.model ?? "",
    activity: thread.activity,
    children: (thread.children ?? []).map(mapThread),
  };
}

export async function codexEventsUrl(): Promise<string | null> {
  try {
    const listed = (await socketCall(socketPath("codex"), "tools/list")) as {
      websocket?: { url?: unknown } | null;
    };
    return typeof listed.websocket?.url === "string" ? listed.websocket.url : null;
  } catch {
    return null;
  }
}

export async function codexTree(includeThreads: boolean): Promise<TreeNode[]> {
  const tree = await runningTree(listServers, listActiveThreads, includeThreads);
  return tree.servers.map((server) => ({
    id: server.id,
    kind: "manager",
    label: server.id,
    detail: `${server.account ?? "account unknown"} · ${server.cwd}`,
    activity: "working",
    children: (server.threads ?? []).map(mapThread),
  }));
}
