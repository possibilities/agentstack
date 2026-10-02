import { formatBytes } from "./resources";
import type { GithubCatalogEntry, GithubDelivery, GithubDeliveryPage, GithubEndpoint, GithubFilter, GithubPredicate, GithubSetup, GithubStatus, GithubTarget } from "./types";

type Tone = "success" | "warning" | "destructive" | "muted" | "info";

/*
 * The Source space's pure logic: filter drafts and their typed serialization, the delivery ledger's paging session,
 * the capacity words, payload reconstruction and the receiver's five separate facts. Nothing here reads the
 * network on its own; the ledger is handed its reads. Payload-derived text is untrusted: callers render it as text.
 */

/* ---------- Filters ---------- */

export type ScalarType = "string" | "number" | "boolean" | "null";
/** `one_of` alone may mix types: each line is then one JSON scalar (`"text"`, `1`, `false`, `null`). */
export type ValueType = ScalarType | "json";
export type PredicateOp = GithubPredicate["op"];
export const predicateOps: { op: PredicateOp; label: string }[] = [
  { op: "equals", label: "equals" }, { op: "one_of", label: "is one of" }, { op: "contains", label: "contains" },
  { op: "starts_with", label: "starts with" }, { op: "exists", label: "exists" },
];
export const scalarTypes: ScalarType[] = ["string", "number", "boolean", "null"];
export const oneOfTypes: ValueType[] = [...scalarTypes, "json"];

export type PredicateDraft = { path: string; op: PredicateOp; type: ValueType; value: string };
export type FilterDraft = {
  endpointIds: string[]; events: string; actions: string; repositories: string; organizations: string; senders: string; refs: string;
  enterprises: string; installationIds: string; repositoryIds: string; predicates: PredicateDraft[];
};
export const emptyDraft: FilterDraft = { endpointIds: [], events: "", actions: "", repositories: "", organizations: "", senders: "", refs: "",
  enterprises: "", installationIds: "", repositoryIds: "", predicates: [] };
export const emptyPredicate: PredicateDraft = { path: "", op: "equals", type: "string", value: "" };

const eventPattern = /^[a-z][a-z0-9_]{0,127}$/;
const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;
const pointerPattern = /^(?:\/(?:[^~]|~[01])*)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const numberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
export const maxFilterJson = 12_000;

/** Comma- or line-separated values: trimmed, empties dropped, duplicates kept once. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))];
}

/** A scalar the owner's predicate accepts, with its JSON type preserved: `false`, `0` and `null` are values, not absences. */
export function typedScalar(type: ValueType, text: string): { ok: true; value: string | number | boolean | null } | { ok: false; error: string } {
  if (type === "null") return { ok: true, value: null };
  if (type === "json") {
    try {
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return { ok: true, value };
    } catch { /* reported below */ }
    return { ok: false, error: `“${text}” is not one JSON string, number, boolean or null` };
  }
  if (type === "string") return text.length > 4000 ? { ok: false, error: "A string value holds at most 4,000 characters" } : { ok: true, value: text };
  if (type === "boolean") return text.trim() === "true" ? { ok: true, value: true } : text.trim() === "false" ? { ok: true, value: false } : { ok: false, error: "A boolean value is exactly true or false" };
  const trimmed = text.trim();
  if (!numberPattern.test(trimmed) || !Number.isFinite(Number(trimmed))) return { ok: false, error: `“${trimmed}” is not a finite number` };
  return { ok: true, value: Number(trimmed) };
}

/** `one_of` values are one per line, so a string may contain a comma. */
export function oneOfLines(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.length > 0);
}

