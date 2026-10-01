import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { StateJournal, operation, requireStateOperator, socketCall, socketPath, stateApplyInput, stateHash, statePageInput, statePlan, stateReceipt, type StateApplyInput, type StateOutcome } from "@stack/api";
import type { BrowserContext } from "../api.js";
import type { Profiles } from "./profiles.js";
import type { Backend } from "./backend.js";
import { clearSiteData, observeSiteData } from "./site-data.js";
import { clearBrowserFactoryReset, type BrowserResetSnapshot } from "./factory-reset.js";

const profile = z.strictObject({ profileId: z.uuid() });
const site = profile.extend({ origins: z.array(z.string().max(2048)).min(1).max(50), categories: z.array(z.enum(["cookies", "storage", "cache", "history"])).min(1).max(4) });
const selectionSchema = z.discriminatedUnion("kind", [profile.extend({ kind: z.literal("reset") }), site.extend({ kind: z.literal("site") }),
  z.strictObject({ kind: z.literal("handoff"), ids: z.array(z.uuid()).min(1).max(100) }), z.strictObject({ kind: z.literal("volume"), ids: z.array(z.string().min(1).max(256)).min(1).max(100) })]);
type Selection = z.infer<typeof selectionSchema>;
const retained = ["Other profiles, foreign/occupied volumes, external copies/backups and other owners' history remain", "Minimal plan/receipt and handoff admission digests remain; unknown effects never retry", "Scoped cache means CacheStorage only; HTTP browser cache and persisted navigation history are unsupported and never silently widened"];
export class BrowseState {
  factoryReset(requestId: string, snapshot: BrowserResetSnapshot) { return clearBrowserFactoryReset(this.backend, this.journal, this.env, requestId, snapshot, () => this.profiles.close()); }
  readonly journal: StateJournal;
  private readonly callbacks = new Map<string, { botId: string; profileId: string; run: () => Promise<Record<string, unknown>> }>();
  constructor(private readonly profiles: Profiles, private readonly backend: Backend, private readonly env: NodeJS.ProcessEnv, root: string) { this.journal = new StateJournal(join(root, "maintenance.sqlite"), "browse"); }
  private normalize(input: Selection): Selection {
    if (input.kind === "site") return { kind: input.kind, profileId: input.profileId, categories: [...new Set(input.categories)].sort(), origins: [...new Set(input.origins.map(value => {
      const url = new URL(value); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Select exact credential-free HTTP(S) origins, not page URLs"); return url.origin;
    }))].sort() };
    return "ids" in input ? { kind: input.kind, ids: [...new Set(input.ids)].sort() } : { kind: input.kind, profileId: input.profileId };
  }
  private async lock<T>(selection: Selection, run: () => Promise<T>) {
    const ids = "profileId" in selection ? [selection.profileId] : selection.kind === "handoff" ? [...new Set(this.profiles.handoffs(null).filter(row => selection.ids.includes(row.id)).map(row => row.profileId))].sort() : ["state-volumes"];
    const next = (index: number): Promise<T> => index === ids.length ? run() : this.profiles.maintain(ids[index]!, () => next(index + 1)); return next(0);
  }
  private async guarded<T extends Record<string, unknown>>(selection: Selection, run: () => Promise<T>): Promise<T> {
    if (!("profileId" in selection)) return run();
    const profile = this.profiles.list().find(row => row.id === selection.profileId); if (!profile) throw new Error("Unknown profile");
    if (!profile.botId) return run();
    const token = randomUUID(); this.callbacks.set(token, { botId: profile.botId, profileId: profile.id, run });
    try { return await socketCall(socketPath("bots", this.env), "tools/call", { name: "bot_state_browser_guard", arguments: { botId: profile.botId, profileId: profile.id, token } }, { timeoutMs: 120000 }) as T; }
    finally { this.callbacks.delete(token); }
  }
  async callback(input: { botId: string; profileId: string; token: string }) {
    const pending = this.callbacks.get(input.token);
    if (!pending || pending.botId !== input.botId || pending.profileId !== input.profileId || this.profiles.list().find(row => row.id === input.profileId)?.botId !== input.botId) throw new Error("No exact owner-issued Browser maintenance callback");
    this.callbacks.delete(input.token); return pending.run();
  }
  private async prepare(selection: Selection) {
    let rows: Array<{ id: string; revision: string; blockedBy: string[] }> = [], native: Awaited<ReturnType<Backend["stateProfile"]>> | null = null, siteRevision: string | null = null;
    if ("profileId" in selection) {
      const observation = await this.profiles.stateObservation(selection.profileId), blockedBy = [...observation.blockedBy];
      try { native = await this.backend.stateProfile(`profile:${selection.profileId}`); blockedBy.push(...native.blockedBy); } catch { blockedBy.push("Provider profile inventory unavailable"); }
      if (selection.kind === "site") {
        if (selection.categories.includes("history")) blockedBy.push("Persisted Chromium history has no verified origin-scoped clear; whole-profile history/HTTP-cache clearing is unsupported");
        const source = this.profiles.stateSource(selection.profileId);
        if (!source || observation.profile.state !== "ready") blockedBy.push("Exact profile CDP is not ready; maintenance never starts a browser during planning");
        else if (!blockedBy.length) try { siteRevision = (await observeSiteData(source, selection)).revision; } catch { blockedBy.push("Scoped cookie/storage observation unavailable or unsafe"); }
      }
      rows = [{ id: selection.profileId, revision: stateHash([observation.revision, native?.revision, siteRevision]), blockedBy }];
    } else if (selection.kind === "handoff") {
      const handoffs = this.profiles.handoffs(null);
      rows = selection.ids.map(id => { const row = handoffs.find(row => row.id === id); if (!row) throw new Error("Unknown handoff"); return { id, revision: stateHash(row), blockedBy: row.state !== "resolved" ? ["Open handoff must be resolved before redaction"] : [] }; });
    } else {
      const inventory = await this.backend.stateVolumes();
      rows = selection.ids.map(id => { const row = inventory.volumes.find(row => row.id === id); if (!row) throw new Error("No exact owned volume; foreign volumes are not selectable"); return { id, revision: stateHash(row), blockedBy: row.blockedBy }; });
    }
    return { rows, native, siteRevision, preview: { subject: "profileId" in selection ? { kind: "profile", id: selection.profileId } : null, action: `browser_${selection.kind}`, revision: stateHash([selection, rows]),
      resources: [...rows.map(row => row.id), ...(native ? [...native.instances, ...native.volumes].map(row => String(row.id)) : [])], blockedBy: rows.flatMap(row => row.blockedBy),
      retained: [...retained, ...(selection.kind === "reset" ? ["Profile ID/assignment remain; all sign-ins, tabs, cookies, storage, cache and history in its old volume are lost. A fresh volume/instance is explicitly created and generation advances"] : []),
        ...(selection.kind === "site" ? ["Domain cookies are shared across matching subdomains and ports; exact observed path/partition keys are selected. CDP usage/target observations are not an atomic native write lock; external clients/pages may recreate data"] : [])],
      regeneration: [selection.kind === "reset" ? "Fresh provider volume/instance under the same profile; explicit later sign-in is required" : "Later explicit browser activity may recreate data; no handoff, navigation, sign-in or paid extraction is admitted"] } };
  }
  async plan(input: Selection) {
    const selection = this.normalize(input); return this.lock(selection, async () => { const prepared = await this.prepare(selection); return this.journal.plan(prepared.preview, selection); });
  }
  async clear(input: StateApplyInput) {
    const previous = this.journal.existing(input); if (previous) return previous;
    const saved = this.journal.getPlan(input.planId), selection = this.normalize(selectionSchema.parse(saved.payload));
    return this.lock(selection, () => this.guarded(selection, async () => {
      const duplicate = this.journal.existing(input); if (duplicate) return duplicate;
      const current = await this.prepare(selection);
      if (saved.plan.revision !== input.expectedRevision || current.preview.revision !== input.expectedRevision) throw new Error("Browser state changed; prepare a new plan");
      if (current.preview.blockedBy.length) throw new Error(current.preview.blockedBy.join("; "));
      this.journal.begin(input, saved.plan); const outcomes: StateOutcome[] = [];
      const progress = (rows: StateOutcome[]) => { outcomes.splice(0, outcomes.length, ...rows); this.journal.finish(input.requestId, "running", outcomes); };
      try {
        if ("profileId" in selection) {
          await this.profiles.stateFence(selection.profileId, input.requestId);
          if (selection.kind === "reset") {
            await this.profiles.stateResetMark(selection.profileId);
            const fresh = await this.backend.stateReset(`profile:${selection.profileId}`, current.native!.revision, progress);
            outcomes.push({ resource: fresh.native!.volumeId, outcome: "retained", detail: `Fresh profile volume ${fresh.native!.volumeName}; fresh instance ${fresh.native!.instanceId}` });
          } else await clearSiteData(this.profiles.stateSource(selection.profileId)!, selection, current.siteRevision!, progress);
        } else if (selection.kind === "handoff") { await this.profiles.stateRedact(selection.ids); outcomes.push(...selection.ids.map(resource => ({ resource, outcome: "removed" as const, detail: "Resolved handoff message/note/issue redacted; identity, request digest, outcome and timing remain" }))); }
        else for (const row of current.rows) { await this.backend.stateCollectVolume(row.id, row.revision); outcomes.push({ resource: row.id, outcome: "removed", detail: "Exact unreferenced/unmounted owned volume absence verified" }); progress(outcomes); }
        if (outcomes.some(row => row.outcome === "unknown")) return this.journal.finish(input.requestId, "partial", outcomes);
        const receipt = this.journal.finish(input.requestId, "completed", outcomes);
        if ("profileId" in selection) await this.profiles.stateRelease(selection.profileId, input.requestId, this.profiles.list().find(row => row.id === selection.profileId)!.generation);
        return receipt;
      } catch {
        if (selection.kind === "site") for (const origin of selection.origins) for (const category of selection.categories) {
          const resource = `${origin}:${category}`;
          if (!outcomes.some(row => row.resource === resource)) outcomes.push({ resource, outcome: "unknown", detail: "Exact category effect was not verified; request never redispatches" });
        }
        if ("profileId" in selection) try { const left = await this.backend.stateProfile(`profile:${selection.profileId}`); for (const row of [...left.instances, ...left.volumes]) outcomes.push({ resource: String(row.id), outcome: "retained", detail: "Provider resource remains after interrupted/partial maintenance; inspect before release" }); } catch { /* unknown provider observation */ }
        return this.journal.finish(input.requestId, outcomes.some(row => row.outcome === "removed") ? "partial" : "unknown", [...outcomes, { resource: input.planId, outcome: "unknown", detail: "Browser effect/recovery proof failed; request never re-executes. Inspect provider resources and exact profile fence." }]);
      } finally { this.profiles.onChange?.(); this.profiles.onHandoffChange?.(); }
    }));
  }
}
export const browseStateOperations = [
  operation({ name: "browser_profile_reset_plan", description: "Preview resetting an exact profile including a Bot default. Retains ID/assignment, advances generation; old sign-ins/tabs/storage disappear and a fresh owned volume/instance is explicitly created. Requires stopped verified Bot, no selected/uncertain controllers or open handoff. Local operator only.", input: profile, output: statePlan, async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "reset", ...input }); } }),
  operation({ name: "browser_site_data_plan", description: "Preview exact HTTP(S) origin/category CDP cleanup. Cookie domain/path/partition identities and storage observations are bound. Cache means origin CacheStorage, not HTTP cache. Persisted history/whole-browser cache are unsupported. Same stopped-Bot/controller/handoff blockers as reset. Planning never launches/navigates. Local operator only.", input: site, output: statePlan, async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "site", ...input }); } }),
  operation({ name: "browser_handoff_history_plan", description: "Preview redaction of exact resolved handoff messages/notes/issues. Open handoffs block. Keep request digests, controller/profile/target IDs, outcome and timing; screenshots/live control URLs are not persisted in this ledger. Other copies remain. Local operator only.", input: z.strictObject({ ids: z.array(z.uuid()).min(1).max(100) }), output: statePlan, async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "handoff", ...input }); } }),
  operation({ name: "browser_volume_list", description: "Read bounded provider-owned volumes with verified Stack names/tags and exact occupancy/reference blockers. Foreign volumes are excluded; unavailable provider is an error, not an empty inventory. No VM starts or byte measurement implied. Local operator only.", input: statePageInput, output: z.strictObject({ volumes: z.array(z.record(z.string(), z.unknown())), revision: z.string(), nextOffset: z.number().int().nullable() }), async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); const inventory = await ctx.backend.stateVolumes(); if (input.revision && input.revision !== inventory.revision) throw new Error("Volume inventory changed; restart paging"); return { volumes: inventory.volumes.slice(input.offset, input.offset + input.limit), revision: inventory.revision, nextOffset: input.offset + input.limit < inventory.volumes.length ? input.offset + input.limit : null }; } }),
  operation({ name: "browser_volume_plan", description: "Preview exact owned orphan volume collection. Full Stack name/session/lease tags required; every durable/disposable/incomplete Backend receipt and every provider mount blocks removal. Rechecks at apply; never removes foreign/occupied volumes or implicitly closes sessions. Local operator only.", input: z.strictObject({ volumeIds: z.array(z.string().min(1).max(256)).min(1).max(100) }), output: statePlan, async call(ctx: BrowserContext, { volumeIds }, invocation) { requireStateOperator(invocation); return ctx.state.plan({ kind: "volume", ids: volumeIds }); } }),
  ...["browser_profile_reset_clear", "browser_site_data_clear", "browser_handoff_history_clear", "browser_volume_clear"].map(name => operation({ name, description: "Apply one exact Browser maintenance plan after lifecycle/native revision recheck. Admission precedes provider/CDP/file effects; identical UUID retries return the original partial/unknown receipt, never rerun. Unknown profile effects remain durably fenced for inspection. No implicit Bot stop/start or sign-in. Local operator only.", input: stateApplyInput, output: stateReceipt, async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); const prior = ctx.state.journal.existing(input); const action = prior?.action ?? ctx.state.journal.getPlan(input.planId).plan.action; const expected = name === "browser_profile_reset_clear" ? "browser_reset" : name === "browser_site_data_clear" ? "browser_site" : name === "browser_handoff_history_clear" ? "browser_handoff" : "browser_volume"; if (action !== expected) throw new Error("Plan/receipt belongs to another Browser action"); return ctx.state.clear(input); } })),
  operation({ name: "browse_state_receipt_get", description: "Read one Browser maintenance receipt, including partial exact provider IDs or unknown interrupted effects. Local operator only.", input: z.strictObject({ requestId: z.uuid() }), output: z.strictObject({ receipt: stateReceipt.nullable() }), async call(ctx: BrowserContext, { requestId }, invocation) { requireStateOperator(invocation); return { receipt: ctx.state.journal.receipt(requestId) }; } }),
  operation({ name: "browse_state_fence_release", description: "After inspecting a partial/unknown/completed receipt and native resources, release only its exact profile/generation fence. Does not complete or rerun maintenance, create a VM, sign in or resume Bot/controller/handoff work. Later supervision may recover retained profile. Local operator only.", input: profile.extend({ requestId: z.uuid(), expectedGeneration: z.number().int().nonnegative() }), output: z.strictObject({ released: z.literal(true) }), async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); return ctx.profiles.maintain(input.profileId, async () => { const receipt = ctx.state.journal.receipt(input.requestId); if (!receipt || receipt.status === "running" || receipt.subject?.id !== input.profileId) throw new Error("Inspect exact terminal profile receipt first"); await ctx.profiles.stateRelease(input.profileId, input.requestId, input.expectedGeneration); return { released: true as const }; }); } }),
  operation({ name: "browse_state_bot_effect", description: "Internal single-use Browser callback held under the assigned Bot's stopped lifecycle mutex. Cannot run without an exact active owner-issued token. Not a standalone cleanup control. Local operator only.", input: z.strictObject({ botId: z.string(), profileId: z.uuid(), token: z.uuid() }), output: z.record(z.string(), z.unknown()), async call(ctx: BrowserContext, input, invocation) { requireStateOperator(invocation); return ctx.state.callback(input); } }),
];
