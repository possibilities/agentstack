import type { SpaceId } from "./spaces";
import type { NodeRef, PackageDoc, ServeStateList, ServeSubscriptionPage, StateApplyInput, StateEntry, StateLink, StateOwner, StatePlan, StateReceipt, StateReceiptStatus, StateRelationship } from "./types";

/**
 * Owner state inspection and the shared plan/receipt flow (docs/state-control.md, ADR 0135). Pure and
 * browser-safe: the wire types are mirrored in `types.ts`, never imported from the Node-backed `@stack/api`.
 */

type Call = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

/** Both pagers use the contract's largest page. */
export const statePageLimit = 100;

/** Owners are a selection, never an implied "all known"; null reads every owner the Server lists. */
export type StateSelection = { owners: string[] | null; measure: boolean };

/** Loaded pages of one `serve_state_list` observation. */
export type StateInventory = ServeStateList & {
  selection: StateSelection;
  /** Set when a continuation found the observation changed, so paging started again from the first page. */
  restarted: boolean;
};

export type SubscriptionFilter = { botId?: string; threadId?: string; package?: string };
export type SubscriptionList = ServeSubscriptionPage & { filter: SubscriptionFilter; restarted: boolean };

/** The owner refused a continuation because its observation changed since the first page. */
export function revisionChanged(error: unknown): boolean {
  return error instanceof Error && /restart paging/.test(error.message);
}

function inventoryArgs(selection: StateSelection, offset: number, revision?: string): Record<string, unknown> {
  return { ...(selection.owners ? { owners: selection.owners } : {}), measure: selection.measure, offset, limit: statePageLimit, ...(revision ? { revision } : {}) };
}

export async function loadInventory(call: Call, selection: StateSelection): Promise<StateInventory> {
  const page = await call<ServeStateList>("serve_state_list", inventoryArgs(selection, 0));
  return { ...page, selection, restarted: false };
}

/** The next page of the same observation; a changed observation restarts from the first page rather than mixing revisions. */
export async function continueInventory(call: Call, held: StateInventory): Promise<StateInventory> {
  if (held.nextOffset === null) return held;
  try {
    const page = await call<ServeStateList>("serve_state_list", inventoryArgs(held.selection, held.nextOffset, held.revision));
    return { ...page, entries: [...held.entries, ...page.entries], selection: held.selection, restarted: held.restarted };
  } catch (error) {
    if (!revisionChanged(error)) throw error;
    return { ...await loadInventory(call, held.selection), restarted: true };
  }
}

function subscriptionArgs(filter: SubscriptionFilter, offset: number, revision?: string): Record<string, unknown> {
  const exact = Object.fromEntries(Object.entries(filter).filter(([, value]) => typeof value === "string" && value.length > 0));
  return { ...exact, offset, limit: statePageLimit, ...(revision ? { revision } : {}) };
}

export async function loadSubscriptions(call: Call, filter: SubscriptionFilter): Promise<SubscriptionList> {
  return { ...await call<ServeSubscriptionPage>("serve_subscription_list", subscriptionArgs(filter, 0)), filter, restarted: false };
}

export async function continueSubscriptions(call: Call, held: SubscriptionList): Promise<SubscriptionList> {
  if (held.nextOffset === null) return held;
  try {
    const page = await call<ServeSubscriptionPage>("serve_subscription_list", subscriptionArgs(held.filter, held.nextOffset, held.revision));
    return { ...page, subscriptions: [...held.subscriptions, ...page.subscriptions], filter: held.filter, restarted: held.restarted };
  } catch (error) {
    if (!revisionChanged(error)) throw error;
    return { ...await loadSubscriptions(call, held.filter), restarted: true };
  }
}

/** Bounded pages of one owner observation. */
export type Page<T> = { items: T[]; revision: string; nextOffset: number | null; restarted: boolean };
export type PageRead<T> = (offset: number, revision?: string) => Promise<{ items: T[]; revision: string; nextOffset: number | null }>;

export async function firstPage<T>(read: PageRead<T>): Promise<Page<T>> {
  return { ...await read(0), restarted: false };
}

