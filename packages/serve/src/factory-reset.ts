import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { StateJournal, assertInstallationOpen, clearStateFiles, installationControlRoot, readInstallationFence, snapshotStateFiles, stateApplyInput, stateDir, stateHash, stateReceipt, type StateOutcome } from "@stack/api";
import { observeAuthFactoryReset } from "@stack/auth";
import { observeWorkerFactoryReset } from "@stack/worker";
import type { BrowserResetSnapshot } from "@stack/browse";

export type FactorySelection = { serverId: string; auth: ReturnType<typeof observeAuthFactoryReset>; worker: Awaited<ReturnType<typeof observeWorkerFactoryReset>>;
  browser: BrowserResetSnapshot; roleBlockers: string[] };
export type FactoryResetHooks = {
  inspect(): Promise<FactorySelection>;
  quiesce(): Promise<void>;
  cleanup(selection: FactorySelection, requestId: string, progress: (outcome: StateOutcome) => void): Promise<void>;
  finish(failed: boolean): void;
};
type Saved = { selection: FactorySelection; identity: string; generation: string };
export const factoryResetApply = stateApplyInput.extend({ confirmation: z.literal("factory-reset"), externalWritersQuiesced: z.literal(true) });
export const factoryResetRelease = z.strictObject({ requestId: z.uuid(), expectedGeneration: z.uuid() });
const retained = ["Independent Client host, devices/Canvas storage, personal logins/keychains, external TLS/Tailscale/service configuration, binaries, remote/back-up copies remain",
  "Source Git repositories, Worker branches/commits/retained refs and old Content Vault/Git remain (Vault relocated to a disclosed sibling retention directory)",
  "Content-free sibling factory-control receipts, request/digest/generation tombstones and startup fence survive; no secure media/backup erasure is implied",
  "Unattributed external provider resources and Role shim files remain unconfirmed; pairing and stale destination-bound shares never retarget"];