function predicateFrom(draft: PredicateDraft, index: number, errors: string[]): GithubPredicate | null {
  const where = `Predicate ${index + 1}`;
  if (draft.path.length > 1000 || !pointerPattern.test(draft.path) || draft.path.split("/").length > 33) {
    errors.push(`${where}: the path is a JSON Pointer such as /action or /pull_request/head/ref (at most 32 segments)`);
    return null;
  }
  if (draft.op === "exists") {
    if (draft.value !== "true" && draft.value !== "false") { errors.push(`${where}: choose whether the path exists`); return null; }
    return { path: draft.path, op: "exists", value: draft.value === "true" };
  }
  if (draft.op === "starts_with") {
    if (draft.value.length > 1000) { errors.push(`${where}: starts-with takes at most 1,000 characters`); return null; }
    return { path: draft.path, op: "starts_with", value: draft.value };
  }
  if (draft.op === "one_of") {
    const lines = draft.type === "null" ? ["null"] : oneOfLines(draft.value);
    if (!lines.length) { errors.push(`${where}: list at least one value, one per line`); return null; }
    if (lines.length > 50) { errors.push(`${where}: one-of takes at most 50 values`); return null; }
    const values: (string | number | boolean | null)[] = [];
    for (const line of lines) {
      const scalar = typedScalar(draft.type, line);
      if (!scalar.ok) { errors.push(`${where}: ${scalar.error}`); return null; }
      values.push(scalar.value);
    }
    return { path: draft.path, op: "one_of", values };
  }
  const scalar = typedScalar(draft.type, draft.value);
  if (!scalar.ok) { errors.push(`${where}: ${scalar.error}`); return null; }
  return { path: draft.path, op: draft.op, value: scalar.value };
}

/**
 * The owner's filter from a draft: only what was filled in, with every scalar's type preserved. The owner validates
 * authoritatively; these checks stop an obviously invalid session before it starts and say which field is wrong.
 */
export function buildFilter(draft: FilterDraft): { filter: GithubFilter; errors: string[] } {
  const errors: string[] = [];
  const filter: GithubFilter = {};
  const list = (label: string, text: string, ok: (value: string) => boolean, hint: string): string[] | undefined => {
    const values = splitList(text);
    if (!values.length) return undefined;
    const bad = values.find((value) => !ok(value));
    if (bad !== undefined) errors.push(`${label}: “${bad}” ${hint}`);
    if (values.length > 50) errors.push(`${label}: at most 50 values`);
    return values;
  };
  const integers = (label: string, text: string): number[] | undefined => {
    const values = splitList(text);
    if (!values.length) return undefined;
    const parsed = values.map((value) => (/^[1-9]\d*$/.test(value) ? Number(value) : NaN));
    const bad = parsed.findIndex((value) => !Number.isSafeInteger(value));
    if (bad >= 0) errors.push(`${label}: “${values[bad]}” is not a positive whole number`);
    if (values.length > 50) errors.push(`${label}: at most 50 values`);
    return parsed.filter(Number.isSafeInteger);
  };
  if (draft.endpointIds.length) {
    if (draft.endpointIds.length > 50) errors.push("Receivers: at most 50");
    if (draft.endpointIds.some((id) => !uuidPattern.test(id))) errors.push("Receivers: a receiver ID is not a UUID");
    filter.endpointIds = [...draft.endpointIds];
  }
  const events = list("Events", draft.events, (value) => eventPattern.test(value), "is not an event name such as issues or pull_request");
  if (events) filter.events = events;
  const actions = list("Actions", draft.actions, (value) => value.length <= 128, "is longer than 128 characters");
  if (actions) filter.actions = actions;
  const repositories = list("Repositories", draft.repositories, (value) => repositoryPattern.test(value), "is not owner/name");
  if (repositories) filter.repositories = repositories;
  const organizations = list("Organizations", draft.organizations, (value) => namePattern.test(value), "is not an organization login");
  if (organizations) filter.organizations = organizations;
  const enterprises = list("Enterprises", draft.enterprises, (value) => namePattern.test(value), "is not an enterprise slug");
  if (enterprises) filter.enterprises = enterprises;
  const senders = list("Senders", draft.senders, (value) => namePattern.test(value), "is not a login");
  if (senders) filter.senders = senders;
  const installations = integers("Installation IDs", draft.installationIds);
  if (installations?.length) filter.installationIds = installations;
  const repositoryIds = integers("Repository IDs", draft.repositoryIds);
  if (repositoryIds?.length) filter.repositoryIds = repositoryIds;
  const refs = list("Refs", draft.refs, (value) => value.length <= 1000, "is longer than 1,000 characters");
  if (refs) filter.refs = refs;
  if (draft.predicates.length > 32) errors.push("Predicates: at most 32");
  const predicates = draft.predicates.map((item, index) => predicateFrom(item, index, errors)).filter((item): item is GithubPredicate => item !== null);
  if (predicates.length) filter.predicates = predicates;
  if (JSON.stringify(filter).length > maxFilterJson) errors.push(`The filter must fit ${maxFilterJson.toLocaleString("en-US")} characters`);
  return { filter, errors };
}

