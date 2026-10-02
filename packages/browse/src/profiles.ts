import { execFile as execFileCallback } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { botInstance, OperationRejected, operatorInvocation, parseBotMcpIdentity, requireCompletionCoordination, socketCall, socketPath, stateHash, type InvocationContext } from "@stack/api";
import { z } from "zod";
import { Backend, backendSession } from "./backend.js";
import { BrowserSystem } from "./system.js";
import { prepareBotBrowserConfig, browserNamespace } from "./config.js";
import { BrowserGate, type ManagedGate } from "./gate.js";
import { handoffSchema, handoffWatch, actionReceiptSchema, type Handoff, type HandoffRequest, type HandoffAction } from "./handoff.js";

const execFile = promisify(execFileCallback);
export const profileSchema = z.strictObject({
  generation: z.number().int().nonnegative().default(0), maintenanceRequestId: z.uuid().nullable().default(null),
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
type Bot = { id: string; url: string | null; state: string; recoveryIssue: string | null; mainThreadId?: string | null };
const ledgerSchema = z.strictObject({ version: z.literal(1), profiles: z.array(profileSchema), bindings: z.array(bindingSchema), handoffs: z.array(handoffSchema).default([]), actions: z.array(actionReceiptSchema).default([]) });
type Ledger = z.infer<typeof ledgerSchema>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Durable ownership is independent of the ephemeral agent-browser controller. */
export class Profiles {
  private ledger: Ledger = { version: 1, profiles: [], bindings: [], handoffs: [], actions: [] };
  private readonly gates = new Map<string, { source: string; gate: ManagedGate }>();
  private readonly humanUrls = new Map<string, string>();
  private readonly path: string;
  private writes = Promise.resolve();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly launches = new Map<string, Promise<Profile>>();
  private timer: NodeJS.Timeout | null = null;
  private cycle: Promise<void> | null = null;
  private closing = false;
  onChange?: () => void;
  onHandoffChange?: () => void;

  constructor(private readonly backend: Backend, private readonly system: BrowserSystem, private readonly env: NodeJS.ProcessEnv,
    private readonly bots: () => Promise<Bot[]> = async () => {
      const result = await socketCall(socketPath("bots", env), "tools/call", { name: "bot_list", arguments: {} }, { timeoutMs: 5000 }) as { bots: Bot[] };
      return result.bots;
    }, private readonly makeGate: (cdp: string, neko: string, prefix: string) => ManagedGate = (cdp, neko, prefix) => new BrowserGate(cdp, neko, prefix)) { this.path = join(system.root, "profiles.json"); }

  async start(supervise = true): Promise<void> {
    try { this.ledger = ledgerSchema.parse(JSON.parse(await readFile(this.path, "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    for (const profile of this.ledger.profiles) { profile.state = "recovering"; profile.cdpUrl = null; profile.observation = null; }
    for (const binding of this.ledger.bindings) { binding.state = "unknown"; binding.actualProfileId = null; binding.targetId = null; binding.cdpUrl = null; }
    for (const handoff of this.ledger.handoffs) if (handoff.state !== "resolved") {
      handoff.issue = "Owner restarted while held; input grants revoked on runtime recovery. Explicit recovery is required before return.";
      handoff.revision++;
    }
    this.backend.onRecover = async (session) => {
      const profile = this.ledger.profiles.find((item) => backendSession(this.resource(item.id)) === session);
      if (profile && profile.state !== "recovering") { profile.state = "recovering"; profile.cdpUrl = null; profile.observation = null; await this.save(); }
    };
    if (supervise) {
      this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref();
      void this.tick();
    }
  }

  private save(completed?: Handoff): Promise<void> {
    const write = async () => {
      const data = JSON.stringify(completed ? { ...this.ledger, handoffs: this.ledger.handoffs.map((h) => h.id === completed.id ? completed : h) } : this.ledger);
      await mkdir(this.system.root, { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try { await writeFile(temp, data + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, this.path); }
      finally { await rm(temp, { force: true }); }
      if (completed) Object.assign(this.ledger.handoffs.find((h) => h.id === completed.id)!, completed);
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
    if (!invocation || operatorInvocation(invocation)) return null;
    if (!invocation.botId || !invocation.instance || invocation.workerId) throw new Error("browser management requires a Bot-bound MCP invocation");
    const caller = { botId: invocation.botId, instance: invocation.instance };
    await this.verifyCaller(caller);
    if (invocation.transport === "proc") {
      const bot = (await this.bots()).find((item) => item.id === caller.botId);
      if (invocation.authority.kind !== "bot" || bot?.mainThreadId !== invocation.authority.mainThreadId)
        throw new Error("scheduled Bot root changed");
    }
    return caller;
  }

  private async verifyCaller(caller: BrowserCaller): Promise<void> {
    const bot = (await this.bots()).find((item) => item.id === caller.botId);
    if (!bot?.url || bot.state !== "running" || bot.recoveryIssue || botInstance(bot.url) !== caller.instance) throw new Error("browser caller is not the verified live Bot launch");
  }

  private held(profileId: string): boolean { return this.ledger.handoffs.some((h) => h.profileId === profileId && h.state !== "resolved"); }

  async maintain<T>(id: string, run: () => Promise<T>): Promise<T> {
    return this.serial(`handoff:${id}`, () => this.serial(`profile:${id}`, async () => {
      if (this.closing) throw new Error("Browser owner is shutting down");
      return run();
    }));
  }
  async stateObservation(id: string) {
    const profile = this.ledger.profiles.find(row => row.id === id); if (!profile) throw new Error("Unknown Browser profile");
    const bindings = this.ledger.bindings.filter(row => row.profileId === id || row.actualProfileId === id || row.botId === profile.botId && ["connecting", "unknown"].includes(row.state));
    const handoffs = this.ledger.handoffs.filter(row => row.profileId === id && row.state !== "resolved");
    let bot: Bot | null = null, unavailable = false;
    if (profile.botId) try { bot = (await this.bots()).find(row => row.id === profile.botId) ?? null; if (!bot) unavailable = true; } catch { unavailable = true; }
    const { observedAt: _at, cdpUrl: _url, observation: _view, error: _error, ...identity } = profile;
    return { profile: structuredClone(profile), bot, revision: stateHash([identity, bindings, handoffs, bot && [bot.id, bot.state, bot.url, bot.recoveryIssue]]), blockedBy: [
      ...(bindings.length ? ["Close all selected/uncertain controllers before profile maintenance"] : []),
      ...(handoffs.length ? ["Resolve open handoffs before profile maintenance"] : []),
      ...(unavailable ? ["Assigned Bot lifecycle proof unavailable"] : []),
      ...(bot && (bot.state !== "stopped" || bot.url || bot.recoveryIssue) ? ["Stop and verify the assigned Bot before profile maintenance"] : []),
      ...(profile.maintenanceRequestId ? ["Profile maintenance remains fenced; inspect its receipt before exact release"] : []),
    ] };
  }
  stateSource(id: string) { return this.gates.get(id)?.source ?? null; }
  async stateFence(id: string, requestId: string) {
    const profile = this.ledger.profiles.find(row => row.id === id)!;
    if (profile.maintenanceRequestId && profile.maintenanceRequestId !== requestId) throw new Error("Another maintenance request holds this profile");
    profile.maintenanceRequestId = requestId; await this.save();
    const managed = this.gates.get(id); if (managed) { managed.gate.hold(); await managed.gate.drain(); await managed.gate.revokeHuman(); }
  }
  async stateResetMark(id: string) {
    const profile = this.ledger.profiles.find(row => row.id === id)!;
    profile.generation++; profile.state = "recovering"; profile.cdpUrl = null; profile.observation = null; profile.error = null;
    await this.gates.get(id)?.gate.close(); this.gates.delete(id); await this.save();
  }
  async stateRelease(id: string, requestId: string, generation: number) {
    const profile = this.ledger.profiles.find(row => row.id === id); if (!profile || profile.generation !== generation) throw new Error("Profile generation changed");
    if (profile.maintenanceRequestId !== requestId) throw new Error("Exact profile maintenance fence changed");
    profile.maintenanceRequestId = null; await this.save();
    if (!this.held(id)) this.gates.get(id)?.gate.resume();
  }
  async stateRedact(ids: string[]) {
    for (const id of ids) {
      const row = this.ledger.handoffs.find(row => row.id === id); if (!row || row.state !== "resolved") throw new Error("Handoff must be resolved before redaction");
      row.requestDigest ??= stateHash([row.profileId, row.targetId, row.message]);
      row.message = ""; row.note = null; row.issue = null; row.contentClearedAt = new Date().toISOString(); row.revision++; this.humanUrls.delete(id);
    }
    await this.changed();
  }

  async origin(invocation?: InvocationContext): Promise<BrowserCaller & { threadId: string }> {
    const caller = await this.caller(invocation);
    if (!caller || !invocation?.threadId) throw new Error("handoff origin requires a verified Bot Chat invocation");
    // Bots owns sanctioned lineage validation; avoid a browser -> bots module cycle.
    await socketCall(socketPath("bots", this.env), "tools/call", { name: "chat_thread_read", arguments: { botId: caller.botId, threadId: invocation.threadId } }, { timeoutMs: 5000 });
    await this.verifyCaller(caller);
    return { ...caller, threadId: invocation.threadId };
  }

  handoffs(caller: BrowserCaller | null): Handoff[] { return structuredClone(this.ledger.handoffs.filter((h) => !caller || h.botId === caller.botId)); }

  /** Exact Chat-bound handoff identity in any state; identifiers only. */
  completionIdentity(input: { botId: string; threadId: string; requestId: string }) {
    const handoff = this.ledger.handoffs.find((h) => h.botId === input.botId && h.threadId === input.threadId && h.requestId === input.requestId);
    return handoff ? { kind: "browse" as const, requestId: input.requestId, handoffId: handoff.id } : null;
  }

  private async changed(): Promise<void> { await this.save(); this.onHandoffChange?.(); }

  async requestHandoff(input: HandoffRequest, invocation?: InvocationContext): Promise<Handoff> {
    const origin = await this.origin(invocation).catch(error => { throw new OperationRejected(message(error), { cause: error }); });
    return this.serial(`request:${origin.botId}:${origin.threadId}:${input.requestId}`, () => this.serial(`handoff:${input.profileId}`, async () => {
      await this.verifyCaller(origin).catch(error => { throw new OperationRejected(message(error), { cause: error }); });
      const previous = this.ledger.handoffs.find((h) => h.botId === origin.botId && h.threadId === origin.threadId && h.requestId === input.requestId);
      if (previous) {
        if ((previous.requestDigest ?? stateHash([previous.profileId, previous.targetId, previous.message])) !== stateHash([input.profileId, input.targetId ?? null, input.message])) throw new OperationRejected("handoff requestId conflicts with existing intent");
        await requireCompletionCoordination(this.env, "browse", "browser_handoff_request", handoffWatch, input, invocation);
        if (previous.state === "preparing" && !previous.issue?.startsWith("Owner restarted")) await this.prepareHandoff(previous);
        return structuredClone(previous);
      }
      if (this.closing) throw new OperationRejected("browser is shutting down");
      const profile = this.ledger.profiles.find((p) => p.id === input.profileId);
      if (profile?.botId !== origin.botId) throw new OperationRejected("handoff profile does not belong to invoking Bot");
      if (profile.maintenanceRequestId) throw new OperationRejected("Profile maintenance remains fenced");
      if (this.held(input.profileId)) throw new OperationRejected("profile already has an unresolved handoff");
      await requireCompletionCoordination(this.env, "browse", "browser_handoff_request", handoffWatch, input, invocation);
      if (this.closing) throw new OperationRejected("browser is shutting down");
      const handoff: Handoff = { id: randomUUID(), ...origin, profileId: input.profileId, requestId: input.requestId,
        targetId: input.targetId ?? null, targetStatus: input.targetId ? "unknown" : "unspecified", message: input.message,
        state: "preparing", outcome: null, note: null, revision: 1, createdAt: new Date().toISOString(), resolvedAt: null, issue: null, quiesced: false,
        contentClearedAt: null, requestDigest: stateHash([input.profileId, input.targetId ?? null, input.message]) };
      // Synchronous admission fence precedes the first durable-write await.
      this.ledger.handoffs.push(handoff); this.gates.get(input.profileId)?.gate.hold();
      await this.changed();
      await this.prepareHandoff(handoff);
      return structuredClone(handoff);
    }));
  }

  private async prepareHandoff(handoff: Handoff): Promise<void> {
    try {
      const managed = this.gates.get(handoff.profileId);
      if (!managed) throw new Error("runtime unavailable; profile remains held");
      await managed.gate.drain();
      await managed.gate.revokeHuman();
      handoff.quiesced = true;
      if (handoff.targetId) {
        handoff.targetStatus = "unknown";
        const response = await fetch(managed.source + "/json/list", { signal: AbortSignal.timeout(3000), redirect: "error" });
        if (!response.ok) throw new Error("target discovery unavailable");
        const tabs = await response.json() as Array<{ id: string }>;
        handoff.targetStatus = tabs.some((tab) => tab.id === handoff.targetId) ? "present" : "missing";
      }
      handoff.state = "awaiting_human"; handoff.issue = null;
    } catch (error) { handoff.issue = message(error); }
    handoff.revision++; await this.changed();
  }

  private async activateTarget(handoff: Handoff): Promise<void> {
    if (!handoff.targetId) return;
    handoff.targetStatus = "unknown";
    const source = this.gates.get(handoff.profileId)!.source;
    const tabs = await fetch(source + "/json/list", { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!tabs.ok) throw new Error("target discovery unavailable");
    handoff.targetStatus = (await tabs.json() as Array<{ id: string }>).some((tab) => tab.id === handoff.targetId) ? "present" : "missing";
    if (handoff.targetStatus === "missing") return;
    const activated = await fetch(source + "/json/activate/" + encodeURIComponent(handoff.targetId), { signal: AbortSignal.timeout(3000), redirect: "error" });
    if (!activated.ok) throw new Error("requested target could not be activated");
  }

  async actHandoff(kind: "take" | "finish" | "cancel", input: HandoffAction & { outcome?: "completed" | "skipped"; note?: string }, invocation?: InvocationContext): Promise<{ handoff: Handoff; controlUrl: string | null }> {
    if (kind !== "cancel" && invocation) throw new Error("human handoff actions require the local operator transport");
    const origin = kind === "cancel" ? await this.origin(invocation) : null;
    const item = this.ledger.handoffs.find((h) => h.id === input.id);
    if (!item) throw new Error("unknown browser handoff");
    return this.serial(`handoff:${item.profileId}`, async () => {
      if (origin) {
        await this.verifyCaller(origin);
        if (item.botId !== origin.botId || item.threadId !== origin.threadId || item.instance !== origin.instance || this.ledger.profiles.find((p) => p.id === item.profileId)?.botId !== origin.botId) throw new Error("handoff belongs to another Chat or Bot launch");
      }
      const digest = createHash("sha256").update(JSON.stringify({ kind, ...input })).digest("hex");
      const receipt = this.ledger.actions.find((a) => a.id === item.id && a.requestId === input.requestId);
      if (receipt && receipt.digest !== digest) throw new Error("handoff action requestId conflicts with existing intent");
      if (!receipt && input.expectedRevision !== item.revision) throw new Error("stale handoff revision");
      if (receipt && (item.state === "resolved" || kind === "take")) {
        if (kind === "take" && item.state === "human_controlling" && !this.humanUrls.has(item.id)) {
          const gate = this.gates.get(item.profileId)?.gate;
          if (!gate) throw new Error("runtime unavailable; profile remains held");
          await gate.drain();
          await gate.revokeHuman();
          await this.activateTarget(item);
          await this.changed();
          this.humanUrls.set(item.id, await gate.grantHuman());
          item.issue = null; item.revision++; await this.changed();
        }
        return { handoff: structuredClone(item), controlUrl: this.humanUrls.get(item.id) ?? null };
      }
      if (kind === "take") {
        if (item.state !== "awaiting_human") throw new Error("handoff is not awaiting human control");
        const gate = this.gates.get(item.profileId)?.gate;
        if (!gate) throw new Error("runtime unavailable; profile remains held");
        await gate.drain();
        await gate.revokeHuman();
        await this.activateTarget(item);
        // Persist human ownership before exposing any input grant.
        item.state = "human_controlling"; item.revision++; item.issue = null;
        this.ledger.actions.push({ id: item.id, requestId: input.requestId, digest, revision: item.revision });
        await this.changed();
        try { this.humanUrls.set(item.id, await gate.grantHuman()); }
        catch (error) { item.issue = message(error); item.revision++; await this.changed(); }
      } else {
        if (kind === "cancel" && !["preparing", "awaiting_human", "returning"].includes(item.state)) throw new Error("agent may cancel only before human take");
        if (!receipt && item.state === "returning") throw new Error("return already admitted; retry its exact action requestId");
        if (kind === "finish" && !["awaiting_human", "human_controlling", "returning"].includes(item.state)) throw new Error("handoff is not ready for a human finish");
        if (!receipt) {
          item.state = "returning"; item.outcome = kind === "cancel" ? "cancelled" : input.outcome!; item.note = input.note ?? null; item.revision++;
          this.ledger.actions.push({ id: item.id, requestId: input.requestId, digest, revision: item.revision });
          await this.changed();
        }
        try {
          const gate = this.gates.get(item.profileId)?.gate;
          if (!gate) throw new Error("runtime unavailable; profile remains held");
          await gate.drain();
          await gate.revokeHuman(); this.humanUrls.delete(item.id);
          // Native close invalidates cached refs and every selected controller.
          // Selection away to another profile is allowed and must not be closed.
          for (const binding of this.ledger.bindings.filter((b) => b.profileId === item.profileId || b.actualProfileId === item.profileId)) {
            await this.serial(`controller:${binding.botId}:${binding.instance}:${binding.session}`, async () => {
              if (binding.profileId === item.profileId || binding.actualProfileId === item.profileId) await this.disconnect(binding);
            });
          }
          // If persistence fails after admission reopens, newly admitted work
          // must drain again; a replacement gate cannot inherit old quiescence.
          item.quiesced = false;
          gate.resume();
          // Keep completion invisible until both runtime admission and the
          // durable transition succeed. A failed write restores the hold.
          await this.save({ ...item, quiesced: true, state: "resolved", resolvedAt: new Date().toISOString(), issue: null, revision: item.revision + 1 });
          this.onHandoffChange?.();
        } catch (error) {
          this.gates.get(item.profileId)?.gate.hold();
          item.state = "returning"; item.resolvedAt = null; item.issue = message(error); item.revision++; await this.changed();
        }
      }
      return { handoff: structuredClone(item), controlUrl: this.humanUrls.get(item.id) ?? null };
    });
  }

  /** Owner lifecycle fence, also called before reusing a removed Bot's ID. */
  async releaseBot(botId: string): Promise<{ released: true }> {
    for (const profile of this.ledger.profiles) if (profile.botId === botId) await this.serial(`handoff:${profile.id}`, () => this.serial("inventory", async () => {
      profile.botId = null; profile.default = false; await this.save();
    }));
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
      const profile: Profile = { id: randomUUID(), botId, label, default: isDefault, createdAt: new Date().toISOString(), generation: 0, maintenanceRequestId: null,
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
    const task = this.serial(`handoff:${id}`, () => this.serial(`profile:${id}`, async () => {
      if (this.closing) throw new Error("browser is shutting down");
      const profile = this.ledger.profiles.find((item) => item.id === id);
      if (!profile) throw new Error("unknown browser profile");
      if (profile.maintenanceRequestId) throw new Error("Profile maintenance remains fenced");
      if (profile.state === "failed") { profile.state = "recovering"; await this.save(); }
      try {
        const launched = await this.backend.launch(this.resource(id), true);
        const observation = await this.backend.observation(this.resource(id));
        if (!observation) throw new Error("browser observation endpoint unavailable");
        let managed = this.gates.get(id);
        if (managed?.source !== launched.cdpUrl) {
          for (const h of this.ledger.handoffs.filter((h) => h.profileId === id && h.state !== "resolved")) this.humanUrls.delete(h.id);
          await managed?.gate.revokeHuman();
          await managed?.gate.close();
          this.gates.delete(id);
          const gate = this.makeGate(launched.cdpUrl, new URL(observation.url).origin, `stack:${id}`);
          try { await gate.start(); } catch (error) { await gate.close(); throw error; }
          managed = { source: launched.cdpUrl, gate }; this.gates.set(id, managed);
          if (this.ledger.handoffs.some((h) => h.profileId === id && h.state !== "resolved" && !h.quiesced)) gate.unknownDrain();
          if (!this.held(id)) gate.resume();
        }
        profile.state = "ready"; profile.error = null; profile.cdpUrl = managed.gate.cdpUrl;
        profile.observation = { ...observation, url: managed.gate.observationUrl, follows: "visible-tab", verified: false };
      } catch (error) {
        profile.state = "failed"; profile.error = message(error); profile.cdpUrl = null; profile.observation = null;
      }
      profile.observedAt = new Date().toISOString(); await this.save();
      return structuredClone(profile);
    }));
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
          await this.serial(`handoff:${profile.id}`, async () => { profile.botId = null; profile.default = false; });
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
    return this.serial(`handoff:${id}`, () => this.serial(`profile:${id}`, async () => {
      if (caller) await this.verifyCaller(caller);
      const profile = this.ledger.profiles.find((item) => item.id === id);
      if (caller && profile?.botId !== caller.botId) throw new Error("profile does not belong to the invoking Bot");
      if (!profile) return { deleted: true };
      if (profile.maintenanceRequestId) throw new Error("Profile maintenance remains fenced");
      if (this.held(id)) throw new Error("profile has an unresolved handoff");
      if (profile.default && profile.botId) throw new Error("cannot delete a Bot's default profile");
      if (this.ledger.bindings.some((binding) => binding.botId === profile.botId && ["connecting", "unknown"].includes(binding.state))) throw new Error("a Bot controller has an uncertain binding; resolve it before deleting a profile");
      if (this.ledger.bindings.some((binding) => binding.profileId === id || binding.actualProfileId === id)) throw new Error("profile is selected by a controller; select another profile first");
      const receipt = await this.backend.get(this.resource(id));
      if (receipt?.target) await this.backend.close({ session: receipt.session, lease: receipt.lease, browserProfile: receipt.profile, browserTarget: receipt.target.name, backend: "local" });
      else if (receipt) await this.backend.reconcile(receipt.session, receipt.lease);
      this.ledger.profiles = this.ledger.profiles.filter((item) => item.id !== id); await this.save();
      await this.gates.get(id)?.gate.close(); this.gates.delete(id);
      return { deleted: true };
    }));
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
    if (this.held(binding.profileId)) throw new Error("browser profile is held for human handoff");
    const profile = await this.ensure(binding.profileId);
    if (this.held(binding.profileId)) throw new Error("browser profile is held for human handoff");
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
    if (this.held(profileId)) throw new Error("browser profile is held for human handoff");
    if (this.ledger.profiles.find((item) => item.id === profileId)?.botId !== botId) throw new Error("profile is not exclusively assigned to this Bot");
    // Runtime recovery takes the handoff lock. Never acquire it while holding
    // a controller lock: handback takes those locks to invalidate refs.
    const profile = await this.ensure(profileId);
    return this.serial(`controller:${botId}:${instance}:${session}`, async () => {
      if (caller) await this.verifyCaller(caller);
      if (this.closing) throw new Error("browser is shutting down");
      if (this.held(profileId)) throw new Error("browser profile is held for human handoff");
      if (this.ledger.profiles.find((item) => item.id === profileId)?.botId !== botId) throw new Error("profile is not exclusively assigned to this Bot");
      if (profile.botId !== botId) throw new Error("profile is not exclusively assigned to this Bot");
      if (profile.state !== "ready" || !profile.cdpUrl) throw new Error(profile.error ?? "profile is not ready");
      const binding = await this.serial(`profile:${profileId}`, async () => {
        if (caller) await this.verifyCaller(caller);
        if (this.held(profileId)) throw new Error("browser profile is held for human handoff");
        const current = this.ledger.profiles.find((item) => item.id === profileId);
        if (!current || current.botId !== botId || current.state !== "ready" || current.maintenanceRequestId) throw new Error("profile changed before controller selection");
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
    for (const { gate } of this.gates.values()) gate.hold();
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
    await Promise.all([...this.gates.values()].map(({ gate }) => gate.close()));
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Some browsers could not be cleanly stopped; their resources were retained");
  }
}