/** The next page of the same observation, or the first page again when the owner says it changed. */
export async function nextPage<T>(read: PageRead<T>, held: Page<T>): Promise<Page<T>> {
  if (held.nextOffset === null) return held;
  try {
    const page = await read(held.nextOffset, held.revision);
    return { ...page, items: [...held.items, ...page.items], restarted: held.restarted };
  } catch (error) {
    if (!revisionChanged(error)) throw error;
    return { ...await read(0), restarted: true };
  }
}

export type LocalAccess = { available: true } | { available: false; reason: string };

/**
 * Whether this page may call one state operation. State controls are local operator authority: remote Access
 * refuses them even when read-only, and the live WebSocket selection decides what the local gateway forwards.
 */
export function localOperation(state: { remote?: unknown; catalog: { data: PackageDoc[] | null } }, pkg: string, name: string): LocalAccess {
  if (state.remote) return { available: false, reason: "State inspection and maintenance are available only on the local UI." };
  const doc = state.catalog.data?.find((item) => item.name === pkg);
  if (!state.catalog.data) return { available: false, reason: "Reading API discovery…" };
  if (!doc) return { available: false, reason: `${pkg} is not in API discovery.` };
  const websocket = doc.transports.find((transport) => transport.type === "websocket");
  if (!websocket?.operations.includes(name)) return { available: false, reason: `${pkg} does not expose ${name} on its WebSocket.` };
  return { available: true };
}

/** Where each owner's existing controls live. The State window links there rather than acting itself. */
export const ownerHomes: Record<string, { space: SpaceId; title: string }> = {
  bots: { space: "fleet", title: "Fleet" }, worker: { space: "workers", title: "Workers" }, signal: { space: "signal", title: "Signal" },
  infer: { space: "lab", title: "Lab" }, notify: { space: "inbox", title: "Inbox" }, content: { space: "content", title: "Content" },
  proc: { space: "proc", title: "Proc" }, usage: { space: "accounts", title: "Accounts" }, auth: { space: "accounts", title: "Accounts" },
  hud: { space: "hud", title: "HUD" }, brain: { space: "brain", title: "Brain" }, browse: { space: "browse", title: "Browse" },
  roles: { space: "roles", title: "Roles" }, scrape: { space: "scrape", title: "Scrape" }, access: { space: "system", title: "System" },
  serve: { space: "system", title: "System" }, xcom: { space: "system", title: "System" },
};

/** Maintained backend gaps (docs/state-control.md): shown as unsupported, never offered as controls. */
export const ownerGaps: Record<string, string> = {
  worker: "In-place Git reset, native-session reset or purge, transcript-only purge and retained-branch collection are not supported.",
  browse: "Default-profile reset, per-site data clearing, resolved handoff redaction and orphan-volume collection are not supported.",
  brain: "Terminal jobs without documents, source removal or checkpoint reset and stranded-Artifact collection are not supported.",
  scrape: "Queue cancel/retry/discard and corpus or session-state maintenance are not supported.",
  roles: "Retained injection-launch cleanup and standalone settings-receipt retirement are not supported.",
  auth: "Cache-only clearing is not supported; account removal is the control.",
  access: "History and session-specific retirement are not supported; revocation is the control.",
  hud: "Work and journal body purge is not supported.",
  bots: "Queued-body purge is not supported.",
  signal: "Checkpoint reset is not supported.",
  infer: "Catalog-only clearing is not supported.",
  proc: "Payload redaction of removed schedules is not supported.",
  content: "Vault or Git-history purge and temporary publication collection are not supported; remotes and backups keep copies.",
};

/** A link with empty arguments names an operation, not a resource: it is never callable from the inventory. */
export function linkNeedsSelection(link: StateLink): boolean {
  return Object.keys(link.arguments).length === 0;
}

export function operationNode(link: Pick<StateLink, "package" | "operation">): NodeRef {
  return { kind: "operation", pkg: link.package, id: link.operation };
}

