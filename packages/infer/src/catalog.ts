import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { model, type Model } from "./schema.js";

type Rpc = { id?: unknown; result?: unknown; error?: unknown };
type Page = { data?: unknown; nextCursor?: unknown };
const asObject = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** An isolated, short-lived app-server is used only for model/list. It never starts a thread or turn. */
export async function discoverModels(stateDir: string, auth: string,
  binary = join(homedir(), ".local/libexec/codexnk/codex")): Promise<Model[]> {
  const root = await mkdtemp(join(stateDir, ".infer-catalog-"));
  const identity = join(root, "identity"), capabilities = join(root, "capabilities"), history = join(root, "history"), runtime = join(root, "runtime");
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await Promise.all([identity, capabilities, history, runtime].map((dir) => mkdir(dir, { mode: 0o700 })));
    await writeFile(join(identity, "auth.json"), auth, { mode: 0o600, flag: "wx" });
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: runtime };
    for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_HOME"]) delete env[key];
    child = spawn(binary,
      ["app-server", "--stdio", "--identity", identity, "--capabilities", capabilities, "--history-dir", history],
      { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] });
    const proc = child;
    return await new Promise<Model[]>((resolve, reject) => {
      let done = false, buffer = "", pages = 0, rows: Model[] = [];
      const timer = setTimeout(() => finish(new Error("catalog_unavailable")), 20_000);
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(rows);
      };
      const send = (value: unknown) => proc.stdin?.write(`${JSON.stringify(value)}\n`);
      const next = (cursor?: string) => send({ jsonrpc: "2.0", id: 2 + pages++, method: "model/list", params: { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) } });
      proc.on("error", () => finish(new Error("catalog_unavailable")));
      proc.on("exit", () => finish(new Error("catalog_unavailable")));
      proc.stdin?.on("error", () => finish(new Error("catalog_unavailable")));
      proc.stdout?.on("error", () => finish(new Error("catalog_unavailable")));
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        if (done) return;
        buffer += chunk;
        if (buffer.length > 1_000_000) { finish(new Error("catalog_invalid")); return; }
        let newline = buffer.indexOf("\n");
        while (newline !== -1 && !done) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message = JSON.parse(line) as Rpc;
            if (message.id === 1) {
              if (message.error || !asObject(message.result)) throw new Error("catalog_invalid");
              send({ jsonrpc: "2.0", method: "initialized", params: {} });
              next();
            } else if (typeof message.id === "number" && message.id >= 2) {
              const page = asObject(message.result) as Page | null;
              if (message.error || !page || !Array.isArray(page.data) || pages !== message.id - 1) throw new Error("catalog_invalid");
              for (const entry of page.data) {
                const item = asObject(entry);
                if (item?.hidden === true) throw new Error("catalog_invalid");
                const efforts = item?.supportedReasoningEfforts;
                const parsed = model.safeParse({ id: item?.id, defaultEffort: item?.defaultReasoningEffort,
                  supportedEfforts: Array.isArray(efforts) ? efforts.map((e) => asObject(e)?.reasoningEffort) : null });
                if (!parsed.success || !parsed.data.supportedEfforts.includes(parsed.data.defaultEffort) || rows.some((row) => row.id === parsed.data.id))
                  throw new Error("catalog_invalid");
                rows.push(parsed.data);
              }
              if (rows.length > 500) throw new Error("catalog_invalid");
              if (page.nextCursor === null) { finish(); break; }
              if (typeof page.nextCursor !== "string" || !page.nextCursor || pages >= 20 || rows.length > 500) throw new Error("catalog_invalid");
              next(page.nextCursor);
            }
          } catch { finish(new Error("catalog_invalid")); }
          newline = buffer.indexOf("\n");
        }
      });
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "agentstack-infer", version: "0.0.0" }, capabilities: {} } });
    });
  } finally {
    if (child) {
      child.kill("SIGKILL");
      await new Promise<void>((resolve) => { if (child?.pid === undefined || child.exitCode !== null || child.signalCode !== null) resolve(); else child.once("exit", () => resolve()); });
    }
    await rm(root, { recursive: true, force: true });
  }
}
