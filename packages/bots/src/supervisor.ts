import { type ChildProcess, execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { accessSync, constants, createWriteStream, existsSync } from "node:fs";
import { connect } from "node:net";
import { codexRuntimePath } from "./paths.js";
import { DEFAULT_BOT_SETTINGS, StateStore, type BotSettings, type StoredServer } from "./store.js";
import { RuntimeAuth, type SyncStatus } from "./runtime-auth.js";
import { bindMainThread, findEligibleMainThread } from "./threads.js";
import { chatRpc } from "./chats.js";
import { RoleStore, materializeRole, removeRole } from "@agentstack/roles";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_GRACE_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const PORT_ATTEMPTS = 3;

export type ServerState = "running" | "stopped";

export type ServerView = {
  id: string;
  pid: number | null;
  cwd: string;
  url: string | null;
  state: ServerState;
  account: string | null;
  runningAccount: string | null;
  mainThreadId: string | null;
  recoveryIssue: string | null;
  roleRevision: number | null;
  settings: BotSettings | null;
};

type RecordFile = StoredServer;

export type StartInput = {
  cwd: string;
  id?: string;
  account?: string;
  args?: string[];
  settings?: Partial<BotSettings>;
};

export type LaunchSpec = {
  bin: string;
  args: string[];
  cwd: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
};

export type RunningChild = {
  pid: number;
  exited: Promise<number | null>;
  exitCode?: number | null;
  kill(signal: NodeJS.Signals): void;
};

export type SupervisorOptions = {
  stateDir: string;
  mcpServers?: (botId: string, endpoint: string) => Promise<Record<string, string>>;
  launch?: (spec: LaunchSpec) => RunningChild;
  waitReady?: (url: string, exited: Promise<number | null>, timeoutMs: number) => Promise<void>;
  endpoint?: (id: string) => Promise<string>;
  commandLine?: (pid: number) => Promise<string | null>;
  endpointOwner?: (pid: number, url: string) => Promise<boolean | null>;
  graceMs?: number;
  readyTimeoutMs?: number;
  bindThread?: typeof bindMainThread;
  findMainThread?: typeof findEligibleMainThread;
  onChange?: (id: string) => void;
  store?: StateStore;
};

export class Supervisor {
  onChange: ((id: string) => void) | undefined;
  private readonly records = new Map<string, RecordFile>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly children = new Map<string, RunningChild>();
  private readonly recoveryIssues = new Map<string, string>();
  private readonly launch: (spec: LaunchSpec) => RunningChild;
  private readonly waitReady: (url: string, exited: Promise<number | null>, timeoutMs: number) => Promise<void>;
  private readonly endpoint: (id: string) => Promise<string>;
  private readonly commandLine: (pid: number) => Promise<string | null>;
  private readonly endpointOwner: (pid: number, url: string) => Promise<boolean | null>;
  private readonly graceMs: number;
  private readonly readyTimeoutMs: number;
  private readonly bindThread: typeof bindMainThread;
  private readonly findMainThread: typeof findEligibleMainThread;
  readonly store: StateStore;
  readonly runtime: RuntimeAuth;
  readonly role: RoleStore;

  constructor(private readonly options: SupervisorOptions) {
    this.store = options.store ?? new StateStore(options.stateDir);
    this.runtime = new RuntimeAuth(this.store);
    this.role = new RoleStore(options.stateDir);
    this.launch = options.launch ?? launchChild;
    this.waitReady = options.waitReady ?? waitForReady;
    this.endpoint = options.endpoint ?? (() => unixEndpoint(options.stateDir));
    this.commandLine = options.commandLine ?? processCommandLine;
    this.endpointOwner = options.endpointOwner ?? processOwnsEndpoint;
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.bindThread = options.bindThread ?? bindMainThread;
    this.findMainThread = options.findMainThread ?? findEligibleMainThread;
    this.onChange = options.onChange;
  }

  async load(): Promise<void> {
    for (const record of this.store.servers()) this.records.set(record.id, record);
    // One-time import of the former JSON records, including children that need reaping.
    const names = await readdir(this.recordsDir()).catch(() => []);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.recordsDir(), name), "utf8")) as RecordFile;
        if (!parsed?.id || !ID_PATTERN.test(parsed.id)) continue;
        if (!this.store.hasServer(parsed.id)) {
          parsed.account ??= null;
          if (parsed.account) parsed.account = this.store.resolveLegacyAccount(parsed.account, true);
          // Legacy records could retain runtime credentials even after stopping.
          parsed.launchedAccount = parsed.account;
          parsed.authVersion ??= null;
          parsed.runtimeRoot ??= null;
          parsed.mainThreadId ??= null;
          parsed.threadStarting ??= false;
          parsed.args ??= [];
          if (!Array.isArray(parsed.args) || !parsed.args.every((arg) => typeof arg === "string")) throw new Error(`invalid launch arguments for Server ${parsed.id}`);
          this.store.saveServer(parsed);
          this.records.set(parsed.id, parsed);
        }
        await rm(join(this.recordsDir(), name));
      } catch {
        continue;
      }
    }
  }

  async reap(): Promise<void> {
    for (const record of this.records.values()) {
      if (record.state !== "running" || record.pid === null || record.url === null) continue;
      let owned: boolean;
      try { owned = await this.signalPid(record.pid, record.url); }
      catch (error) {
        this.noteRecoveryIssue(record.id, error);
        console.error(`cannot verify prior app-server ${record.id}: ${error}`);
        continue;
      }
      await this.finishRuntime(record);
      if (owned) await cleanupEndpoint(record.url);
      await this.releaseRole(record);
      this.markStopped(record);
      await this.persist(record);
      this.notify(record.id);
    }
    for (const record of this.records.values()) {
      if (record.state === "stopped" && record.runtimeRoot) await this.finishRuntime(record);
    }
  }

  async resumeAll(): Promise<void> {
    for (const record of this.records.values()) {
      try {
        await this.start({ id: record.id, cwd: record.cwd });
      } catch (error) {
        console.error(`failed to restart server ${record.id}: ${error}`);
      }
    }
  }

  list(): ServerView[] {
    return [...this.records.values()].map((record) => this.view(record));
  }

  start(input: StartInput): Promise<ServerView> {
    const id = input.id ?? newId();
    return this.enqueue(id, () => this.startQueued(id, input));
  }

  /** Claim the first materialized root thread created through this Server's Codex socket. */
  adoptMainThread(id: string, url: string): Promise<ServerView | null> {
    return this.enqueue(id, async () => {
      const record = this.records.get(id);
      if (!record || record.state !== "running" || record.url !== url || record.mainThreadId || record.threadStarting) return null;
      const threadId = await this.findMainThread(url);
      if (!threadId) return null;
      record.mainThreadId = threadId;
      try { await this.persist(record); }
      catch (error) { record.mainThreadId = null; throw error; }
      this.notify(id);
      return this.view(record);
    });
  }

  /** Create the first durable UI chat under the per-Bot lifecycle fence. */
  openMainChat(id: string, input: Record<string, unknown>[]): Promise<{ threadId: string; turn: Record<string, unknown> }> {
    return this.enqueue(id, async () => {
      const record = this.records.get(id);
      if (!record || record.state !== "running" || !record.url || !record.launchedAccount || this.recoveryIssues.has(id)) throw new Error("Bot is not a verified, account-bound running process");
      if (record.mainThreadId) throw new Error("Bot already has a main thread; use chat_send on it");
      const previous = await this.findMainThread(record.url);
      if (previous) {
        record.mainThreadId = previous;
        try { await this.persist(record); }
        catch (error) { record.mainThreadId = null; throw error; }
        this.notify(id);
        throw new Error("an existing durable root was adopted; read bot_list and use chat_send on it");
      }
      const started = await chatRpc(record.url, "thread/start", { cwd: record.cwd });
      const threadId = (started.thread as { id?: unknown } | undefined)?.id;
      if (typeof threadId !== "string") throw new Error("thread/start returned no thread ID; inspect Codex before retrying");
      // The first real turn, not thread/start, is the durable binding boundary.
      const sent = await chatRpc(record.url, "turn/start", { threadId, input });
      const turn = sent.turn;
      if (!turn || typeof turn !== "object" || typeof (turn as { id?: unknown }).id !== "string") throw new Error("turn/start returned no turn ID; inspect Codex before retrying");
      const oldest = await this.findMainThread(record.url);
      if (oldest !== threadId) throw new Error("first durable root selection changed; inspect bot_list and Codex history before sending again");
      record.mainThreadId = threadId;
      try { await this.persist(record); }
      catch (error) { record.mainThreadId = null; throw error; }
      this.notify(id);
      return { threadId, turn: turn as Record<string, unknown> };
    });
  }

  assign(id: string, accountId: string): Promise<ServerView> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
    return this.enqueue(id, async () => {
      const record = this.records.get(id);
      if (!record) throw new Error(`unknown server: ${id}`);
      if (!this.store.codexAccounts().some((account) => account.id === accountId && account.enabled && !account.removing)) {
        throw new Error(`unknown Codex account: ${accountId}`);
      }
      if (record.account === accountId) return this.view(record);
      const previous = record.account;
      record.account = accountId;
      try { await this.persist(record); }
      catch (error) { record.account = previous; throw error; }
      this.notify(id);
      return this.view(record);
    });
  }

  stop(id: string): Promise<ServerView> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
    return this.enqueue(id, () => this.stopQueued(id));
  }

  remove(id: string): Promise<{ id: string }> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
    return this.enqueue(id, async () => {
      const record = this.records.get(id);
      if (!record) return { id };
      if (record.state === "running") await this.stopQueued(id);
      await this.runtime.finish(record).catch((error) => console.error(`Codex auth cleanup for removed server ${id}: ${error}`));
      await rm(this.runtime.rootFor(id), { recursive: true, force: true });
      await rm(join(this.options.stateDir, "runtime-recovery", id), { recursive: true, force: true });
      await rm(join(this.options.stateDir, "logs", `${id}.log`), { force: true });
      // Legacy shared history cannot be attributed safely to one account.
      await rm(join(this.options.stateDir, "history", id), { recursive: true, force: true });
      await this.releaseRole(record, true);
      this.store.deleteServer(id);
      this.records.delete(id);
      this.recoveryIssues.delete(id);
      this.notify(id);
      return { id };
    });
  }

  async stopAll(): Promise<void> {
    const running = [...this.records.values()].filter((record) => record.state === "running");
    await Promise.all(running.map((record) => this.stop(record.id)));
  }

  private async startQueued(id: string, input: StartInput): Promise<ServerView> {
    if (!ID_PATTERN.test(id)) throw new Error(`invalid id: ${id}`);
    const cwd = await existingDirectory(input.cwd);
    const codexBin = codexRuntimePath();
    const current = this.records.get(id);
    const userArgs = input.args ?? current?.args ?? [];
    validateAppServerArgs(userArgs);
    const settings = input.settings === undefined
      ? current ? current.settings ?? null : this.store.botDefaults()
      : { ...(current?.settings ?? this.store.botDefaults()), ...input.settings };
    if (current && current.cwd !== cwd) throw new Error(`server ${id} is bound to ${current.cwd}, not ${cwd}`);
    let live = false;
    if (current) {
      try { live = await this.isRunning(current); }
      catch (error) { this.noteRecoveryIssue(id, error); throw error; }
    }
    if (current && live) {
      if (current.codexBin !== codexBin) {
        throw new Error(`server ${id} uses a different Codex runtime; stop it before starting it with codexnk`);
      }
      if (input.args !== undefined && !sameArgs(input.args, current.args)) {
        throw new Error(`server ${id} is running with different launch arguments; stop it before changing args`);
      }
      if (input.settings !== undefined && !sameSettings(settings!, current.settings)) {
        throw new Error(`server ${id} is running with different settings; stop it before changing settings`);
      }
      if (current.launchedAccount !== current.account) {
        throw new Error(`server ${id} is running with a different Codex account; stop it before the assigned account is used`);
      }
      return this.view(current);
    }
    if (current?.threadStarting && !current.mainThreadId) {
      throw new Error(`server ${id} has an unconfirmed thread/start; inspect its Codex history before retrying to avoid a second main thread`);
    }
    if (current?.runtimeRoot) {
      const status = await this.finishRuntime(current);
      if (current.runtimeRoot && status) await this.runtime.retireSuperseded(current, status);
      if (current.runtimeRoot) throw new Error(`server ${id} has unreconciled Codex credentials; inspect its private runtime`);
    }
    if (current?.roleRoot) await this.releaseRole(current, true);
    if (current && input.account !== undefined && current.account !== input.account)
      throw new Error(`server ${id} is assigned to a different Codex account; use bot_assign first`);
    const selected = current ? current.account : input.account ?? null;
    if (selected && !this.store.codexAccounts().some((account) => account.id === selected && account.enabled && !account.removing))
      throw new Error(`Codex account ${selected} is unavailable or disabled`);
    if (selected) {
      for (const record of this.records.values()) {
        if (record.launchedAccount === selected && record.runtimeRoot) {
          if (record.state === "stopped") await this.finishRuntime(record);
          else await this.runtime.reconcile(record);
        }
      }
    }
    // Reconciliation above may advance the saved credential generation.
    const account = selected ? this.store.accountCredentials(selected) : null;
    const snapshot = this.role.snapshot();
    const privateHistory = join(this.options.stateDir, "history", id);
    const history = current?.mainThreadId && !existsSync(privateHistory) ? join(this.options.stateDir, "history") : privateHistory;
    await mkdir(history, { recursive: true, mode: 0o700 });

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const url = await this.endpoint(id);
      await prepareEndpoint(url);
      const logPath = join(this.options.stateDir, "logs", `${id}.log`);
      await mkdir(join(this.options.stateDir, "logs"), { recursive: true, mode: 0o700 });
      const runtimeRoot = await this.runtime.prepare(id);
      const identity = await mkdtemp(join(this.options.stateDir, ".identity-"));
      let rolePath: string | undefined;
      let child: RunningChild;
      try {
        const mcpServers = await this.options.mcpServers?.(id, url) ?? {};
        rolePath = await materializeRole(this.options.stateDir, id, snapshot, mcpServers, cwd);
        if (account) await writeFile(join(identity, "auth.json"), account.auth, { mode: 0o600 });
        const env = { ...process.env };
        for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL", "CODEX_HOME", "AGENTUSAGE_AUTH_TOKEN", "AGENTUSAGE_ACCOUNT"]) delete env[key];
        env.TMPDIR = runtimeRoot;
        child = this.launch({
          bin: codexBin,
          args: [...appServerArgs(userArgs, url, settings), "--enable", "realtime_conversation", "--identity", identity, "--capabilities", rolePath, "--history-dir", history],
          cwd,
          logPath,
          env,
        });
      } catch (error) {
        await rm(identity, { recursive: true, force: true });
        await rm(runtimeRoot, { recursive: true, force: true });
        if (rolePath) await removeRole(this.options.stateDir, id, rolePath);
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      this.children.set(id, child);
      const record: RecordFile = {
        id, pid: child.pid, cwd, url, state: "running", codexBin, account: account?.id ?? null, launchedAccount: account?.id ?? null, authVersion: account?.version ?? null, runtimeRoot,
        mainThreadId: current?.mainThreadId ?? null, threadStarting: current?.threadStarting ?? false, args: [...userArgs], settings,
        roleRoot: rolePath, roleRevision: snapshot.revision,
      };
      this.records.set(id, record);
      this.watchExit(id, child, record);
      let persisted = false;
      let ready = false;
      try {
        await this.persist(record);
        persisted = true;
        await this.waitReady(url, child.exited, this.readyTimeoutMs);
        ready = true;
        // A fresh Server owns the socket, but the first UI owns thread/start.
        // Only a previously adopted main thread needs to be resumed here.
        if (record.mainThreadId) await this.bindThread(url, cwd, record.mainThreadId);
        await rm(identity, { recursive: true, force: true });
        await this.runtime.watch(record);
        this.recoveryIssues.delete(id);
        this.notify(id);
        return this.view(record);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.killChild(id, child);
        await this.finishRuntime(record);
        await rm(identity, { recursive: true, force: true });
        await cleanupEndpoint(url);
        await this.releaseRole(record);
        this.markStopped(record);
        await this.persist(record).catch(() => undefined);
        this.notify(id);
        if (!persisted) throw lastError;
        if (record.runtimeRoot) throw lastError;
        if (ready) throw lastError;
      }
    }
    throw lastError ?? new Error("failed to start app-server");
  }

  private async stopQueued(id: string): Promise<ServerView> {
    const record = this.records.get(id);
    if (!record) throw new Error(`unknown server: ${id}`);
    if (record.state === "stopped") return this.view(record);
    const child = this.children.get(id);
    let owned = false;
    try {
      if (child) {
        await this.killChild(id, child);
        owned = true;
      } else if (record.pid !== null && record.url !== null) {
        owned = await this.signalPid(record.pid, record.url);
      }
    } catch (error) {
      this.noteRecoveryIssue(id, error);
      throw error;
    }
    await this.finishRuntime(record);
    if (owned && record.url) await cleanupEndpoint(record.url);
    await this.releaseRole(record);
    this.markStopped(record);
    await this.persist(record);
    this.notify(id);
    return this.view(record);
  }

  private async isRunning(record: RecordFile): Promise<boolean> {
    if (record.state !== "running" || record.pid === null || record.url === null) return false;
    const child = this.children.get(record.id);
    if (child) return child.exitCode === undefined;
    return this.ownsProcess(record.pid, record.url);
  }

  private watchExit(id: string, child: RunningChild, record: RecordFile): void {
    void child.exited.then(() => {
      void this.enqueue(id, async () => {
        if (this.children.get(id) !== child || this.records.get(id) !== record) return;
        this.children.delete(id);
        await this.finishRuntime(record);
        if (record.url) await cleanupEndpoint(record.url);
        await this.releaseRole(record);
        this.markStopped(record);
        await this.persist(record);
        this.notify(id);
      }).catch((error) => console.error(`failed to record app-server exit: ${error}`));
    });
  }

  private async ownsProcess(pid: number, url: string): Promise<boolean> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid recorded app-server PID: ${pid}`);
    const [command, endpointOwner] = await Promise.all([this.commandLine(pid), this.endpointOwner(pid, url)]);
    const commandMatches = command !== null && isOurChild(command, url);
    if (commandMatches && endpointOwner === true) return true;
    if (!processAlive(pid) || (command !== null && !commandMatches && endpointOwner === false)) return false;
    throw new Error(`process ${pid} and its listening endpoint could not both be verified`);
  }

  private async signalPid(pid: number, url: string): Promise<boolean> {
    if (!(await this.ownsProcess(pid, url))) return false;
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return true;
    }
    const deadline = Date.now() + this.graceMs;
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // A reused PID or a process that released its socket must never be killed.
    if (!(await this.ownsProcess(pid, url))) return true;
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      return true;
    }
    const forceDeadline = Date.now() + 1_000;
    while (Date.now() < forceDeadline) {
      if (!processAlive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (await this.ownsProcess(pid, url)) throw new Error(`app-server process ${pid} did not exit after SIGKILL`);
    return true;
  }

  private markStopped(record: RecordFile): void {
    record.state = "stopped";
    record.pid = null;
    record.url = null;
    this.recoveryIssues.delete(record.id);
  }

  private async releaseRole(record: RecordFile, required = false): Promise<void> {
    if (!record.roleRoot) return;
    try {
      await removeRole(this.options.stateDir, record.id, record.roleRoot);
      record.roleRoot = null;
    } catch (error) {
      if (required) throw error;
      console.error(`role snapshot cleanup for ${record.id} failed: ${error}`);
    }
  }

  private view(record: RecordFile): ServerView {
    return viewOf(record, this.recoveryIssues.get(record.id) ?? null);
  }

  private noteRecoveryIssue(id: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message = detail.includes("did not exit after SIGKILL")
      ? "Recorded process did not exit after SIGKILL. Inspect its PID and endpoint before retrying."
      : "Recorded process ownership could not be verified. Inspect its PID and endpoint before retrying.";
    if (this.recoveryIssues.get(id) === message) return;
    this.recoveryIssues.set(id, message);
    this.notify(id);
  }

  private notify(id: string): void {
    this.onChange?.(id);
  }

  private async killChild(id: string, child: RunningChild): Promise<void> {
    const finished = child.exited.then(() => undefined, () => undefined);
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already exited.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.graceMs);
    });
    const outcome = await Promise.race([finished.then(() => "exited" as const), timedOut]);
    if (timer) clearTimeout(timer);
    if (outcome === "timeout") {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child exited during the grace window.
      }
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          finished,
          new Promise<never>((_resolve, reject) => {
            forceTimer = setTimeout(() => reject(new Error(`app-server ${id} did not exit after SIGKILL`)), 1_000);
          }),
        ]);
      } finally {
        if (forceTimer) clearTimeout(forceTimer);
      }
    }
    this.children.delete(id);
  }

  private enqueue<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    this.queues.set(id, run.then(() => undefined, () => undefined));
    return run;
  }

  private recordsDir(): string {
    return join(this.options.stateDir, "servers");
  }

  private async persist(record: RecordFile): Promise<void> {
    this.store.saveServer(record);
  }

  private async finishRuntime(record: RecordFile): Promise<SyncStatus | null> {
    try { return await this.runtime.finish(record); }
    catch (error) { console.error(`Codex auth reconciliation for ${record.id} failed: ${error}`); return null; }
  }
}

export function appServerArgs(userArgs: readonly string[], url: string, settings: BotSettings | null = DEFAULT_BOT_SETTINGS): string[] {
  validateAppServerArgs(userArgs);
  const args = [...userArgs];
  const appServerAt = args.indexOf("app-server");
  if (appServerAt !== -1) args.splice(appServerAt, 1);
  // Codex applies later arguments last; saved caller args can override these settings.
  return ["app-server", "--listen", url,
    ...(settings ? ["-c", `model=${JSON.stringify(settings.model)}`, "-c", `model_reasoning_effort="${settings.reasoningEffort}"`] : []),
    "-c", `sandbox_mode="${settings?.sandboxMode ?? DEFAULT_BOT_SETTINGS.sandboxMode}"`,
    "-c", `approval_policy="${settings?.approvalPolicy ?? DEFAULT_BOT_SETTINGS.approvalPolicy}"`,
    ...args];
}

function validateAppServerArgs(userArgs: readonly string[]): void {
  for (const [index, arg] of userArgs.entries()) {
    if (["--listen", "--identity", "--capabilities", "--history-dir"].some((flag) => arg === flag || arg.startsWith(`${flag}=`))) {
      throw new Error("do not pass --listen, --identity, --capabilities, or --history-dir; agentstack owns these axes");
    }
    const override = arg === "-c" || arg === "--config" ? userArgs[index + 1]
      : arg.startsWith("--config=") ? arg.slice("--config=".length)
      : arg.startsWith("-c") && arg.length > 2 ? arg.slice(2) : undefined;
    const key = override?.split("=", 1)[0]?.trim();
    if (key === "developer_instructions" || key === "mcp_servers" || key?.startsWith("mcp_servers.")) {
      throw new Error("developer_instructions and mcp_servers are managed by the role");
    }
  }
}

function sameArgs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((arg, index) => arg === right[index]);
}

function sameSettings(left: BotSettings, right: BotSettings | null | undefined): boolean {
  return right !== null && right !== undefined && left.model === right.model && left.reasoningEffort === right.reasoningEffort
    && left.sandboxMode === right.sandboxMode && left.approvalPolicy === right.approvalPolicy;
}

async function unixEndpoint(stateDir: string): Promise<string> {
  const directory = join(stateDir, "app");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { chmod } = await import("node:fs/promises");
  await chmod(directory, 0o700);
  return `unix://${join(directory, `${randomBytes(7).toString("hex")}.sock`)}`;
}