/** Relationships to records the Canvas already shows; anything else is listed without a link. */
export function relationshipNode(relation: StateRelationship): NodeRef | null {
  const key = `${relation.package}/${relation.kind}`;
  const kinds: Record<string, NodeRef["kind"]> = {
    "serve/subscription": "subscription", "proc/schedule": "proc-schedule", "proc/run": "proc-run",
    "browse/browser-profile": "browser-profile", "worker/worker": "worker", "bots/bot": "bot",
  };
  const kind = kinds[key];
  return kind ? { kind, id: relation.id } as NodeRef : null;
}

/** Every owner pages its own categories with `<owner>_state_read`. */
export const ownerStateRead = (pkg: string) => `${pkg}_state_read`;

/** Entries grouped under every selected owner, keeping owners with no loaded entries (and unavailable owners) visible. */
export function groupByOwner(inventory: StateInventory): { owner: StateOwner; entries: StateEntry[] }[] {
  return inventory.owners.map((owner) => ({ owner, entries: inventory.entries.filter((entry) => entry.ownerPackage === owner.package) }));
}

/** Measurement words for one nullable count: null is unmeasured, never zero. */
export function measured(value: number | null, format: (value: number) => string): string {
  return value === null ? "unmeasured" : format(value);
}

export type PlanReadiness = { canApply: boolean; blocked: boolean; expired: boolean; reason: string | null };

export function planReadiness(plan: StatePlan, now: number): PlanReadiness {
  const expired = Date.parse(plan.expiresAt) <= now;
  const blocked = plan.blockedBy.length > 0;
  return { canApply: !expired && !blocked, blocked, expired,
    reason: blocked ? "Resolve every blocker, then prepare a new plan." : expired ? "This plan expired. Prepare a new plan to choose again." : null };
}

/** The exact apply input. Owner-specific identity (a Bot's `botId`) is added by the caller, never inferred. */
export function applyInput<Extra extends Record<string, string>>(plan: StatePlan, requestId: string, extra?: Extra): StateApplyInput & Extra {
  return { planId: plan.id, expectedRevision: plan.revision, requestId, ...(extra ?? {}) } as StateApplyInput & Extra;
}

/** Running is still observed; blocked and completed are settled; partial and unknown stay uncertain until inspected. */
export function receiptTone(status: StateReceiptStatus): "success" | "warning" | "destructive" | "info" {
  return status === "completed" ? "success" : status === "running" ? "info" : status === "blocked" ? "destructive" : "warning";
}

export const receiptWords: Record<StateReceiptStatus, string> = {
  running: "Running. Read this receipt again to observe it.",
  completed: "Completed for the declared scope only.",
  partial: "Partial. Some resources were not processed as planned. Inspect them; this request will not run again.",
  blocked: "Blocked. Nothing past the blocker ran.",
  unknown: "Unknown. The owner cannot say what happened. Inspect the exact resources; this request will not run again.",
};

/**
 * The shared maintenance flow: select → prepare → preview → apply → receipt or uncertainty. After a lost or refused
 * apply the same request ID is kept: its receipt is read, and only the identical input may be sent again.
 */
export type StateFlow =
  | { phase: "idle" }
  | { phase: "preparing" }
  | { phase: "prepare-failed"; error: string }
  | { phase: "preview"; plan: StatePlan }
  | { phase: "applying"; plan: StatePlan | null; input: StateApplyInput }
  | { phase: "checking"; plan: StatePlan | null; input: StateApplyInput; error: string | null }
  | { phase: "uncertain"; plan: StatePlan | null; input: StateApplyInput; error: string }
  | { phase: "receipt"; plan: StatePlan | null; input: StateApplyInput; receipt: StateReceipt };

/** Where an apply attempt that returned no receipt goes once its receipt has been read. */
export function afterReceiptRead(flow: Extract<StateFlow, { phase: "checking" }>, receipt: StateReceipt | null, readError?: string): StateFlow {
  if (receipt) return { phase: "receipt", plan: flow.plan, input: flow.input, receipt };
  const reasons = [flow.error, readError ? `Receipt read failed: ${readError}` : "The owner has no receipt for this request ID."]
    .filter((reason): reason is string => Boolean(reason)).map((reason) => /[.!?]$/.test(reason) ? reason : `${reason}.`);
  return { phase: "uncertain", plan: flow.plan, input: flow.input, error: reasons.join(" ") };
}

