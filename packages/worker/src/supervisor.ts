import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountEnvironment, accountRoot, type WorkerAccount } from "@stack/auth";
import { clearStateFiles, snapshotStateFiles, socketCall, socketPath, socketSubscribe, stateHash, type FileSnapshot, type SocketSubscription } from "@stack/api";
import { AcpProcess, record } from "./acp.js";
import type { WorkerBackend } from "./backend.js";
import { ClaudeBackend, CLAUDE_SDK_VERSION, CLAUDE_CODE_VERSION, type ClaudeQueryFactory } from "./claude.js";
import { catalogModels, effortOption, modelOption, nativeDevinModels, optionsOf, type Catalog, type ModelChoice } from "./catalog.js";

export type Runtime = { account: WorkerAccount; process: WorkerBackend; backend: "acp" | "claude-sdk"; version: string; probeSession: string | null;
  canClose: boolean; canLoad: boolean; supportsHttp: boolean; instance: string;
  capabilities: Record<string, unknown>; agentInfo: Record<string, unknown> | null };
export type RuntimeView = { id: string; provider: WorkerAccount["provider"]; state: "running" | "stopped" | "error";
  backend: "acp" | "claude-sdk"; processModel: "account" | "session"; pids: number[];
  pid: number | null; instance: string | null; error: string | null };

export class WorkerSupervisor {
  onChange?: () => void;
  onRuntimeReady?: (runtime: Runtime) => void;
  onRuntimeExit?: (accountId: string) => void;
  private live = new Map<string, Runtime>();
  private errors = new Map<string, { provider: WorkerAccount["provider"]; message: string }>();
  private launchRetry = new Map<string, { after: number; delay: number }>();
  private catalogs = new Map<string, Catalog>();
  private inflight = new Map<string, Promise<Catalog>>();
  private readonly catalogFences = new Set<string>();
  private readonly nativeFences = new Set<string>();
  private draining = new Map<string, Promise<void>>();
  private teardown = new Map<string, WorkerBackend>();
  private retryAfter = new Map<string, number>();
  private syncQueue: Promise<void> = Promise.resolve();
  private watch: SocketSubscription | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  private readonly bin: Record<"codex" | "devin", string>;

  constructor(private readonly stateDir: string, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly dependencies: { claudeQuery?: ClaudeQueryFactory } = {}) {
    const home = env.HOME ?? homedir();
    const opencodeV2 = env.STACK_OPENCODE_BIN ?? join(home, ".local", "bin", "opencode");
    this.bin = { codex: opencodeV2,
      devin: env.STACK_DEVIN_BIN ?? join(home, ".local", "share", "devin", "cli", "_versions", "current", "bin", "devin") };
  }

