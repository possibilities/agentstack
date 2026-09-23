"use server";

import { socketCall, socketPath } from "@agentstack/api";
import { listActiveThreads, runningTree } from "../dist/src/index.js";
import type { ServerView } from "../src/supervisor";
import type { ActiveThread } from "../src/threads";
import type { TreeNode } from "./agent-tree";

async function listServers(): Promise<ServerView[]> {
  const result = (await socketCall(socketPath("codex"), "tools/call", {
    name: "server_list",
    arguments: {},
  })) as { servers: ServerView[] };
  return result.servers;
}

function mapThread(thread: ActiveThread): TreeNode {
  return {
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
    kind: "manager",
    label: server.id,
    detail: server.cwd,
    activity: "working",
    children: (server.threads ?? []).map(mapThread),
  }));
}