const directories = new Set(["access", "app", "attention", "auth", "bots", "brain", "browser", "chat-uploads", "history", "history-generations", "hud", "infer", "local-auth", "logs", "notify", "proc", "roles", "runtime", "runtime-recovery", "scrape", "serve", "settings", "sockets", "usage", "wiki", "worker-accounts", "workers", "xcom"]);
const files = /^(configuration|secrets|chats|workers|roles|settings|event-subscriptions|auth-cache-maintenance)\.sqlite(?:-(?:wal|shm|journal))?$|^mcp-(?:bot|worker)-identity\.key$/;
function rootObservation(env: NodeJS.ProcessEnv) {
  const root = resolve(stateDir(env)), stat = lstatSync(root);
  if (root === dirname(root) || realpathSync(root) === realpathSync(homedir()) || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || existsSync(join(root, ".git"))) throw new Error("Factory reset requires an exact private owned installation directory, never a home/source checkout/symlink");
  const blockedBy: string[] = [];
  const names = readdirSync(root).sort();
  for (const name of names) {
    const info = lstatSync(join(root, name));
    if (!(info.isDirectory() && (directories.has(name) || /^inspector-[A-Za-z0-9-]+$/.test(name))) && !(info.isFile() && files.test(name))) blockedBy.push(`Unknown/unsafe installation-root entry ${name}; no blanket adoption`);
  }
  // Hypeman is a provider authority, not a Browser ledger cache. Its raw store
  // may contain foreign/orphaned disks that resource-ID deletion cannot prove.
  // Existing explicit owner uninstall must resolve this before factory reset;
  // never sweep its files just because they sit below STACK_STATE_DIR.
  if (names.includes("browser")) {
    const browser = join(root, "browser"), info = lstatSync(browser);
    if (info.isDirectory() && !info.isSymbolicLink() && readdirSync(browser).some(name => name === "hypeman" || name.startsWith("hypeman-staging-"))) blockedBy.push("In-root Hypeman provider storage is not adopted for blanket deletion; resolve/uninstall through Browse before factory reset, or keep the selected provider outside the installation");
  }
  for (const key of ["STACK_ACCESS_TLS_CERT", "STACK_ACCESS_TLS_KEY", "STACK_CLIENT_STATE_DIR"]) if (env[key]) {
    const configured = resolve(env[key]!), path = existsSync(configured) ? realpathSync(configured) : configured, within = relative(realpathSync(root), path);
    if (!within.startsWith("..") && !within.startsWith("/")) blockedBy.push(`${key} must be outside the erased installation; independent configuration is retained`);
  }
  return { root, identity: stateHash([realpathSync(root), stat.dev, stat.ino, stat.mode, stat.uid, stat.birthtimeMs]), names, blockedBy };
}
function durableFence(path: string, value: object) {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(dirname(path), "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
}
function writerAbsent(pid: number) {
  try { process.kill(pid, 0); throw new Error("Reset writer is alive or PID reused; cold recovery cannot change its receipt/fence"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function controlDatabase(env: NodeJS.ProcessEnv) {
  readInstallationFence(env);
  const path = join(installationControlRoot(env), "control.sqlite");
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    let stat;
    try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Reset control database is unsafe");
  }
  return path;
}

/** The parent owns this journal outside the erased generation. Handlers return
 * admission before staged shutdown; a restart never re-enters execute(). */
export class FactoryReset {
  readonly journal: StateJournal;
  readonly root: string;
  private readonly db: DatabaseSync;
  private busy = false;
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly hooks: () => FactoryResetHooks | null) {
    const observed = rootObservation(env); this.root = observed.root;
    const control = installationControlRoot(env);
    mkdirSync(control, { recursive: true, mode: 0o700 }); readInstallationFence(env);
    syncDirectory(dirname(control)); // Persist the sibling directory entry before any admission.
    const path = controlDatabase(env);
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    if (existsSync(path)) { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.getuid?.()) throw new Error("Reset journal is unsafe"); }
    chmodSync(path, 0o600);
    const fence = readInstallationFence(env); if (fence) writerAbsent(fence.pid);
    this.db = new DatabaseSync(path); this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS factory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    const scope = this.get("identity");
    if (scope && scope !== observed.identity) { this.db.close(); throw new Error("Installation root incarnation changed; reset control scope is not adopted"); }
    this.db.prepare("INSERT OR IGNORE INTO factory_meta VALUES('identity',?)").run(observed.identity);
    this.db.prepare("INSERT OR IGNORE INTO factory_meta VALUES('generation',?)").run(randomUUID());
    this.journal = new StateJournal(this.db, "serve");
  }
  private get(key: string) { return (this.db.prepare("SELECT value FROM factory_meta WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null; }
  close() { if (!this.busy) this.db.close(); }
  async plan() {
    assertInstallationOpen(this.env);
    const hooks = this.hooks(); if (!hooks) throw new Error("Live installation parent coordination unavailable");
    const observed = rootObservation(this.env);
    if (observed.blockedBy.length) throw new Error(observed.blockedBy.join("; "));
    const selection = await hooks.inspect(), generation = this.get("generation")!;
    const blockedBy = [...observed.blockedBy, ...selection.auth.blockedBy, ...selection.worker.blockedBy, ...selection.browser.blockedBy, ...selection.roleBlockers];
    return this.journal.plan({ subject: { kind: "installation", id: selection.serverId }, action: "factory_reset", revision: stateHash([observed.identity, generation, selection]),
      resources: [`installation:${generation}`, ...selection.auth.accounts.map(row => `account:${row.id}`), ...selection.auth.workers.map(row => `auth:${row.id}`), ...selection.worker.worktrees.map(row => `worker:${row.claim.id}`), ...selection.browser.resources.map(row => `browser:${row.id}`)], blockedBy, retained,
      regeneration: ["Apply ends owned work and destroys active-generation payloads/accounts/settings/authority; old uncertain admissions never replay", "New generation and new Access identity require explicit fence release and a later explicit start; no automatic restart, sign-in, pairing, discovery, native turn or backup import", "Plan scope is the whole installation generation, including ordinary state writes before quiescence; external account/worktree/provider identities must stay exact"] }, { selection, identity: observed.identity, generation } satisfies Saved);
  }
  async request(raw: z.infer<typeof factoryResetApply>) {
    const { confirmation: _confirmation, externalWritersQuiesced: _quiesced, ...input } = factoryResetApply.parse(raw);
    const old = this.journal.existing(input); if (old) return old;
    assertInstallationOpen(this.env);
    const hooks = this.hooks(); if (!hooks || this.busy) throw new Error("Installation parent unavailable or already resetting");
    const saved = this.journal.getPlan(input.planId), payload = saved.payload as Saved;
    const observed = rootObservation(this.env);
    if (observed.blockedBy.length) throw new Error(observed.blockedBy.join("; "));
    const selection = await hooks.inspect();
    const admitted = this.journal.existing(input); if (admitted) return admitted;
    this.journal.getPlan(input.planId); // Expiry may advance while owner inspection awaits.
    if (saved.plan.action !== "factory_reset" || input.expectedRevision !== saved.plan.revision || stateHash([observed.identity, this.get("generation"), selection]) !== input.expectedRevision) throw new Error("Installation reset scope changed; prepare a new plan");
    if (saved.plan.blockedBy.length || observed.blockedBy.length || selection.roleBlockers.length) throw new Error([...saved.plan.blockedBy, ...observed.blockedBy, ...selection.roleBlockers].join("; "));
    // Exclusive durable admission fence precedes all stops/effects. A crash before
    // journal admission stays fenced with no effects, never implicitly retried.
    const fence = { version: 1, requestId: input.requestId, generation: payload.generation, nextGeneration: randomUUID(), pid: process.pid, browserRevision: selection.browser.revision };
    durableFence(join(installationControlRoot(this.env), "fence.json"), fence);
    const receipt = this.journal.begin(input, saved.plan); this.busy = true;
    setImmediate(() => { void this.execute(input.requestId, payload, hooks, fence.nextGeneration); });
    return receipt;
  }
  private async execute(requestId: string, saved: Saved, hooks: FactoryResetHooks, nextGeneration: string) {
    const outcomes: StateOutcome[] = [];
    const progress = (outcome: StateOutcome) => { outcomes.push(outcome); this.journal.finish(requestId, "running", outcomes); };
    let failed = true;
    let phase = "owned-runtime teardown";
    try {
      await hooks.quiesce();
      progress({ resource: "serve:runtime", outcome: "removed", detail: "Ingress fenced; upstream owned process groups exited. Cleanup is not Work completion or confirmation of upstream external outcomes." });
      if (rootObservation(this.env).identity !== saved.identity) throw new Error("Installation incarnation changed after drain");
      phase = "owner external-resource cleanup and Vault retention";
      await hooks.cleanup(saved.selection, requestId, progress);
      phase = "active-generation filesystem clearing";
      const observed = rootObservation(this.env);
      if (observed.identity !== saved.identity || observed.blockedBy.length) throw new Error("Installation scope changed during teardown");
      const snapshot = await snapshotStateFiles(this.root, { all: true });
      if (snapshot.entries.some(entry => entry.path.split("/").includes(".git") || entry.path.split("/").some(part => part.startsWith(".stack-clear-")))) throw new Error("Unretained Git or unresolved retirement quarantine remains; no blanket deletion");
      const result = await clearStateFiles(this.root, { all: true }, snapshot);
      progress({ resource: `installation:${saved.generation}`, outcome: result.error ? "unknown" : "removed", detail: result.error ? "Exact filesystem cleanup partial; inspect retained resources/quarantine. Original request never runs again." : "Active installation state removed; independent retained copies/control ledger remain" });
      if (result.error || readdirSync(this.root).length) throw new Error("Installation clearing is incomplete");
      syncDirectory(this.root);
      outcomes.push({ resource: `installation:${nextGeneration}`, outcome: "retained", detail: "Fresh data generation reserved; empty installation remains stopped/fenced until exact completed-generation release and a separate explicit start" });
      this.db.exec("BEGIN IMMEDIATE");
      phase = "generation/receipt completion";
      try { this.db.prepare("UPDATE factory_meta SET value=? WHERE key='generation'").run(nextGeneration); this.journal.finish(requestId, "completed", outcomes); this.db.exec("COMMIT"); }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
      failed = false;
    } catch {
      this.journal.finish(requestId, outcomes.length ? "partial" : "unknown", [...outcomes, { resource: `installation:${saved.generation}`, outcome: "unknown", detail: `Reset interrupted/blocked during ${phase}; startup remains fenced. Inspect exact resources, never replay this request or resume its uncertain generation.` }]);
    } finally { this.busy = false; hooks.finish(failed); }
  }
}

/** Cold reads don't initialize erased package contexts or mark a live writer's
 * running receipt unknown. Recovery is permitted only on definite PID absence. */
export function factoryResetReceipt(env: NodeJS.ProcessEnv, requestId: string) {
  z.uuid().parse(requestId);
  const path = controlDatabase(env), fence = readInstallationFence(env);
  if (!existsSync(path)) return { receipt: null, fence };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT receipt FROM state_receipts WHERE id=?").get(requestId) as { receipt: string } | undefined;
    return { receipt: row ? stateReceipt.parse(JSON.parse(row.receipt)) : null, fence };
  } finally { db.close(); }
}
export function releaseFactoryReset(env: NodeJS.ProcessEnv, raw: z.infer<typeof factoryResetRelease>) {
  const input = factoryResetRelease.parse(raw), observed = factoryResetReceipt(env, input.requestId);
  if (!observed.fence || observed.fence.requestId !== input.requestId || observed.fence.nextGeneration !== input.expectedGeneration || observed.receipt?.status !== "completed") throw new Error("Only an exact completed reset/new generation may release startup; partial/unknown effects require investigation");
  writerAbsent(observed.fence.pid);
  const root = rootObservation(env), db = new DatabaseSync(controlDatabase(env), { readOnly: true });
  try {
    const meta = Object.fromEntries((db.prepare("SELECT key,value FROM factory_meta").all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
    if (meta.identity !== root.identity || meta.generation !== input.expectedGeneration) throw new Error("Completed installation incarnation/generation changed; investigate before starting");
  } finally { db.close(); }
  if (root.names.length) throw new Error("Completed installation root is no longer empty; investigate before starting");
  unlinkSync(join(installationControlRoot(env), "fence.json"));
  syncDirectory(installationControlRoot(env));
  return { released: true as const, generation: input.expectedGeneration };
}
export function recoverFactoryReset(env: NodeJS.ProcessEnv, requestId: string) {
  const observed = factoryResetReceipt(env, requestId);
  if (!observed.fence || observed.fence.requestId !== requestId) throw new Error("Recovery requires the exact installation reset fence");
  writerAbsent(observed.fence.pid);
  const reset = new FactoryReset(env, () => null);
  try { return factoryResetReceipt(env, requestId); } finally { reset.close(); }
}
