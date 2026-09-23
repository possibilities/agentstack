import type { Supervisor } from "./supervisor.js";
import { activeThreads, listActiveThreads } from "./threads.js";

export async function runningTree(
  supervisor: Supervisor,
  listThreads: (url: string) => Promise<ReturnType<typeof activeThreads>> = listActiveThreads,
  includeThreads = false,
) {
  const running = supervisor.list().filter((server) => server.state === "running" && server.url);
  if (!includeThreads) {
    return { servers: running.map((server) => ({ id: server.id, cwd: server.cwd, url: server.url, threads: [] })) };
  }
  const servers = await Promise.all(
    running.map(async (server) => ({
      id: server.id,
      cwd: server.cwd,
      url: server.url,
      threads: await listThreads(server.url ?? ""),
    })),
  );
  return { servers };
}