/** Minimal reload-recovery identity: request, plan and revision IDs plus owner routing identity, never content. */
export type StateRecovery = { input: StateApplyInput & Record<string, string>; at: number };
const recoveryPrefix = "stack.state-flow.";

export function saveRecovery(key: string, input: StateApplyInput & Record<string, string>): void {
  try { localStorage.setItem(recoveryPrefix + key, JSON.stringify({ input, at: Date.now() } satisfies StateRecovery)); } catch { /* recovery is a convenience */ }
}

export function readRecovery(key: string): StateRecovery | null {
  try {
    const value = JSON.parse(localStorage.getItem(recoveryPrefix + key) ?? "null") as StateRecovery | null;
    const input = value?.input;
    if (!input || [input.planId, input.expectedRevision, input.requestId].some((part) => typeof part !== "string")) return null;
    if (Object.values(input).some((part) => typeof part !== "string")) return null;
    return value;
  } catch { return null; }
}

export function clearRecovery(key: string): void {
  try { localStorage.removeItem(recoveryPrefix + key); } catch { /* recovery is a convenience */ }
}

export type StateFlowOptions<Extra extends Record<string, string> = Record<string, never>> = {
  operations: StateOperations<Extra>;
  /** Owner routing identity every apply needs, such as a Bot's `botId`. Never content or credentials. */
  extra?: Extra;
  /** Stable per owner/subject/action; with it, an apply awaiting its receipt is recovered after reload. */
  recoveryKey?: string;
  /** Called with each receipt read, so the owner view can refresh its own reads. */
  onReceipt?(receipt: StateReceipt): void;
};

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One maintenance selection's flow. It calls only the owner operations it was given, captures one request UUID per
 * applied plan, and never re-prepares or re-sends on its own: after a lost or refused apply it reads that request's
 * receipt, and only an explicit `retry` sends the identical input again.
 */
export class StateFlowController<Extra extends Record<string, string> = Record<string, never>> {
  private flow: StateFlow = { phase: "idle" };
  // Each transition gets a token; an older asynchronous result never replaces a newer phase.
  private token = 0;
  private readonly listeners = new Set<() => void>();

  private options: StateFlowOptions<Extra>;
  private readonly clock: { now(): number; uuid(): string };

  constructor(options: StateFlowOptions<Extra>, clock: { now(): number; uuid(): string } = { now: () => Date.now(), uuid: () => crypto.randomUUID() }) {
    this.options = options;
    this.clock = clock;
  }

  /** Newer callbacks and identity for later transitions; the recovery key is fixed per controller. */
  update(options: Omit<StateFlowOptions<Extra>, "recoveryKey">): void { this.options = { ...options, recoveryKey: this.options.recoveryKey }; }
  getState = (): StateFlow => this.flow;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private set(next: StateFlow): void { this.flow = next; for (const listener of this.listeners) listener(); }

  private received(receipt: StateReceipt): void {
    const key = this.options.recoveryKey;
    // Settled results need no recovery; running, partial and unknown stay recoverable until the operator leaves them.
    if (key && (receipt.status === "completed" || receipt.status === "blocked")) clearRecovery(key);
    this.options.onReceipt?.(receipt);
  }

  private check(checking: Extract<StateFlow, { phase: "checking" }>): Promise<void> {
    const mine = ++this.token;
    this.set(checking);
    return this.options.operations.readReceipt(checking.input.requestId).then((receipt) => {
      if (mine !== this.token) return;
      this.set(afterReceiptRead(checking, receipt));
      if (receipt) this.received(receipt);
    }, (error: unknown) => { if (mine === this.token) this.set(afterReceiptRead(checking, null, message(error))); });
  }

