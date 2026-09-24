"use server";

import { socketCall, socketPath } from "@agentstack/api";
import { listActiveThreads, type ActiveThread, type ServerView } from "@agentstack/codex";
import type { TreeNode } from "@agentstack/codex/ui/agent-tree";

async function listBots(): Promise<ServerView[]> {
  const result = (await socketCall(socketPath("bots"), "tools/call", {
    name: "bot_list",
    arguments: {},
  })) as { bots: ServerView[] };
  return result.bots;
}

export async function botsEventsUrl(): Promise<string | null> {
  try {
    const listed = (await socketCall(socketPath("codex"), "tools/list")) as {
      websocket?: { url?: unknown } | null;
    };
    return typeof listed.websocket?.url === "string" ? listed.websocket.url : null;
  } catch {
    return null;
  }
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

export async function botsTree(): Promise<TreeNode[]> {
  const bots = await listBots();
  bots.sort((a, b) => Number(a.id.slice("bot-".length)) - Number(b.id.slice("bot-".length)));
  return Promise.all(
    bots.map(async (bot) => ({
      id: bot.id,
      kind: "manager" as const,
      label: bot.id,
      detail: `${bot.state === "stopped" ? "stopped · " : ""}${bot.account ?? "account unknown"} · ${bot.cwd}`,
      activity: (bot.state === "running" ? "working" : "idle") as TreeNode["activity"],
      children:
        bot.state === "running" && bot.url
          ? (await listActiveThreads(bot.url).catch(() => [] as ActiveThread[])).map(mapThread)
          : [],
    })),
  );
}