const sortKeys = (value: unknown): unknown => Array.isArray(value) ? value.map(sortKeys)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]) => [key, sortKeys(item)])) : value;

/** A stable identity for a filter: JSON keeps `false`, `0`, `"false"` and `null` apart. Two keys differ exactly when the owner sees two filters. */
export function filterKey(filter: GithubFilter): string {
  return JSON.stringify(sortKeys(filter));
}

export const filterIsEmpty = (filter: GithubFilter): boolean => Object.keys(filter).length === 0;

export function predicateText(predicate: GithubPredicate): string {
  if (predicate.op === "one_of") return `${predicate.path} is one of ${JSON.stringify(predicate.values)}`;
  const op = predicate.op === "starts_with" ? "starts with" : predicate.op === "exists" ? (predicate.value ? "exists" : "does not exist") : predicate.op;
  return predicate.op === "exists" ? `${predicate.path} ${op}` : `${predicate.path} ${op} ${JSON.stringify(predicate.value)}`;
}

/** The applied filter in words: each field is ANDed with the others, its values are ORed. */
export function describeFilter(filter: GithubFilter, endpointLabel: (id: string) => string = (id) => id): { label: string; values: string[] }[] {
  const out: { label: string; values: string[] }[] = [];
  if (filter.endpointIds) out.push({ label: "Receiver", values: filter.endpointIds.map(endpointLabel) });
  if (filter.events) out.push({ label: "Event", values: filter.events });
  if (filter.actions) out.push({ label: "Action", values: filter.actions });
  if (filter.repositories) out.push({ label: "Repository", values: filter.repositories });
  if (filter.organizations) out.push({ label: "Organization", values: filter.organizations });
  if (filter.enterprises) out.push({ label: "Enterprise", values: filter.enterprises });
  if (filter.senders) out.push({ label: "Sender", values: filter.senders });
  if (filter.refs) out.push({ label: "Ref", values: filter.refs });
  if (filter.installationIds) out.push({ label: "Installation", values: filter.installationIds.map(String) });
  if (filter.repositoryIds) out.push({ label: "Repository ID", values: filter.repositoryIds.map(String) });
  for (const predicate of filter.predicates ?? []) out.push({ label: "Payload", values: [predicateText(predicate)] });
  return out;
}

const typeOf = (value: unknown): ScalarType => value === null ? "null" : typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string";

