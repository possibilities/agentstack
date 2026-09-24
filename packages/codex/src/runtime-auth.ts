import { watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { StateStore, type StoredServer } from "./store.js";

type SyncStatus = "updated" | "unchanged" | "stale" | "invalid" | "missing" | "unavailable";

// codexnk creates a random, retained runtime home with tempfile::TempDir::new().
// A private TMPDIR per Server makes that home discoverable without changing Codex.
export class RuntimeAuth {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly records = new Map<string, StoredServer>();
  private readonly queues = new Map<string, Promise<void>>();
  private scanTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly store: StateStore) {}

  rootFor(id: string): string { return join(this.store.stateDir, "runtime", id); }

  async prepare(id: string): Promise<string> {
    await mkdir(join(this.store.stateDir, "runtime"), { recursive: true, mode: 0o700 });
    const root = this.rootFor(id);
    await mkdir(root, { mode: 0o700 }); // Never erase an unexplained previous runtime.
    return root;
  }

  async reconcile(record: StoredServer): Promise<SyncStatus> {
    const prior = this.queues.get(record.id) ?? Promise.resolve();
    let result: SyncStatus = "unavailable";
    const run = prior.then(async () => { result = await this.readAndSync(record); }, async () => { result = await this.readAndSync(record); });
    const settled = run.then(() => undefined, () => undefined);
    this.queues.set(record.id, settled);
    void settled.then(() => { if (this.queues.get(record.id) === settled) this.queues.delete(record.id); });
    await run;
    return result;
  }

  async watch(record: StoredServer): Promise<void> {
    if (!record.runtimeRoot || !record.account || record.authVersion === null) return;
    this.records.set(record.id, record);
    await this.attach(record).catch((error) => console.error(`Codex auth watcher ${record.id}: ${error}`));
    this.scanTimer ??= setInterval(() => {
      for (const current of this.records.values()) {
        if (!this.watchers.has(current.id)) void this.attach(current).catch((error) => console.error(`Codex auth watcher ${current.id}: ${error}`));
        this.schedule(current.id, 0);
      }
    }, 30_000);
    this.scanTimer.unref();
  }

  async finish(record: StoredServer): Promise<void> {
    this.unwatch(record.id);
    const removedAccount = record.account !== null && !this.store.listAccounts().some(({ id }) => id === record.account);
    const status = removedAccount ? "missing" : await this.reconcile(record);
    const emptyRoot = status === "unavailable" && record.runtimeRoot === this.rootFor(record.id) &&
      (await readdir(record.runtimeRoot).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : ["unknown"])).length === 0;
    if (record.runtimeRoot && record.runtimeRoot === this.rootFor(record.id) && (["updated", "unchanged", "missing"].includes(status) || emptyRoot)) {
      await rm(record.runtimeRoot, { recursive: true, force: true });
      record.runtimeRoot = null;
      this.store.saveServer(record);
    } else if (record.runtimeRoot && status !== "unavailable") {
      console.error(`Codex auth for ${record.id} was not reconciled (${status}); retaining its private runtime for recovery`);
    }
  }

  async close(): Promise<void> {
    for (const id of [...this.records.keys()]) this.unwatch(id);
    await Promise.all(this.queues.values());
  }

  private async readAndSync(record: StoredServer): Promise<SyncStatus> {
    if (!record.runtimeRoot || record.runtimeRoot !== this.rootFor(record.id) || !record.account || record.authVersion === null) return "unavailable";
    const home = await this.discover(record.runtimeRoot);
    if (!home) return "unavailable";
    const path = join(home, "auth.json");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > 1_000_000) return "invalid";
        const first = await readFile(path, "utf8");
        await new Promise((resolve) => setTimeout(resolve, 40));
        const second = await readFile(path, "utf8");
        if (first !== second) continue;
        const outcome = this.store.syncCredential(record.account, record.authVersion, second);
        if (outcome.status === "updated" || outcome.status === "unchanged") {
          if (outcome.version !== null && record.authVersion !== outcome.version) {
            record.authVersion = outcome.version;
            this.store.saveServer(record);
          }
        }
        return outcome.status;
      } catch (error) {
        if (attempt === 2) console.error(`Codex auth read for ${record.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return "invalid";
  }

  private async discover(root: string): Promise<string | null> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const homes: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name);
      if ((await lstat(join(candidate, "auth.json")).catch(() => null))?.isFile()) homes.push(candidate);
    }
    return homes.length === 1 ? homes[0] : null;
  }

  private async attach(record: StoredServer): Promise<void> {
    const root = record.runtimeRoot;
    if (!root || root !== this.rootFor(record.id)) return;
    const home = await this.discover(root);
    if (!home) return;
    if (this.records.get(record.id) !== record || this.watchers.has(record.id)) return;
    const watcher = watch(home, (_event, filename) => {
      if (filename === null || filename === "auth.json") {
        this.schedule(record.id, 200);
      }
    });
    watcher.on("error", (error) => {
      watcher.close();
      this.watchers.delete(record.id);
      console.error(`Codex auth watcher ${record.id}: ${error.message}`);
    });
    watcher.unref();
    this.watchers.set(record.id, watcher);
    this.schedule(record.id, 0);
  }

  private schedule(id: string, delay: number): void {
    const record = this.records.get(id);
    if (!record) return;
    const existing = this.timers.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.reconcile(record).catch((error) => console.error(`Codex auth reconciliation ${id}: ${error}`));
    }, delay);
    timer.unref();
    this.timers.set(id, timer);
  }

  private unwatch(id: string): void {
    this.records.delete(id);
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    if (!this.records.size && this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
  }
}
