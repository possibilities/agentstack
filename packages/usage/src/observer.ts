import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { socketCall, socketPath, socketSubscribe, type SocketSubscription } from "@agentstack/api";
import { accountSignIn, collectAccount, collectGrokBot, ObservationFailure, type SignIn } from "./collect.js";
import { observationError, snapshotSchema, type AccountScope, type Provider, type Snapshot, type StoredMeasurement, type Subscription } from "./schema.js";

export type Registered = { id: string; scope: AccountScope; provider: Provider; enabled: boolean; ready: boolean; removing: boolean };
type FetchAccount = (id: string, provider: Provider, scope: AccountScope) => Promise<StoredMeasurement["usage"]>;
type FetchBot = () => Promise<Snapshot["grokBot"]["usage"]>;
type LoadAccounts = () => Promise<Registered[]>;
type WatchAccounts = (onChange: () => void) => Promise<SocketSubscription>;
type Row = { id: string; scope: AccountScope; provider: Provider; enabled: boolean; ready: boolean; measurement: StoredMeasurement; nextAttemptAtMs: number };
type Persisted = { schemaVersion: number; accounts: Array<Omit<Row, "scope"> & { scope?: AccountScope }>; bot: StoredMeasurement };
const keyOf = ({ scope, id }: { scope: AccountScope; id: string }) => `${scope}:${id}`;

const empty = (): StoredMeasurement => ({ observedAtMs: null, lastAttemptAtMs: null, error: null, usage: null });
const fresh = (measurement: StoredMeasurement, now: number) => measurement.error === null && measurement.usage !== null &&
  measurement.observedAtMs !== null && now - measurement.observedAtMs >= -1000 && now - measurement.observedAtMs <= 300_000;
const errorCode = (error: unknown) => error instanceof ObservationFailure && observationError.safeParse(error.code).success
  ? observationError.parse(error.code) : "observation_failed";
const intervalMs = 180_000;

export class UsageObserver {
  private rows = new Map<string, Row>();
  private identities = new Map<string, string>();
  private subscriptions = new Map<string, NonNullable<Subscription>>();
  private bot: StoredMeasurement = empty();
  private botNextAttemptAtMs = 0;
  private inventoryAtMs: number | null = null;
  private inventoryError: Snapshot["inventoryError"] = "not_observed";
  private controller = new AbortController();
  private loop: Promise<void> | null = null;
  private lastPublished = "";
  private stale = false;
  private wake: (() => void) | null = null;
  private watch: SocketSubscription | undefined;
  onChange?: () => void;

  constructor(readonly stateDir: string, private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly accounts: LoadAccounts = async () => {
      const [bot, workers] = await Promise.all([
        socketCall(socketPath("auth", env), "tools/call", { name: "account_list", arguments: {} }, { timeoutMs: 5_000 }) as Promise<{ accounts: Array<{ id: string; enabled: boolean; removing: boolean }> }>,
        socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_list", arguments: {} }, { timeoutMs: 5_000 }) as Promise<{ accounts: Array<Omit<Registered, "scope">> }>,
      ]);
      return [...bot.accounts.map((account): Registered => ({ ...account, scope: "bot", provider: "codex", ready: true })),
        ...workers.accounts.map((account): Registered => ({ ...account, scope: "worker" }))];
    },
    private readonly fetchAccount: FetchAccount = (id, provider, scope) => collectAccount(stateDir, id, provider, fetch, this.controller.signal, scope),
    private readonly fetchBot: FetchBot = () => collectGrokBot(env.AGENTSTACK_AGENTGROK_BIN, this.controller.signal),
    private readonly signIn: (id: string, provider: Provider, scope: AccountScope) => Promise<SignIn | null> =
      (id, provider, scope) => accountSignIn(stateDir, id, provider, scope),
    private readonly watchAccounts: WatchAccounts = (onChange) =>
      socketSubscribe(socketPath("auth", env), ["accounts_changed", "worker_accounts_changed"], onChange),
  ) {}

  private get path() { return join(this.stateDir, "usage", "observations.json"); }