  start(): void {
    void this.connect();
    this.timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, 60_000);
    this.timer.unref();
  }

  private async connect(): Promise<void> {
    if (this.closing) return;
    try {
      this.watch = await socketSubscribe(socketPath("auth", this.env), ["worker_accounts_changed"], () => { void this.reconcile().catch(() => undefined); });
      await this.reconcile();
      void this.watch.closed.then(() => { this.watch = undefined; if (!this.closing) setTimeout(() => void this.connect(), 2_000).unref(); });
    } catch {
      if (!this.closing) setTimeout(() => void this.connect(), 2_000).unref();
    }
  }

  private accounts(): Promise<WorkerAccount[]> {
    return socketCall(socketPath("auth", this.env), "tools/call", { name: "worker_account_list", arguments: {} }, { timeoutMs: 5_000 })
      .then((value) => (value as { accounts: WorkerAccount[] }).accounts);
  }

  reconcile(): Promise<void> {
    this.syncQueue = this.syncQueue.catch(() => undefined).then(async () => {
      if (this.closing) return;
      const accounts = await this.accounts();
      const wanted = new Map(accounts.filter((account) => account.enabled && account.ready && !account.removing).map((account) => [account.id, account]));
      for (const [id, runtime] of this.live) if (!wanted.has(id)) {
        this.live.delete(id); this.teardown.set(id, runtime.process); this.onRuntimeExit?.(id);
        await runtime.process.close(); this.teardown.delete(id); this.onChange?.();
      }
      for (const id of this.errors.keys()) if (!wanted.has(id)) { this.errors.delete(id); this.launchRetry.delete(id); this.onChange?.(); }
      for (const account of wanted.values()) {
        if (this.live.has(account.id) || this.draining.has(account.id) || this.teardown.has(account.id) || this.nativeFences.has(account.id)) continue;
        if (Date.now() < (this.launchRetry.get(account.id)?.after ?? 0)) continue;
        await this.launch(account);
        // A newly ready account has never been observed; observe it now rather than on its first catalog read.
        if (this.live.has(account.id) && !this.catalogs.has(account.id) && !await this.readCatalog(account.id))
          void this.catalog(account.id, false).catch(() => undefined);
      }
    });
    return this.syncQueue;
  }

  private async launch(account: WorkerAccount): Promise<void> {
    const cwd = join(accountRoot(this.stateDir, account.id), "probe");
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    if (account.provider === "claude") {
      const child = new ClaudeBackend(accountEnvironment(this.stateDir, account, this.env), this.dependencies.claudeQuery);
      const runtime: Runtime = { account, process: child, backend: "claude-sdk", version: CLAUDE_SDK_VERSION, probeSession: null,
        canClose: true, canLoad: true, supportsHttp: true, instance: randomUUID(),
        capabilities: { persistentSessions: true, resume: true, processModel: "session" },
        agentInfo: { name: "claude-agent-sdk", version: CLAUDE_SDK_VERSION, bundledClaudeCodeVersion: CLAUDE_CODE_VERSION } };
      this.register(runtime);
      return;
    }
    const version = await this.binaryVersion(account);
    if (account.provider !== "devin" && !/(?:^|\s)v?2\.[0-9]+(?:\.|$)/.test(version)) {
      this.errors.set(account.id, { provider: account.provider, message: "Required OpenCode V2 ACP binary is unavailable; inspect ~/.local/bin/opencode" });
      const delay = Math.min((this.launchRetry.get(account.id)?.delay ?? 30_000) * 2, 30 * 60_000);
      this.launchRetry.set(account.id, { after: Date.now() + delay, delay });
      this.onChange?.();
      return;
    }
    const child = new AcpProcess(this.bin[account.provider], ["acp"], cwd, accountEnvironment(this.stateDir, account, this.env));
    try {
      const initialized = await child.initialize();
      const canClose = record(initialized.agentCapabilities) && record(initialized.agentCapabilities.sessionCapabilities)
        && record(initialized.agentCapabilities.sessionCapabilities.close);
      const canLoad = record(initialized.agentCapabilities) && initialized.agentCapabilities.loadSession === true;
      const supportsHttp = record(initialized.agentCapabilities) && record(initialized.agentCapabilities.mcpCapabilities)
        && initialized.agentCapabilities.mcpCapabilities.http === true;
      const runtime: Runtime = { account, process: child, backend: "acp", version, probeSession: null, canClose: Boolean(canClose),
        canLoad: Boolean(canLoad), supportsHttp: Boolean(supportsHttp), instance: randomUUID(),
        capabilities: record(initialized.agentCapabilities) ? initialized.agentCapabilities : {},
        agentInfo: record(initialized.agentInfo) ? initialized.agentInfo : null };
      this.register(runtime);
    } catch {
      this.teardown.set(account.id, child);
      await child.close(); this.teardown.delete(account.id);
      this.errors.set(account.id, { provider: account.provider, message: "ACP initialization failed; inspect the native account and runtime" });
      const delay = Math.min((this.launchRetry.get(account.id)?.delay ?? 30_000) * 2, 30 * 60_000);
      this.launchRetry.set(account.id, { after: Date.now() + delay, delay });
      this.onChange?.();
    }
  }

  private register(runtime: Runtime): void {
    const { account, process: child } = runtime;
    this.live.set(account.id, runtime);
    this.onRuntimeReady?.(runtime);
    this.errors.delete(account.id);
    this.launchRetry.delete(account.id);
    this.onChange?.();
    void child.exited.then(() => {
      if (this.live.get(account.id)?.process !== child) return;
      this.live.delete(account.id);
      this.onRuntimeExit?.(account.id);
      this.errors.set(account.id, { provider: account.provider, message: "Worker runtime exited; inspect the native account before retrying" });
      this.onChange?.();
    });
  }

  private binaryVersion(account: WorkerAccount): Promise<string> {
    if (account.provider === "claude") return Promise.resolve(CLAUDE_SDK_VERSION);
    const binary = this.bin[account.provider];
    return new Promise((resolve) => {
      execFile(binary, ["--version"], { env: accountEnvironment(this.stateDir, account, this.env), timeout: 3_000,
        maxBuffer: 1024 }, (error, stdout) => resolve(error ? "unknown" : stdout.trim().slice(0, 128) || "unknown"));
    });
  }

  async drain(id: string): Promise<void> {
    const prior = this.draining.get(id); if (prior) return prior;
    const task = (async () => {
      await this.syncQueue.catch(() => undefined);
      const runtime = this.live.get(id);
      if (runtime) { this.live.delete(id); this.teardown.set(id, runtime.process); this.onRuntimeExit?.(id); }
      // Failed close retains the exact backend for an explicitly requested retry.
      // Absence from the live map alone is not evidence that native teardown ended.
      const backend = this.teardown.get(id);
      if (backend) { await backend.close(); this.teardown.delete(id); }
      this.catalogs.delete(id); this.retryAfter.delete(id); this.launchRetry.delete(id); this.errors.delete(id);
      this.onChange?.();
    })().finally(() => this.draining.delete(id));
    this.draining.set(id, task); return task;
  }

  async stateDependencies(id: string) {
    await this.syncQueue;
    const runtime = this.live.get(id), draining = this.draining.has(id) || this.teardown.has(id), discovering = this.inflight.has(id);
    return { revision: stateHash([id, runtime?.instance ?? null, draining, discovering]),
      blockedBy: [...(runtime ? ["Disable the account and explicitly drain its runtime before cache maintenance"] : []),
        ...(draining ? ["Account runtime teardown is still in progress"] : []), ...(discovering ? ["Account catalog observation is still in flight"] : [])],
      retained: ["Worker conversations, captured Work, native sessions, source repositories and account credentials remain"], relationships: [] };
  }

  runtimeList(): RuntimeView[] {
    return [...new Set([...this.live.keys(), ...this.errors.keys()])].map((id) => {
      const runtime = this.live.get(id);
      const provider = runtime?.account.provider ?? this.errors.get(id)?.provider ?? "devin";
      return { id, provider: runtime?.account.provider ?? this.errors.get(id)?.provider ?? "devin", state: runtime ? "running" : "error", pid: runtime?.process.pid ?? null,
        backend: provider === "claude" ? "claude-sdk" : "acp", processModel: provider === "claude" ? "session" : "account",
        pids: runtime?.process.pids ?? (runtime?.process.pid ? [runtime.process.pid] : []),
        instance: runtime?.instance ?? null, error: this.errors.get(id)?.message ?? null };
    });
  }

  runtime(id: string): Runtime | null { return this.live.get(id) ?? null; }

  async catalog(id: string, refresh: boolean): Promise<Catalog> {
    if (this.catalogFences.has(id) || this.nativeFences.has(id)) throw new Error("Account catalog/native maintenance is in progress");
    const account = (await this.accounts()).find((item) => item.id === id);
    if (!account || !account.ready || !account.enabled || account.removing) throw new Error("worker account is not enabled and ready");
    const saved = this.catalogs.get(id) ?? await this.readCatalog(id);
    if (this.catalogFences.has(id) || this.nativeFences.has(id)) throw new Error("Account catalog/native maintenance is in progress");
    if (saved) this.catalogs.set(id, saved);
    if (!refresh && saved && !saved.stale && Date.now() - Date.parse(saved.observedAt) < 30 * 60_000 && this.live.has(id)) return saved;
    if (!refresh && saved?.stale && Date.now() < (this.retryAfter.get(id) ?? 0)) return saved;
    const prior = this.inflight.get(id);
    if (prior) return prior;
    if (!this.live.has(id)) await this.reconcile();
    if (this.catalogFences.has(id) || this.nativeFences.has(id)) throw new Error("Account catalog/native maintenance is in progress");
    const run = this.discover(account).then((result) => {
      this.catalogs.set(id, result);
      this.retryAfter.delete(id);
      this.onChange?.();
      return result;
    }).catch((error) => {
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 160) || "unknown";
      const message = `Worker catalog refresh failed (${detail}); inspect the private account runtime`;
      const failed: Catalog = saved ? { ...saved, stale: true, error: message } : { accountId: id, provider: account.provider, observedAt: new Date(0).toISOString(), source: account.provider === "claude" ? "claude-sdk-supported-models" : account.provider === "devin" ? "acp-session" : "acp-v2-session",
        runtimeVersion: "unknown", modelConfigId: null, models: [], nativeModelIds: [], stale: true, error: message } satisfies Catalog;
      this.catalogs.set(id, failed);
      this.retryAfter.set(id, Date.now() + 60_000);
      this.onChange?.();
      return failed;
    }).finally(() => this.inflight.delete(id));
    this.inflight.set(id, run);
    return run;
  }

  private async discover(account: WorkerAccount): Promise<Catalog> {
    const runtime = this.live.get(account.id);
    if (!runtime) throw new Error(this.errors.get(account.id)?.message ?? "ACP process is not ready");
    if (runtime.probeSession && runtime.canClose) {
      await runtime.process.request("session/close", { sessionId: runtime.probeSession });
      runtime.probeSession = null;
    }
    const result = await runtime.process.request("session/new", { cwd: join(accountRoot(this.stateDir, account.id), "probe"), mcpServers: [] });
    if (!record(result) || typeof result.sessionId !== "string") throw new Error("ACP did not return a probe session ID");
    runtime.probeSession = result.sessionId;
    const choices = optionsOf(result);
    const model = modelOption(choices);
    if (!model || !model.values.length) throw new Error("ACP did not advertise account-bound model choices");
    const models: ModelChoice[] = [];
    for (const entry of model.values.slice(0, 256)) {
      let selected = choices;
      if (model.id !== "model" || choices.some((item) => item.category === "model")) {
        let changed: unknown;
        try { changed = await runtime.process.request("session/set_config_option", { sessionId: runtime.probeSession, configId: model.id, value: entry.value }); }
        catch (error) {
          // Claude refuses to select a model this account cannot use without purchased usage credits; it cannot be dispatched.
          if (runtime.backend === "claude-sdk" && error instanceof Error && /Usage credits are required for this model/i.test(error.message)) continue;
          throw error;
        }
        selected = optionsOf(changed);
      }
      const effort = effortOption(selected);
      models.push({ id: entry.value, name: entry.name, efforts: effort?.values.map((value) => value.value) ?? [], effortConfigId: effort?.id ?? null });
    }
    const nativeModelIds = account.provider === "devin" ? await this.devinModelIds(account) : [];
    const catalog: Catalog = { accountId: account.id, provider: account.provider, observedAt: new Date().toISOString(),
      source: account.provider === "claude" ? "claude-sdk-supported-models" : account.provider === "devin" ? "acp-session" : "acp-v2-session", runtimeVersion: runtime.version, modelConfigId: model.id,
      models: catalogModels(account.provider, models), nativeModelIds, stale: false, error: null };
    if (runtime.backend === "claude-sdk") {
      await runtime.process.request("session/close", { sessionId: runtime.probeSession });
      runtime.probeSession = null;
    }
    await this.saveCatalog(catalog);
    return catalog;
  }

  private devinModelIds(account: WorkerAccount): Promise<string[]> {
    return new Promise((resolve, reject) => {
      execFile(this.bin.devin, ["models", "list", "--format", "json"], { env: accountEnvironment(this.stateDir, account, this.env),
        timeout: 20_000, maxBuffer: 2_000_000 }, (error, stdout) => {
        if (error) { reject(new Error("Devin native model list failed")); return; }
        try {
          const ids = nativeDevinModels(JSON.parse(stdout) as unknown);
          if (!ids.length) throw new Error("no models");
          resolve(ids);
        } catch { reject(new Error("Devin native model list was invalid")); }
      });
    });
  }

  private catalogPath(id: string): string { return join(accountRoot(this.stateDir, id), "catalog.json"); }
  async maintainNative<T>(id: string, run: () => Promise<T>) {
    if (this.nativeFences.has(id)) throw new Error("Account native maintenance is in progress");
    this.nativeFences.add(id);
    try { const deps = await this.stateDependencies(id); if (deps.blockedBy.length) throw new Error(deps.blockedBy.join("; ")); return await run(); }
    finally { this.nativeFences.delete(id); }
  }
  async catalogObservation(id: string) {
    let files: FileSnapshot | null = null;
    try { files = await snapshotStateFiles(accountRoot(this.stateDir, id), { paths: ["catalog.json"] }); }
    catch (error) { if (!String(error).includes("No such file or directory")) throw error; }
    return { revision: stateHash([this.catalogs.get(id) ?? null, files, this.inflight.has(id)]), files,
      blockedBy: this.inflight.has(id) ? ["Catalog discovery is in flight"] : [] };
  }
  async maintainCatalogs<T>(ids: string[], run: () => Promise<T>) {
    if (ids.some(id => this.catalogFences.has(id) || this.inflight.has(id))) throw new Error("Account catalog observation/maintenance is in progress");
    ids.forEach(id => this.catalogFences.add(id));
    try { return await run(); } finally { ids.forEach(id => this.catalogFences.delete(id)); }
  }
  async clearCatalog(id: string, files: FileSnapshot | null) {
    if (!this.catalogFences.has(id) || this.inflight.has(id)) throw new Error("Account catalog lifecycle is not fenced");
    if (files) { const result = await clearStateFiles(accountRoot(this.stateDir, id), { paths: ["catalog.json"] }, files); if (result.error) throw new Error("Catalog file retirement partial; inspect quarantine"); }
    this.catalogs.delete(id); this.retryAfter.delete(id); this.onChange?.();
  }
  private async readCatalog(id: string): Promise<Catalog | null> {
    try {
      const value = JSON.parse(await readFile(this.catalogPath(id), "utf8")) as Catalog;
      if (value.accountId !== id || !Array.isArray(value.models)) return null;
      return { ...value, modelConfigId: typeof value.modelConfigId === "string" ? value.modelConfigId : null,
        models: catalogModels(value.provider, value.models), stale: true };
    } catch { return null; }
  }
  private async saveCatalog(value: Catalog): Promise<void> {
    const path = this.catalogPath(value.accountId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    } catch (error) { await rm(temporary, { force: true }); throw error; }
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.watch?.close();
    await this.syncQueue.catch(() => undefined);
    const running = [...this.live.values()];
    this.live.clear();
    for (const runtime of running) this.onRuntimeExit?.(runtime.account.id);
    await Promise.all([...new Set([...running.map(runtime => runtime.process), ...this.teardown.values()])].map(backend => backend.close()));
    await Promise.all([...this.inflight.values()].map((run) => run.catch(() => undefined)));
  }
}