/** A draft that applies to the filter it was made from (a receiver link sets a filter the form must then show). */
export function draftFromFilter(filter: GithubFilter): FilterDraft {
  return {
    endpointIds: [...(filter.endpointIds ?? [])], events: (filter.events ?? []).join(", "), actions: (filter.actions ?? []).join(", "),
    repositories: (filter.repositories ?? []).join(", "), organizations: (filter.organizations ?? []).join(", "), senders: (filter.senders ?? []).join(", "),
    refs: (filter.refs ?? []).join(", "), enterprises: (filter.enterprises ?? []).join(", "),
    installationIds: (filter.installationIds ?? []).join(", "), repositoryIds: (filter.repositoryIds ?? []).join(", "),
    predicates: (filter.predicates ?? []).map((predicate): PredicateDraft => {
      if (predicate.op === "one_of") {
        const mixed = new Set(predicate.values.map(typeOf)).size > 1;
        return { path: predicate.path, op: "one_of", type: mixed ? "json" : predicate.values.length ? typeOf(predicate.values[0]) : "string",
          value: predicate.values.map((value) => (mixed ? JSON.stringify(value) : value === null ? "null" : String(value))).join("\n") };
      }
      if (predicate.op === "exists") return { path: predicate.path, op: "exists", type: "boolean", value: String(predicate.value) };
      if (predicate.op === "starts_with") return { path: predicate.path, op: "starts_with", type: "string", value: predicate.value };
      return { path: predicate.path, op: predicate.op, type: typeOf(predicate.value), value: predicate.value === null ? "" : String(predicate.value) };
    }),
  };
}

/* ---------- The delivery ledger session ---------- */

export const deliveryPageSize = 25;
const revalidationPage = 50;
const maxRevalidationPages = 40;
const maxDetachedReads = 50;

export type LedgerRead = (input: { after: number; through?: number; limit: number; filter: GithubFilter }) => Promise<GithubDeliveryPage>;
export type LedgerGet = (sequence: number) => Promise<GithubDelivery>;

export type LedgerState = {
  /** Increments with every fresh session; an answer for an older one is dropped. */
  session: number;
  filter: GithubFilter;
  key: string;
  /** The first response's watermark, sent on every later page. Null until the session's first page answers. */
  through: number | null;
  entries: GithubDelivery[];
  /** Exclusive continuation. A short page, even an empty one, does not end the session; only a null cursor does. */
  nextCursor: number | null;
  /** The owner has said the selected sequence ends at `through`. */
  complete: boolean;
  pages: number;
  busy: "first" | "more" | "extend" | "refresh" | null;
  error: string | null;
  /** A cleanup revalidation that failed: the rows shown may still say a payload is retained. */
  refreshError: string | null;
  /** Loaded rows a payload predicate no longer returns because their bodies were cleared. They keep their place, marked. */
  detached: number[];
};

export const initialLedger: LedgerState = { session: 0, filter: {}, key: filterKey({}), through: null, entries: [], nextCursor: null, complete: false, pages: 0,
  busy: null, error: null, refreshError: null, detached: [] };

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * One filtered, oldest-first paging session over `github_delivery_list`. It pins the first response's `through`, follows
 * the exclusive `nextCursor`, never treats a short page as the end, and never moves what is already loaded: newer
 * arrivals extend it only when asked, and a changed filter starts a fresh session.
 */
export class SourceLedger {
  private current: LedgerState = initialLedger;
  private readonly listeners = new Set<() => void>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly read: LedgerRead;
  private readonly get: LedgerGet;
  private readonly limit: number;

  constructor(read: LedgerRead, get: LedgerGet, limit = deliveryPageSize) {
    this.read = read;
    this.get = get;
    this.limit = limit;
  }

  getState = (): LedgerState => this.current;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(patch: Partial<LedgerState>): void { this.current = { ...this.current, ...patch }; for (const listener of this.listeners) listener(); }

