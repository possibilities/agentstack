import { execFile as execFileCallback } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { botInstance, parseBotMcpIdentity, socketCall, socketPath, type InvocationContext } from "@agentstack/api";
import { z } from "zod";
import { Backend, backendSession } from "./backend.js";
import { BrowserSystem } from "./system.js";
import { prepareBotBrowserConfig, browserNamespace } from "./config.js";

const execFile = promisify(execFileCallback);
export const profileSchema = z.strictObject({
  id: z.uuid(), botId: z.string().nullable(), label: z.string(), default: z.boolean(), createdAt: z.string(),
  state: z.enum(["starting", "ready", "recovering", "failed"]), error: z.string().nullable(),
  observedAt: z.string().nullable(), cdpUrl: z.string().nullable(),
  observation: z.strictObject({ url: z.string(), udpPort: z.number(), follows: z.literal("visible-tab"), verified: z.literal(false) }).nullable(),
});
export type Profile = z.infer<typeof profileSchema>;
export const bindingSchema = z.strictObject({
  botId: z.string(), instance: z.string(), session: z.string(), profileId: z.uuid(),
  actualProfileId: z.uuid().nullable(), targetId: z.string().nullable(), cdpUrl: z.string().nullable(),
  state: z.enum(["connecting", "connected", "disconnected", "unknown"]), revision: z.number().int(),
  observedAt: z.string().nullable(), error: z.string().nullable(),
});
type Binding = z.infer<typeof bindingSchema>;
export type BrowserCaller = { botId: string; instance: string };
type Bot = { id: string; url: string | null; state: string; recoveryIssue: string | null };
const ledgerSchema = z.strictObject({ version: z.literal(1), profiles: z.array(profileSchema), bindings: z.array(bindingSchema) });
type Ledger = z.infer<typeof ledgerSchema>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Durable ownership is independent of the ephemeral agent-browser controller. */
export class Profiles {
  private ledger: Ledger = { version: 1, profiles: [], bindings: [] };
  private readonly path: string;
  private writes = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly launches = new Map<string, Promise<Profile>>();
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private closing = false;
  onChange?: () => void;