function endpointPath(url: string): string | null {
  return url.startsWith("unix://") ? url.slice("unix://".length) : null;
}

async function prepareEndpoint(url: string): Promise<void> {
  const path = endpointPath(url);
  if (!path) return;
  if (await lstat(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error(`app-server socket path already exists at ${path}; inspect it before removal`);
}

async function cleanupEndpoint(url: string): Promise<void> {
  const path = endpointPath(url);
  if (path && (await unixSocketListening(path)) === false) await rm(path, { force: true });
}

function unixSocketListening(path: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? false : null);
    });
  });
}

function viewOf(record: RecordFile, recoveryIssue: string | null): ServerView {
  return {
    id: record.id,
    pid: record.pid,
    cwd: record.cwd,
    url: record.url,
    state: record.state,
    account: record.account,
    runningAccount: record.state === "running" ? record.launchedAccount : null,
    mainThreadId: record.mainThreadId ?? null,
    recoveryIssue,
    roleRevision: record.roleRevision ?? null,
    settings: record.settings ?? null,
  };
}

function newId(): string {
  return `s${randomBytes(8).toString("hex")}`;
}

async function existingDirectory(cwd: string): Promise<string> {
  const { stat } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const absolute = resolve(cwd);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    throw new Error(`cwd does not exist: ${absolute}`);
  }
  if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${absolute}`);
  return absolute;
}

function isOurChild(command: string, url: string): boolean {
  if (!/(?:^|\s)app-server(?:\s|$)/.test(command)) return false;
  const marker = `--listen ${url}`;
  let at = command.indexOf(marker);
  while (at !== -1) {
    if ((at === 0 || /\s/.test(command[at - 1]!)) && (at + marker.length === command.length || /\s/.test(command[at + marker.length]!))) return true;
    at = command.indexOf(marker, at + 1);
  }
  return false;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export function launchChild(spec: LaunchSpec): RunningChild {
  try {
    accessSync(spec.bin, constants.X_OK);
  } catch {
    throw new Error(`required codexnk runtime is missing or not executable at ${spec.bin}; run ~/code/agentstart/scripts/install.sh --install`);
  }
  const log = createWriteStream(spec.logPath, { flags: "a" });
  log.on("error", (error) => console.error(`app-server log: ${error.message}`));
  let child: ChildProcess;
  try {
    child = spawn(spec.bin, spec.args, {
      cwd: spec.cwd,
      detached: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: spec.env,
    });
  } catch (error) {
    log.end();
    throw error;
  }
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  let resolveExit: (code: number | null) => void = () => undefined;
  const exited = new Promise<number | null>((resolve) => {
    resolveExit = resolve;
  });
  let running: RunningChild | undefined;
  child.once("error", () => {
    if (running && running.exitCode === undefined) running.exitCode = null;
    resolveExit(null);
    log.end();
  });
  child.once("close", () => log.end());
  if (child.pid === undefined) throw new Error(`failed to spawn ${spec.bin}`);
  running = {
    pid: child.pid,
    exited,
    kill(signal) {
      child.kill(signal);
    },
  };
  child.once("exit", (code) => {
    if (running) running.exitCode = code;
    resolveExit(code);
  });
  return running;
}

export async function waitForReady(url: string, exited: Promise<number | null>, timeoutMs: number): Promise<void> {
  const path = endpointPath(url);
  const port = path ? null : new URL(url).port;
  const deadline = Date.now() + timeoutMs;
  let exitCode: number | null | undefined;
  void exited.then((code) => {
    exitCode = code;
  });
  while (Date.now() < deadline) {
    if (exitCode !== undefined) throw new Error(`app-server exited before ready (${exitCode ?? "spawn error"})`);
    try {
      const remaining = Math.max(1, deadline - Date.now());
      if (path) {
        await new Promise<void>((resolve, reject) => {
          const socket = connect({ path, signal: AbortSignal.timeout(remaining) });
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
          socket.once("error", reject);
        });
        return;
      }
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(remaining) });
      if (response.ok) return;
    } catch {
      // The listener is not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`app-server was not ready at ${url}`);
}

export function processCommandLine(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("ps", ["-p", String(pid), "-ww", "-o", "command="], (error, stdout) => {
      if (error) resolve(null);
      else resolve(stdout.trim() || null);
    });
  });
}

/** Verify a recorded PID still owns its exact listening endpoint. Null means inspection failed. */
export function processOwnsEndpoint(pid: number, url: string): Promise<boolean | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  const path = endpointPath(url);
  let args: string[];
  let names: string[];
  if (path) {
    args = ["-nP", "-a", "-p", String(pid), "-U", "-F0pn"];
    names = [path];
  } else {
    let address: URL;
    try { address = new URL(url); } catch { return Promise.resolve(null); }
    const port = Number(address.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) return Promise.resolve(null);
    args = ["-nP", "-a", "-p", String(pid), `-iTCP:${port}`, "-sTCP:LISTEN", "-F0pn"];
    names = [`127.0.0.1:${port}`, `[::1]:${port}`];
  }
  return new Promise((resolve) => {
    execFile(process.platform === "darwin" ? "/usr/sbin/lsof" : "lsof", args, { maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      const code = (error as { code?: number | string } | null)?.code;
      if (error && ((code !== 1 && code !== "1") || stderr.trim())) {
        resolve(null);
        return;
      }
      const fields = stdout.split("\0");
      resolve(fields.includes(`p${pid}`) && fields.some((field) => field.startsWith("n") && names.includes(field.slice(1))));
    });
  });
}