  /** A fresh session for `filter`: nothing from the previous one survives, and its watermark is read anew. */
  async start(filter: GithubFilter = this.current.filter): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.dirty = false;
    const session = this.current.session + 1;
    this.current = { ...initialLedger, session, filter, key: filterKey(filter), busy: "first" };
    for (const listener of this.listeners) listener();
    try {
      const page = await this.read({ after: 0, limit: this.limit, filter });
      if (session !== this.current.session) return;
      this.set({ busy: null, through: page.through, entries: page.entries, nextCursor: page.nextCursor, complete: page.nextCursor === null, pages: 1 });
    } catch (error) {
      if (session === this.current.session) this.set({ busy: null, error: message(error) });
    }
    if (session === this.current.session) this.afterBusy();
  }

  /** The next page of the same snapshot, at the pinned watermark. */
  async more(): Promise<void> {
    const state = this.current;
    if (state.busy || state.through === null || state.nextCursor === null) return;
    const { session, through } = state;
    this.set({ busy: "more", error: null });
    try {
      const page = await this.read({ after: state.nextCursor, through, limit: this.limit, filter: state.filter });
      if (session !== this.current.session) return;
      this.set({ busy: null, entries: appendEntries(this.current.entries, page.entries), nextCursor: page.nextCursor, complete: page.nextCursor === null, pages: this.current.pages + 1 });
    } catch (error) {
      if (session === this.current.session) this.set({ busy: null, error: message(error) });
    }
    if (session === this.current.session) this.afterBusy();
  }

  /**
   * Continue past the snapshot's end to newer arrivals. Only a finished snapshot may extend: its scanned range is
   * exactly `through`, so the next range starts there and nothing loaded moves.
   */
  async extend(): Promise<void> {
    const state = this.current;
    if (state.busy || state.through === null || !state.complete) return;
    const { session } = state;
    this.set({ busy: "extend", error: null });
    try {
      const page = await this.read({ after: state.through, limit: this.limit, filter: state.filter });
      if (session !== this.current.session) return;
      this.set({ busy: null, through: Math.max(page.through, state.through), entries: appendEntries(this.current.entries, page.entries), nextCursor: page.nextCursor, complete: page.nextCursor === null, pages: this.current.pages + 1 });
    } catch (error) {
      if (session === this.current.session) this.set({ busy: null, error: message(error) });
    }
    if (session === this.current.session) this.afterBusy();
  }

  /** Ask for a revalidation after the owner's notice. Notices coalesce; a burst re-reads the loaded range once. */
  invalidate(delay = 250): void {
    this.dirty = true;
    if (this.timer || this.current.busy) return;
    this.timer = setTimeout(() => { this.timer = null; void this.revalidate(); }, delay);
  }

  private afterBusy(): void {
    if (this.dirty) { this.dirty = false; void this.revalidate(); }
  }

  /**
   * Re-read the loaded range at its pinned watermark and replace the summaries in place: a cleanup changes `payloadClearedAt`
   * on rows already shown, and arrivals beyond the watermark change nothing loaded. Rows a payload predicate can no longer
   * evaluate are read one by one and marked detached rather than removed.
   */
  async revalidate(): Promise<void> {
    this.dirty = false;
    const state = this.current;
    if (state.busy) { this.dirty = true; return; }
    if (state.through === null || !state.entries.length) return;
    const { session, through, filter } = state;
    const last = state.entries[state.entries.length - 1]!.sequence;
    this.set({ busy: "refresh" });
    try {
      const seen = new Map<number, GithubDelivery>();
      let after = 0;
      for (let pages = 0; pages < maxRevalidationPages; pages++) {
        const page = await this.read({ after, through, limit: revalidationPage, filter });
        if (session !== this.current.session) return;
        for (const entry of page.entries) seen.set(entry.sequence, entry);
        if (page.nextCursor === null || page.nextCursor >= last) break;
        after = page.nextCursor;
      }
      const missing = this.current.entries.filter((entry) => !seen.has(entry.sequence));
      const detached = new Set(this.current.detached);
      if (filter.predicates?.length) {
        for (const entry of missing.slice(0, maxDetachedReads)) {
          try { seen.set(entry.sequence, await this.get(entry.sequence)); detached.add(entry.sequence); } catch { /* the row keeps its last read summary */ }
        }
      }
      if (session !== this.current.session) return;
      this.set({ busy: null, refreshError: null, detached: [...detached].sort((a, b) => a - b), entries: this.current.entries.map((entry) => seen.get(entry.sequence) ?? entry) });
    } catch (error) {
      if (session === this.current.session) this.set({ busy: null, refreshError: message(error) });
    }
    if (session === this.current.session) this.afterBusy();
  }

  dispose(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.listeners.clear(); }
}

