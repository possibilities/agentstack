"use server";

import { socketCall, socketPath } from "@agentstack/api";
import { installedRuntimeVersion, listActiveThreads, runningTree } from "../dist/src/index.js";
import type { ServerView } from "../src/supervisor";
import type { ActiveThread } from "../src/threads";
import type { InputObservation, InputObservationTarget, InputObservationIssue } from "../src/input-observer";
import type { TreeNode } from "./agent-tree";

export type Account = { name: string; active: boolean };
export type LoginState = { id: string; status: "pending" | "complete" | "failed"; authUrl: string | null; userCode: string | null; account: string | null; error: string | null; targetAccount: string | null };

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
export async function codexCurrentLogin(): Promise<LoginState | null> {
  return (await call<{ login: LoginState | null }>("account_login_current")).login;
}
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

export async function codexInputLog(): Promise<{ targets: InputObservationTarget[]; entries: InputObservation[]; issues: InputObservationIssue[] } | null> {
  try {
    return await socketCall(socketPath("codex"), "tools/call", {
      name: "input_observe_list", arguments: {},
    }) as { targets: InputObservationTarget[]; entries: InputObservation[]; issues: InputObservationIssue[] };
  } catch { return null; }
}

export async function startInputObservation(form: FormData): Promise<void> {
  const target = form.get("target");
  if (typeof target !== "string") throw new Error("choose a Codex thread");
  let parsed: unknown;
  try { parsed = JSON.parse(target); } catch { throw new Error("invalid Codex thread selection"); }
  if (!Array.isArray(parsed) || parsed.length !== 2 || !parsed.every((item) => typeof item === "string")) {
    throw new Error("invalid Codex thread selection");
  }
  const [serverId, threadId] = parsed as [string, string];
  await socketCall(socketPath("codex"), "tools/call", {
    name: "input_observe_start", arguments: { serverId, threadId },
  });
}

export async function stopInputObservation(form: FormData): Promise<void> {
  const serverId = form.get("serverId");
  const threadId = form.get("threadId");
  if (typeof serverId !== "string" || typeof threadId !== "string") throw new Error("choose a Codex thread");
  await socketCall(socketPath("codex"), "tools/call", {
    name: "input_observe_stop", arguments: { serverId, threadId },
  });
}