  /** A sidecar of public measurements only; invalid persisted data is not trusted. */
  async load(): Promise<void> {
    let handle;
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch { return; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 1024 * 1024) return;
      const value = JSON.parse(await handle.readFile("utf8")) as Persisted;
      if (![1, 2, 3].includes(value.schemaVersion) || !Array.isArray(value.accounts) || value.accounts.length > 128) return;
      for (const row of value.accounts) {
        const scope = value.schemaVersion === 1 ? row.provider === "codex" ? "bot" : "worker" : row.scope;
        const measurement = value.schemaVersion < 3 && row.provider === "grok" && row.measurement?.usage
          ? { ...row.measurement, usage: { ...row.measurement.usage,
            included: { ...("included" in row.measurement.usage ? row.measurement.usage.included : {}), allocatedUsd: null } } } : row.measurement;
        const candidate = snapshotSchema.shape.accounts.element.safeParse({ ...measurement,
          id: row.id, scope, provider: row.provider, enabled: row.enabled, ready: row.ready, linkedAccounts: [], subscription: null, fresh: false });
        if (candidate.success && Number.isSafeInteger(row.nextAttemptAtMs)) this.rows.set(keyOf(candidate.data), {
          id: candidate.data.id, scope: candidate.data.scope, provider: candidate.data.provider,
          enabled: candidate.data.enabled, ready: candidate.data.ready,
          measurement: { observedAtMs: candidate.data.observedAtMs, lastAttemptAtMs: candidate.data.lastAttemptAtMs,
            error: candidate.data.error, usage: candidate.data.usage }, nextAttemptAtMs: row.nextAttemptAtMs,
        });
      }
      const bot = snapshotSchema.shape.grokBot.safeParse({ ...value.bot, fresh: false });
      if (bot.success) this.bot = { observedAtMs: bot.data.observedAtMs, lastAttemptAtMs: bot.data.lastAttemptAtMs,
        error: bot.data.error, usage: bot.data.usage };
    } catch { /* malformed persisted state is not evidence */ }
    finally { await handle.close(); }
  }

  snapshot(now = Date.now()): Snapshot {
    const accounts = [...this.rows.values()].map(({ id, scope, provider, enabled, ready, measurement }) => ({
      id, scope, provider, enabled, ready,
      linkedAccounts: provider !== "codex" || !this.identities.has(keyOf({ id, scope })) ? [] :
        [...this.rows.values()].filter((other) => other.provider === "codex" && other.scope !== scope &&
          this.identities.get(keyOf(other)) === this.identities.get(keyOf({ id, scope })))
          .map((other) => ({ id: other.id, scope: other.scope })),
      subscription: this.subscription({ id, scope, provider, measurement }),
      ...measurement, fresh: this.inventoryError === null &&
        ready && fresh(measurement, now),
    })) as Snapshot["accounts"];
    return { atMs: now, inventoryAtMs: this.inventoryAtMs, inventoryError: this.inventoryError,
      accounts, grokBot: { ...this.bot, fresh: fresh(this.bot, now), usage: this.bot.usage as Snapshot["grokBot"]["usage"] } };
  }

  /** A Devin plan period is part of its measurement; a Codex sign-in claim is re-read each cycle and never persisted. */
  private subscription({ id, scope, provider, measurement }: Pick<Row, "id" | "scope" | "provider" | "measurement">): Subscription {
    if (provider === "devin") {
      const usage = measurement.usage as { periodEnd?: string | null } | null;
      return usage?.periodEnd ? { endsAt: usage.periodEnd, source: "plan_period", checkedAtMs: measurement.observedAtMs } : null;
    }
    return this.subscriptions.get(keyOf({ id, scope })) ?? null;
  }

  private async save(): Promise<void> {
    const dir = join(this.stateDir, "usage");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    const temp = join(dir, `observations.${process.pid}.${crypto.randomUUID()}.tmp`);
    try {
      const value: Persisted = { schemaVersion: 3, accounts: [...this.rows.values()], bot: this.bot };
      await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
      await rename(temp, this.path);
    } finally {
      await rm(temp, { force: true });
    }
  }

  async cycle(now = Date.now()): Promise<void> {
    let inventory: Registered[];
    try {
      inventory = await this.accounts();
      this.inventoryAtMs = now;
      this.inventoryError = null;
    } catch {
      this.inventoryError = "auth_unavailable";
      this.identities.clear();
      this.subscriptions.clear();
      this.changed();
      return;
    }
    const wanted = new Set(inventory.filter((row) => !row.removing).map(keyOf));
    const before = this.rows.size;
    for (const id of this.rows.keys()) if (!wanted.has(id)) this.rows.delete(id);
    // Publish a removal before this cycle's slower observations.
    if (this.rows.size < before) this.changed();
    this.identities.clear();
    this.subscriptions.clear();
    for (const account of inventory) {
      if (this.controller.signal.aborted) break;
      if (account.removing) continue;
      const key = keyOf(account);
      const previous = this.rows.get(key);
      const row: Row = previous?.provider === account.provider ? { ...previous, enabled: account.enabled, ready: account.ready,
        nextAttemptAtMs: previous.ready === account.ready ? previous.nextAttemptAtMs : 0 } : {
        id: account.id, scope: account.scope, provider: account.provider, enabled: account.enabled, ready: account.ready,
        measurement: empty(), nextAttemptAtMs: 0,
      };
      this.rows.set(key, row);
      if (account.provider === "codex" && account.ready) {
        const signIn = await this.signIn(row.id, row.provider, row.scope).catch(() => null);
        if (signIn?.identity) this.identities.set(key, signIn.identity);
        if (signIn?.subscription) this.subscriptions.set(key, signIn.subscription);
      }
      // Disabled accounts still have usage. Readiness only fences an unfinished native sign-in.
      if (!account.ready || now < row.nextAttemptAtMs) continue;
      try {
        const usage = await this.fetchAccount(row.id, row.provider, row.scope);
        row.measurement = { usage, observedAtMs: Date.now(), lastAttemptAtMs: Date.now(), error: null };
        row.nextAttemptAtMs = Date.now() + intervalMs;
      } catch (error) {
        row.measurement = { ...row.measurement, lastAttemptAtMs: Date.now(), error: errorCode(error) };
        row.nextAttemptAtMs = Date.now() + (row.measurement.error === "rate_limited" ? 900_000 : 300_000);
      }
    }
    if (!this.controller.signal.aborted && now >= this.botNextAttemptAtMs) {
      try {
        const usage = await this.fetchBot();
        this.bot = { usage, observedAtMs: Date.now(), lastAttemptAtMs: Date.now(), error: null };
        this.botNextAttemptAtMs = Date.now() + intervalMs;
      } catch (error) {
        this.bot = { ...this.bot, lastAttemptAtMs: Date.now(), error: errorCode(error) };
        this.botNextAttemptAtMs = Date.now() + 300_000;
      }
    }
    if (!this.controller.signal.aborted) await this.save();
    this.changed();
  }

  private changed(): void {
    const { atMs: _at, inventoryAtMs: _inventoryAt, ...state } = this.snapshot();
    const key = JSON.stringify(state);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.onChange?.();
  }

  /** Re-read the account inventory now; an account change arriving mid-cycle runs one more cycle. Due observations still wait for their schedule. */
  invalidate(): void {
    this.stale = true;
    this.wake?.();
  }

  private async connect(): Promise<void> {
    if (this.controller.signal.aborted) return;
    try {
      this.watch = await this.watchAccounts(() => this.invalidate());
      if (this.controller.signal.aborted) { await this.watch.close(); return; }
      // Changes made while disconnected are unseen; re-read once subscribed.
      this.invalidate();
      void this.watch.closed.then(() => { this.watch = undefined; this.reconnect(); });
    } catch { this.reconnect(); }
  }

  private reconnect(): void {
    if (!this.controller.signal.aborted) setTimeout(() => void this.connect(), 2_000).unref();
  }

  start(): void {
    if (this.loop) return;
    void this.connect();
    this.loop = (async () => {
      while (!this.controller.signal.aborted) {
        this.stale = false;
        await this.cycle().catch(() => undefined);
        if (this.controller.signal.aborted) break;
        if (this.stale) continue;
        const delay = this.inventoryError ? 2_000 : intervalMs + Math.random() * 30_000;
        await new Promise<void>((resolve) => {
          const signal = this.controller.signal;
          const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); this.wake = null; resolve(); };
          const timer = setTimeout(finish, delay);
          this.wake = finish;
          signal.addEventListener("abort", finish, { once: true });
        });
      }
    })();
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.watch?.close();
    await this.loop;
  }
}