  constructor(private readonly backend: Backend, private readonly system: BrowserSystem, private readonly env: NodeJS.ProcessEnv,
    private readonly bots: () => Promise<Bot[]> = async () => {
      const result = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 5000 }) as { bots: Bot[] };
      return result.bots;
    }) { this.path = join(system.root, "profiles.json"); }

  async start(supervise = true): Promise<void> {
    try { this.ledger = ledgerSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const profile of this.ledger.profiles) { profile.state = "recovering"; profile.cdpUrl = null; profile.observation = null; }
    for (const binding of this.ledger.bindings) { binding.state = "unknown"; binding.actualProfileId = null; binding.targetId = null; binding.cdpUrl = null; }
    this.backend.onRecover = async (session) => {
      const profile = this.ledger.profiles.find((item) => backendSession(this.resource(item.id)) === session);
      if (profile && profile.state !== "recovering") { profile.state = "recovering"; profile.cdpUrl = null; profile.observation = null; await this.save(); }
    };
    if (supervise) {
      this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref();
      void this.tick();
    }
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.ledger);
    const write = async () => {
      await mkdir(this.system.root, { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, data + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, this.path); }
      finally { await rm(temp, { force: true }); }
      this.onChange?.();
    };
    const task = this.writes.then(write, write); this.writes = task.catch(() => undefined); return task;
  }

  private serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(key, task);
    void task.finally(() => { if (this.queues.get(key) === task) this.queues.delete(key); }).catch(() => undefined);
    return task;
  }

  list(): Profile[] { return structuredClone(this.ledger.profiles); }
  bindings(): Binding[] { return structuredClone(this.ledger.bindings); }

  async caller(invocation?: InvocationContext): Promise<BrowserCaller | null> {
    if (!invocation) return null; // Local operator socket/WebSocket.
    if (!invocation.botId || !invocation.instance || invocation.workerId) throw new Error("browser management requires a Bot-bound MCP invocation");
    const caller = { botId: invocation.botId, instance: invocation.instance };
    await this.verifyCaller(caller);
    return caller;
  }

  private async verifyCaller(caller: BrowserCaller): Promise<void> {
    const bot = (await this.bots()).find((item) => item.id === caller.botId);
    if (!bot?.url || bot.state !== "running" || bot.recoveryIssue || botInstance(bot.url) !== caller.instance) throw new Error("browser caller is not the verified live Bot launch");
  }

  /** Owner lifecycle fence, also called before reusing a removed Bot's ID. */
  async releaseBot(botId: string): Promise<{ released: true }> {
    await this.serial("inventory", async () => {
      for (const profile of this.ledger.profiles) if (profile.botId === botId) { profile.botId = null; profile.default = false; }
      await this.save();
    });
    for (const binding of [...this.ledger.bindings].filter((item) => item.botId === botId)) {
      await this.serial(`controller:${binding.botId}:${binding.instance}:${binding.session}`, async () => {
        await this.disconnect(binding);
        this.ledger.bindings = this.ledger.bindings.filter((item) => item !== binding);
        await this.save();
      });
    }
    return { released: true };
  }

  async create(botId: string | null, label: string, isDefault = false, caller?: BrowserCaller | null): Promise<Profile> {
    if (this.closing) throw new Error("browser is shutting down");
    return this.serial("inventory", async () => {
      if (caller) {
        await this.verifyCaller(caller);
        if (botId !== caller.botId) throw new Error("profile must belong to the invoking Bot");
      }
      if (botId && !(await this.bots()).some((bot) => bot.id === botId)) throw new Error("unknown Bot");
      if (isDefault) {
        const existing = this.ledger.profiles.find((profile) => profile.botId === botId && profile.default);
        if (existing) return structuredClone(existing);
      }
      const profile: Profile = { id: randomUUID(), botId, label, default: isDefault, createdAt: new Date().toISOString(),
        state: "starting", error: null, observedAt: null, cdpUrl: null, observation: null };
      this.ledger.profiles.push(profile); await this.save();
      // Admission is durable; health is reported separately, never guessed.
      void this.ensure(profile.id).catch(() => undefined);
      return structuredClone(profile);
    });
  }

  private resource(id: string): string { return `profile:${id}`; }

  async ensure(id: string): Promise<Profile> {
    const pending = this.launches.get(id); if (pending) return pending;
    const task = this.serial(`profile:${id}`, async () => {
      if (this.closing) throw new Error("browser is shutting down");
      const profile = this.ledger.profiles.find((item) => item.id === id);
      if (!profile) throw new Error("unknown browser profile");
      if (profile.state === "failed") { profile.state = "recovering"; await this.save(); }
      try {
        const launched = await this.backend.launch(this.resource(id), true);
        const observation = await this.backend.observation(this.resource(id));
        profile.state = "ready"; profile.error = null; profile.cdpUrl = launched.cdpUrl;
        profile.observation = observation ? { ...observation, follows: "visible-tab", verified: false } : null;
      } catch (error) {
        profile.state = "failed"; profile.error = message(error); profile.cdpUrl = null; profile.observation = null;
      }
      profile.observedAt = new Date().toISOString(); await this.save();
      return structuredClone(profile);
    });
    this.launches.set(id, task);
    void task.finally(() => { this.launches.delete(id); }).catch(() => undefined);
    return task;
  }

  async tick(): Promise<void> {
    if (this.closing || this.cycle) return this.cycle ?? undefined;
    this.cycle = (async () => {
      try {
        const bots = await this.bots();
        for (const bot of bots) await this.create(bot.id, "Default", true);
        const ids = new Set(bots.map((bot) => bot.id));
        for (const profile of this.ledger.profiles) if (profile.botId && !ids.has(profile.botId)) {
          profile.botId = null; profile.default = false;
        }
        for (const binding of [...this.ledger.bindings]) {
          const bot = bots.find((item) => item.id === binding.botId);
          if (!bot?.url || bot.state !== "running" || botInstance(bot.url) !== binding.instance) {
            await this.serial(`controller:${binding.botId}:${binding.instance}:${binding.session}`, async () => {
              await this.disconnect(binding);
              this.ledger.bindings = this.ledger.bindings.filter((item) => item !== binding);
            });
          }
        }
        await this.save();
      } catch { /* Unavailable Bot inventory is not evidence of deletion. */ }
      await Promise.all(this.ledger.profiles.map((profile) => this.ensure(profile.id).catch(() => undefined)));
    })().finally(() => { this.cycle = null; });
    return this.cycle;
  }

  async remove(id: string, caller?: BrowserCaller | null): Promise<{ deleted: true }> {
    return this.serial(`profile:${id}`, async () => {
      if (caller) await this.verifyCaller(caller);
      const profile = this.ledger.profiles.find((item) => item.id === id);
      if (caller && profile?.botId !== caller.botId) throw new Error("profile does not belong to the invoking Bot");
      if (!profile) return { deleted: true };
      if (profile.default && profile.botId) throw new Error("cannot delete a Bot's default profile");
      if (this.ledger.bindings.some((binding) => binding.botId === profile.botId && ["connecting", "unknown"].includes(binding.state))) throw new Error("a Bot controller has an uncertain binding; resolve it before deleting a profile");
      if (this.ledger.bindings.some((binding) => binding.profileId === id || binding.actualProfileId === id)) throw new Error("profile is selected by a controller; select another profile first");
      const receipt = await this.backend.get(this.resource(id));
      if (receipt?.target) await this.backend.close({ session: receipt.session, lease: receipt.lease, browserProfile: receipt.profile, browserTarget: receipt.target.name, backend: "local" });
      else if (receipt) await this.backend.reconcile(receipt.session, receipt.lease);
      this.ledger.profiles = this.ledger.profiles.filter((item) => item.id !== id); await this.save();
      return { deleted: true };
    });
  }

  private async identity(identity: string): Promise<{ bot: Bot; instance: string }> {
    const parsed = parseBotMcpIdentity(new URL(identity), this.env);
    const bot = parsed && (await this.bots()).find((item) => item.id === parsed.botId);
    if (!parsed || !bot?.url || bot.state !== "running" || bot.recoveryIssue || botInstance(bot.url) !== parsed.instance) throw new Error("browser requires a verified live Bot launch; session names are not identity");
    return { bot, instance: parsed.instance };
  }

  private async binding(bot: Bot, instance: string, session: string): Promise<Binding> {
    let binding = this.ledger.bindings.find((item) => item.botId === bot.id && item.instance === instance && item.session === session);
    if (!binding) {
      const profile = await this.create(bot.id, "Default", true);
      // Concurrent provider launches and management reads converge on one row.
      binding = this.ledger.bindings.find((item) => item.botId === bot.id && item.instance === instance && item.session === session);
      if (!binding) {
        binding = { botId: bot.id, instance, session, profileId: profile.id, actualProfileId: null, targetId: null, cdpUrl: null,
          state: "disconnected", revision: 0, observedAt: null, error: null };
        this.ledger.bindings.push(binding); await this.save();
      }
    }
    return binding;
  }

  async launch(identity: string, session: string): Promise<{ cdpUrl: string; cleanup: { controller: string; revision: number } }> {
    const { bot, instance } = await this.identity(identity);
    const binding = await this.binding(bot, instance, session);
    const profile = await this.ensure(binding.profileId);
    if (profile.botId !== bot.id || profile.state !== "ready" || !profile.cdpUrl) throw new Error(profile.error ?? "Bot browser is not ready");
    // Provider admission is not proof that the daemon connected successfully.
    if (binding.state !== "connecting") {
      binding.state = "unknown"; binding.actualProfileId = null; binding.targetId = null; binding.cdpUrl = null;
      binding.error = null; binding.observedAt = new Date().toISOString(); await this.save();
    }
    return { cdpUrl: profile.cdpUrl, cleanup: { controller: this.key(binding), revision: binding.revision } };
  }

  private key(binding: Binding): string { return createHash("sha256").update(`${binding.botId}\0${binding.instance}\0${binding.session}`).digest("hex"); }

  async disconnected(controller: string, revision: number): Promise<{ closed: true }> {
    const binding = this.ledger.bindings.find((item) => this.key(item) === controller);
    if (binding && binding.revision === revision && binding.state !== "connecting") {
      binding.state = "disconnected"; binding.actualProfileId = null; binding.targetId = null; binding.cdpUrl = null;
      binding.observedAt = new Date().toISOString(); await this.save();
    }
    return { closed: true };
  }

  private async command(bot: Bot, instance: string, session: string, args: string[]): Promise<Record<string, unknown>> {
    const status = await this.system.browserStatus();
    if (!status.location) throw new Error("managed agent-browser is not installed");
    const config = prepareBotBrowserConfig(this.env, bot.id, bot.url!);
    const env = Object.fromEntries(Object.entries(this.env).filter(([key]) => !key.startsWith("AGENT_BROWSER_")));
    const result = await execFile(status.location, ["--config", config, "--namespace", browserNamespace(this.env, bot.id, instance), "--session", session, "--idle-timeout", "0", "--json", ...args],
      { env, timeout: 65_000, maxBuffer: 1024 * 1024 });
    const response = JSON.parse(result.stdout) as { success: boolean; error?: string; data?: Record<string, unknown> };
    if (!response.success || !response.data) throw new Error(response.error ?? "agent-browser did not confirm the command");
    return response.data;
  }

  private async disconnect(binding: Binding): Promise<void> {
    const status = await this.system.browserStatus();
    if (!status.location) {
      if (binding.state === "disconnected") return;
      throw new Error("cannot disconnect controller without managed agent-browser");
    }
    const config = join(this.system.root, "controller-close.json");
    await writeFile(config, "{}\n", { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(this.env).filter(([key]) => !key.startsWith("AGENT_BROWSER_")));
    const result = await execFile(status.location, ["--config", config, "--namespace", browserNamespace(this.env, binding.botId, binding.instance), "--session", binding.session, "--json", "close"], { env, timeout: 65_000 });
    const response = JSON.parse(result.stdout) as { success?: boolean; data?: { closed?: boolean } };
    if (response.success !== true || response.data?.closed !== true) throw new Error("agent-browser did not confirm controller disconnect");
    binding.state = "disconnected"; binding.actualProfileId = null; binding.cdpUrl = null; binding.targetId = null;
  }

  async select(botId: string, session: string, profileId: string, caller?: BrowserCaller | null): Promise<Binding> {
    const bot = (await this.bots()).find((item) => item.id === botId);
    if (!bot?.url || bot.state !== "running" || bot.recoveryIssue) throw new Error("Bot is not a verified running launch");
    const instance = botInstance(bot.url);
    if (caller && (caller.botId !== botId || caller.instance !== instance)) throw new Error("controller must belong to the invoking live Bot launch");
    return this.serial(`controller:${botId}:${instance}:${session}`, async () => {
      if (caller) await this.verifyCaller(caller);
      if (this.closing) throw new Error("browser is shutting down");
      if (this.ledger.profiles.find((item) => item.id === profileId)?.botId !== botId) throw new Error("profile is not exclusively assigned to this Bot");
      const profile = await this.ensure(profileId);
      if (profile.botId !== botId) throw new Error("profile is not exclusively assigned to this Bot");
      if (profile.state !== "ready" || !profile.cdpUrl) throw new Error(profile.error ?? "profile is not ready");
      const binding = await this.serial(`profile:${profileId}`, async () => {
        if (caller) await this.verifyCaller(caller);
        const current = this.ledger.profiles.find((item) => item.id === profileId);
        if (!current || current.botId !== botId || current.state !== "ready") throw new Error("profile changed before controller selection");
        const binding = await this.binding(bot, instance, session);
        binding.profileId = profileId; binding.revision++; binding.state = "connecting";
        binding.actualProfileId = null; binding.cdpUrl = null; binding.targetId = null; binding.error = null;
        await this.save();
        return binding;
      });
      try {
        // Native daemon serializes connect with page commands. The provider's
        // durable selection must precede connect: its config is reapplied on
        // subsequent commands, and otherwise would silently reconnect the old profile.
        await this.command(bot, instance, session, ["connect", profile.cdpUrl]);
        const actual = await this.command(bot, instance, session, ["get", "cdp-url"]);
        const cdpUrl = actual.cdpUrl;
        const version = await fetch(profile.cdpUrl + "/json/version", { signal: AbortSignal.timeout(3000) });
        const expected = await version.json() as { webSocketDebuggerUrl?: string };
        if (typeof cdpUrl !== "string" || cdpUrl !== expected.webSocketDebuggerUrl) throw new Error("controller did not confirm the selected browser target");
        const tabs = await this.command(bot, instance, session, ["tab", "list"]);
        const active = Array.isArray(tabs.tabs) ? tabs.tabs.find((tab: Record<string, unknown>) => tab.active) : undefined;
        const live = (await this.bots()).find((item) => item.id === botId);
        if (live?.url !== bot.url || live.state !== "running" || live.recoveryIssue || this.ledger.profiles.find((item) => item.id === profileId)?.botId !== botId) throw new Error("Bot launch or profile assignment changed during selection");
        binding.actualProfileId = profileId; binding.cdpUrl = cdpUrl;
        binding.targetId = active && typeof active.targetId === "string" ? active.targetId : null;
        binding.state = "connected";
      } catch (error) { binding.state = "unknown"; binding.error = message(error); }
      binding.observedAt = new Date().toISOString(); await this.save();
      return structuredClone(binding);
    });
  }

  prepareClose(): void {
    this.closing = true;
    this.backend.beginShutdown();
    if (this.timer) clearInterval(this.timer);
  }

  async close(): Promise<void> {
    this.prepareClose();
    await this.cycle;
    await Promise.allSettled([...this.queues.values(), ...this.launches.values()]);
    await Promise.all(this.ledger.bindings.map((binding) => this.disconnect(binding)));
    const results = await Promise.allSettled(this.ledger.profiles.map((profile) => this.backend.suspend(this.resource(profile.id))));
    await this.writes;
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Some browsers could not be cleanly stopped; their resources were retained");
  }
}