function appendEntries(held: GithubDelivery[], more: GithubDelivery[]): GithubDelivery[] {
  const last = held.length ? held[held.length - 1]!.sequence : 0;
  return [...held, ...more.filter((entry) => entry.sequence > last)];
}

/** Whether arrivals newer than the ledger's snapshot exist, and what to tell the reader about them. */
export function newerArrivals(ledger: Pick<LedgerState, "through" | "complete">, latestSequence: number | null): { available: boolean; latest: number | null; canExtend: boolean } {
  if (ledger.through === null || latestSequence === null) return { available: false, latest: latestSequence, canExtend: false };
  return { available: latestSequence > ledger.through, latest: latestSequence, canExtend: latestSequence > ledger.through && ledger.complete };
}

/* ---------- Capacity ---------- */

export type CapacityView = {
  state: "available" | "near" | "refused" | "full";
  tone: Tone;
  word: string;
  countRatio: number;
  bytesRatio: number;
  remainingBytes: number;
  /** A receiver's most recent failure is the owner's storage refusal. */
  refusalObserved: boolean;
  text: string;
};

export const storageFullCode = "github_storage_full";

/** Capacity in explicit words. Reaching either limit means intake is refused with 507; the arrival is never queued or dropped silently. */
export function capacityView(payloads: GithubStatus["payloads"], endpoints: readonly Pick<GithubEndpoint, "lastFailure">[] | null): CapacityView {
  const countRatio = payloads.maxCount ? payloads.count / payloads.maxCount : 0;
  const bytesRatio = payloads.maxBytes ? payloads.bytes / payloads.maxBytes : 0;
  const remainingBytes = Math.max(0, payloads.maxBytes - payloads.bytes);
  const refusalObserved = (endpoints ?? []).some((endpoint) => endpoint.lastFailure === storageFullCode);
  const full = payloads.count >= payloads.maxCount || payloads.bytes >= payloads.maxBytes;
  if (full) return { state: "full", tone: "destructive", word: "Full · intake refused", countRatio, bytesRatio, remainingBytes, refusalObserved,
    text: "Intake refuses every new delivery with 507 github_storage_full. Nothing is queued and nothing already stored is evicted." };
  if (refusalObserved) return { state: "refused", tone: "warning", word: "Refused a delivery", countRatio, bytesRatio, remainingBytes, refusalObserved,
    text: `A receiver's last request was refused with 507 github_storage_full: that body did not fit the ${formatBytes(remainingBytes)} remaining. Smaller bodies are still admitted.` };
  if (countRatio >= 0.8 || bytesRatio >= 0.8) return { state: "near", tone: "warning", word: "Near the limit", countRatio, bytesRatio, remainingBytes, refusalObserved,
    text: "Intake stops at either limit (507 github_storage_full) rather than evicting history." };
  return { state: "available", tone: "success", word: "Space available", countRatio, bytesRatio, remainingBytes, refusalObserved,
    text: "Intake refuses with 507 github_storage_full at either limit rather than evicting history." };
}

/** Why Source needs a person, as space attention lines. */
export function sourceAttention(status: GithubStatus | null, endpoints: readonly GithubEndpoint[] | null): string[] {
  if (!status) return [];
  const view = capacityView(status.payloads, endpoints);
  return view.state === "full" ? ["Payload storage full: intake refused"] : view.state === "refused" ? ["A delivery was refused: storage full"] : [];
}

/* ---------- Receivers ---------- */

export function targetLabel(target: GithubTarget): string {
  switch (target.kind) {
    case "repository": return target.repository;
    case "organization": return target.organization;
    case "enterprise": return target.enterprise;
    case "app": return target.appId ? `App ${target.appId}` : "App";
    case "marketplace": return "Marketplace";
    case "sponsors_listing": return target.account;
  }
}

export const targetKinds: Record<GithubTarget["kind"], string> = { repository: "Repository", organization: "Organization", enterprise: "Enterprise", app: "App", marketplace: "Marketplace", sponsors_listing: "Sponsors" };

