import type { ServerView } from "./supervisor.js";
import { activeThreads, listActiveThreads } from "./threads.js";

export async function runningTree(
  listServers: () => Promise<ServerView[]> | ServerView[],
  listThreads: (url: string, mainThreadId: string | null) => Promise<ReturnType<typeof activeThreads>> = listActiveThreads,
  includeThreads = false,
) {
  const running = (await listServers()).filter((server) => server.state === "running" && server.url);
  if (!includeThreads) {
    return { servers: running.map((server) => ({ id: server.id, cwd: server.cwd, url: server.url, account: server.runningAccount, threads: [] })) };
  }
  const servers = await Promise.all(
    running.map(async (server) => ({
      id: server.id,
      cwd: server.cwd,
      url: server.url,
      account: server.runningAccount,
      threads: await listThreads(server.url ?? "", server.mainThreadId),
    })),
  );
  return { servers };
}