  private send(plan: StatePlan | null, input: StateApplyInput & Extra): Promise<void> {
    const mine = ++this.token;
    this.set({ phase: "applying", plan, input });
    return this.options.operations.apply(input).then((receipt) => {
      if (mine !== this.token) return;
      this.set({ phase: "receipt", plan, input, receipt });
      this.received(receipt);
    }, (error: unknown) => {
      // Lost or refused: the owner's receipt, not the transport, says whether it was admitted.
      if (mine === this.token) return this.check({ phase: "checking", plan, input, error: message(error) });
    });
  }

  /** Resume an apply that was awaiting its receipt when the page went away. */
  recover(): Promise<void> {
    const key = this.options.recoveryKey, saved = key ? readRecovery(key) : null;
    return saved ? this.check({ phase: "checking", plan: null, input: saved.input, error: null }) : Promise.resolve();
  }

  /** Ask the owner for a plan. From an uncertain or unsettled result this is an explicit new decision. */
  prepare(): Promise<void> {
    if (this.options.recoveryKey) clearRecovery(this.options.recoveryKey);
    const mine = ++this.token;
    this.set({ phase: "preparing" });
    return this.options.operations.prepare().then((plan) => { if (mine === this.token) this.set({ phase: "preview", plan }); },
      (error: unknown) => { if (mine === this.token) this.set({ phase: "prepare-failed", error: message(error) }); });
  }

  /** Apply the previewed plan with one new request UUID. Blocked or expired plans are refused here too. */
  apply(): Promise<void> {
    const current = this.flow;
    if (current.phase !== "preview" || !planReadiness(current.plan, this.clock.now()).canApply) return Promise.resolve();
    const input = applyInput(current.plan, this.clock.uuid(), this.options.extra);
    if (this.options.recoveryKey) saveRecovery(this.options.recoveryKey, input);
    return this.send(current.plan, input);
  }

  /** Send the identical input again under the same request UUID. */
  retry(): Promise<void> {
    const current = this.flow;
    return current.phase === "uncertain" ? this.send(current.plan, current.input as StateApplyInput & Extra) : Promise.resolve();
  }

  /** Read the same request's receipt again. */
  readReceipt(): Promise<void> {
    const current = this.flow;
    if (current.phase !== "uncertain" && current.phase !== "receipt") return Promise.resolve();
    return this.check({ phase: "checking", plan: current.plan, input: current.input, error: current.phase === "uncertain" ? current.error : null });
  }

  /** An owner invalidation re-reads a running receipt once; it is observation, not a retry. */
  observe(): Promise<void> {
    const current = this.flow;
    return current.phase === "receipt" && current.receipt.status === "running" ? this.check({ phase: "checking", plan: current.plan, input: current.input, error: null }) : Promise.resolve();
  }

  /** Stop applying in-flight results (the view went away) without forgetting a saved request. */
  detach(): void { this.token++; }

  /** Leave the flow; forgets reload recovery. */
  reset(): void {
    if (this.options.recoveryKey) clearRecovery(this.options.recoveryKey);
    this.token++;
    this.set({ phase: "idle" });
  }
}

/**
 * Owner-specific callbacks for the shared flow, from explicitly named operations of one owner. Nothing here routes
 * across owners: the caller names the package, plan, apply and receipt operations and the exact plan selection.
 */
export type StateOperations<Extra extends Record<string, string> = Record<string, never>> = {
  prepare(): Promise<StatePlan>;
  apply(input: StateApplyInput & Extra): Promise<StateReceipt>;
  readReceipt(requestId: string): Promise<StateReceipt | null>;
};

export function stateOperations<Extra extends Record<string, string> = Record<string, never>>(
  call: <T>(pkg: string, name: string, args?: Record<string, unknown>) => Promise<T>,
  pkg: string, names: { plan: string; apply: string; receipt: string }, selection: Record<string, unknown>,
): StateOperations<Extra> {
  return {
    prepare: () => call<StatePlan>(pkg, names.plan, selection),
    apply: (input) => call<StateReceipt>(pkg, names.apply, input),
    readReceipt: async (requestId) => (await call<{ receipt: StateReceipt | null }>(pkg, names.receipt, { requestId })).receipt,
  };
}