export type ReceiverFact = { id: "local" | "public" | "remote" | "receipt" | "arrival"; title: string; word: string; tone: Tone; lines: string[] };

/**
 * The five separate facts about a receiver. None implies another: saved locally is not published, published is not
 * configured at GitHub, a request is not an arrival, and one arrival is not coverage of every selected event.
 */
export function receiverFacts(endpoint: GithubEndpoint, setup: GithubSetup | null, when: (iso: string) => string = (iso) => iso): ReceiverFact[] {
  const local = [`Configuration revision ${endpoint.revision} · secret version ${endpoint.secretVersion}`];
  if (endpoint.previousSecretExpiresAt) local.push(`The previous secret is also accepted until ${when(endpoint.previousSecretExpiresAt)}`);
  const automated = setup?.automatedHookManagement ?? (endpoint.githubHost.toLowerCase() === "github.com" && (endpoint.target.kind === "repository" || endpoint.target.kind === "organization"));
  const arrival: string[] = [];
  if (endpoint.lastPingAt) arrival.push(`Last ping ${when(endpoint.lastPingAt)}`);
  if (endpoint.lastDeliveryAt) arrival.push(`Last delivery ${when(endpoint.lastDeliveryAt)}`);
  arrival.push("A signed arrival proves this request reached Stack, not that every selected event will.");
  return [
    { id: "local", title: "Local configuration", word: endpoint.enabled ? "Enabled" : "Disabled", tone: endpoint.enabled ? "success" : "muted",
      lines: [...local, endpoint.enabled ? "Signed requests are admitted." : "New requests are rejected; history and watches are kept."] },
    { id: "public", title: "Public prerequisite", word: endpoint.webhookUrl ? "Origin set" : "Origin not set", tone: endpoint.webhookUrl ? "info" : "warning",
      lines: [endpoint.webhookUrl ? endpoint.webhookUrl : "No public HTTPS origin: GitHub's cloud cannot reach a loopback or tailnet address.", "Entering an origin is not a reachability test."] },
    { id: "remote", title: "Remote configuration", word: endpoint.managedHookId ? `Hook ${endpoint.managedHookId} recorded` : automated ? "No managed hook recorded" : "Set up by hand",
      tone: endpoint.managedHookId ? "info" : "muted",
      lines: [automated ? "Stack records the hook it last applied; GitHub may have changed since." : "This target is configured manually on GitHub; Stack records nothing about it."] },
    { id: "receipt", title: "Request receipt", word: "None read here", tone: "muted",
      lines: ["Hook plans, pings and redeliveries are not requested from this view. A request being admitted by GitHub would still not be a signed arrival."] },
    { id: "arrival", title: "Signed arrival", word: endpoint.lastDeliveryAt ? "Delivery observed" : endpoint.lastPingAt ? "Ping observed" : "None observed", tone: endpoint.lastDeliveryAt ? "success" : endpoint.lastPingAt ? "info" : "muted", lines: arrival },
  ];
}

/* ---------- Deliveries ---------- */

export const deliveryName = (delivery: Pick<GithubDelivery, "event" | "action">): string => delivery.action ? `${delivery.event}.${delivery.action}` : delivery.event;

/** The first discovered entity, in untrusted words, for a row's subject line. */
export function primaryEntity(delivery: Pick<GithubDelivery, "entities">): string | null {
  const entity = delivery.entities.find((item) => item.title) ?? delivery.entities[0];
  if (!entity) return null;
  const head = entity.number !== null ? `${entity.kind} #${entity.number}` : entity.id !== null ? `${entity.kind} ${entity.id}` : entity.kind;
  return entity.title ? `${head} · ${entity.title}` : head;
}

export function deliverySubject(delivery: Pick<GithubDelivery, "repository" | "organization" | "enterprise" | "sender" | "ref">): string[] {
  return [delivery.repository ?? delivery.organization ?? delivery.enterprise, delivery.ref].filter((item): item is string => Boolean(item));
}

