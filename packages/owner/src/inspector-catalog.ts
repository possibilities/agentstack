import { randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configuredMcpPackages, socketPath, workspaceRoot } from "@agentstack/api";

export type InspectorCatalog = { path: string; close(): Promise<void> };

export async function serveInspectorCatalog(options: {
  env?: NodeJS.ProcessEnv;
  root?: string;
  mcpPort: number;
}): Promise<InspectorCatalog> {
  const env = options.env ?? process.env;
  const root = options.root ?? workspaceRoot(import.meta.dirname);
  const state = dirname(dirname(socketPath("api", env)));
  await mkdir(state, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(state, "inspector-"));
  const path = join(directory, "mcp.json");
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  let last = "";
  let lastError = "";
  let closed = false;
  let pending = Promise.resolve();

  const sync = async (): Promise<void> => {
    const packages = await configuredMcpPackages(root);
    const content = `${JSON.stringify({
      mcpServers: Object.fromEntries(packages.map(({ name }) => [name, {
        type: "http",
        url: `http://127.0.0.1:${options.mcpPort}/mcp/${name}`,
        suppressNotificationStream: true,
      }])),
    }, null, 2)}\n`;
    if (content === last && await readFile(path, "utf8").catch(() => null) === content) return;
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      last = content;
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const refresh = (): void => {
    if (closed) return;
    pending = pending.then(sync, sync).then(() => { lastError = ""; }, (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastError) console.error(`Inspector catalog: ${message}`);
      lastError = message;
    });
  };

  try {
    await sync();
    watcher = watch(join(root, "packages"), { recursive: true }, (_event, filename) => {
      if (filename && (filename === "api.yaml" || filename.endsWith("/api.yaml"))) refresh();
    });
    watcher.on("error", (error) => console.error(`Inspector catalog watcher: ${error.message}`));
    timer = setInterval(refresh, 5_000);
    timer.unref();
  } catch (error) {
    watcher?.close();
    if (timer) clearInterval(timer);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    path,
    close() {
      closing ??= (async () => {
        closed = true;
        watcher?.close();
        if (timer) clearInterval(timer);
        await pending;
        await rm(directory, { recursive: true, force: true });
      })();
      return closing;
    },
  };
}