export const contentTypeLabel = (contentType: GithubDelivery["contentType"]): string => contentType === "application/json" ? "JSON" : "form-encoded";

/* ---------- Original payload chunks ---------- */

export const payloadChunkChars = 32_000;
/** Loaded text past this is held and digest-verified but not drawn, so a 25 MiB body cannot freeze the page. */
export const payloadRenderChars = 200_000;

export type PayloadLoad = { sequence: number; chunks: string[]; loaded: number; total: number; nextOffset: number | null; cleared: boolean; sha256: string };

type Chunk = { sequence: number; text: string; totalChars: number; nextOffset: number | null; sha256: string; cleared: boolean };

/**
 * Add one chunk read at `offset`. A chunk for offset 0 starts the load; a later chunk joins only the load it continues. When
 * the body changed under the reader (cleared, another length or digest) it returns null, and the caller reads again from the start
 * rather than splicing two bodies.
 */
export function addChunk(held: PayloadLoad | null, chunk: Chunk, offset: number): PayloadLoad | null {
  if (chunk.cleared) return { sequence: chunk.sequence, chunks: [], loaded: 0, total: chunk.totalChars, nextOffset: null, cleared: true, sha256: chunk.sha256 };
  if (offset === 0) return { sequence: chunk.sequence, chunks: [chunk.text], loaded: chunk.text.length, total: chunk.totalChars, nextOffset: chunk.nextOffset, cleared: false, sha256: chunk.sha256 };
  if (!held || held.cleared || held.sequence !== chunk.sequence || held.total !== chunk.totalChars || held.sha256 !== chunk.sha256 || held.loaded !== offset) return null;
  return { ...held, chunks: [...held.chunks, chunk.text], loaded: held.loaded + chunk.text.length, nextOffset: chunk.nextOffset };
}

export const payloadComplete = (load: PayloadLoad | null): boolean => Boolean(load && !load.cleared && load.nextOffset === null);
export const payloadText = (load: PayloadLoad): string => load.chunks.join("");

export type DigestResult = "verified" | "mismatch" | "unavailable";

/** SHA-256 over the reconstructed text's UTF-8 bytes, compared with the digest the owner recorded. Only meaningful for a complete load. */
export async function verifyDigest(text: string, expected: string): Promise<DigestResult> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return "unavailable";
  const hash = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return hex === expected.toLowerCase().replace(/^sha256[:=]/, "") ? "verified" : "mismatch";
}

/* ---------- Catalog ---------- */

export const hookTypes = ["repository", "organization", "enterprise", "app", "marketplace", "sponsors_listing"] as const;

/** Events whose name, summary or an action's name or description contains every word of the query. A name the catalog does not list is still a valid filter value. */
export function searchCatalog(entries: readonly GithubCatalogEntry[], query: string): GithubCatalogEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...entries];
  return entries.filter((entry) => {
    const haystack = `${entry.event} ${entry.summary} ${entry.actions.map((action) => `${action.action ?? ""} ${action.description}`).join(" ")}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

/** Append a schema chunk to a held read of the same variant and version; any other version starts over, since chunks of two bundles never reassemble. */
export function addSchemaChunk(held: { variant: string; version: string; total: number; text: string; nextOffset: number | null } | null,
  chunk: { variant: string; sourceVersion: string; totalChars: number; text: string; nextOffset: number | null }, offset: number) {
  if (!held || held.variant !== chunk.variant || held.version !== chunk.sourceVersion || held.total !== chunk.totalChars || held.text.length !== offset) {
    return { variant: chunk.variant, version: chunk.sourceVersion, total: chunk.totalChars, text: chunk.text, nextOffset: chunk.nextOffset, restarted: Boolean(held) && offset !== 0 };
  }
  return { ...held, text: held.text + chunk.text, nextOffset: chunk.nextOffset, restarted: false };
}
