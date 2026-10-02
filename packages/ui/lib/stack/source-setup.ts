import { splitList, targetLabel } from "./source";
import type { GithubAttempt, GithubDelivery, GithubEndpoint, GithubHook, GithubHookPlan, GithubRemoteReceipt, GithubTarget } from "./types";

type Tone = "success" | "warning" | "destructive" | "muted" | "info";

/*
 * Source setup's pure logic: receiver drafts and their frozen requests, edits, secret rotation, the hook-plan review, and the
 * recovery journal for remote requests (hook apply, ping/test, redelivery). Nothing here reads the network; callers hand it their
 * reads. Secrets are not a concern of this module: a revealed secret is held by one component's state and nowhere else.
 */

/* ---------- Where a receiver is configured ---------- */

export const targetKindList: GithubTarget["kind"][] = ["repository", "organization", "enterprise", "app", "marketplace", "sponsors_listing"];
export const hostIsGithubCom = (host: string): boolean => host.trim().toLowerCase() === "github.com";

/** Whether Stack can configure the hook through gh, and if not, why setup is by hand. Mirrors the owner's own rule. */
export function setupMode(target: GithubTarget, host: string): { automated: true } | { automated: false; reason: string } {
  if (!hostIsGithubCom(host)) return { automated: false, reason: `${host.trim() || "This host"} is not github.com: GitHub Enterprise Server is set up by hand, and Stack makes no network call to it.` };
  if (target.kind === "repository" || target.kind === "organization") return { automated: true };
  const names: Record<string, string> = { enterprise: "An enterprise webhook", app: "An App webhook", marketplace: "A Marketplace webhook", sponsors_listing: "A Sponsors webhook" };
  return { automated: false, reason: `${names[target.kind]} is configured in GitHub's settings by hand; gh automation covers repository and organization hooks only.` };
}

/* ---------- Creating a receiver ---------- */

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/;
const hostPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
export const maxReceiverLabel = 200;
export const maxReceivers = 128;

export type TargetDraft = { kind: GithubTarget["kind"]; repository: string; organization: string; enterprise: string; appId: string; account: string };
export type ReceiverDraft = { id: string; label: string; target: TargetDraft; githubHost: string; publicOrigin: string };
export const emptyTargetDraft: TargetDraft = { kind: "repository", repository: "", organization: "", enterprise: "", appId: "", account: "" };
export const emptyReceiverDraft = (id: string): ReceiverDraft => ({ id, label: "", target: { ...emptyTargetDraft }, githubHost: "github.com", publicOrigin: "" });

export type ReceiverCreateInput = { id: string; label: string; target: GithubTarget; githubHost: string; publicOrigin: string | null };
export type FrozenReceiver = { input: Readonly<ReceiverCreateInput>; json: string };

/** A public origin the way the owner accepts it: https, no credentials, path, query or fragment, and not a loopback name. Blank is unset. */
export function originInput(text: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };
  let url: URL;
  try { url = new URL(trimmed); } catch { return { ok: false, error: "The public origin is not a URL. Use https://hooks.example.com" }; }
  if (url.protocol !== "https:") return { ok: false, error: "The public origin must be https: GitHub does not deliver to plain http." };
  if (url.username || url.password) return { ok: false, error: "The public origin must not carry credentials." };
  if (url.pathname !== "/" || url.search || url.hash) return { ok: false, error: "The public origin is only the origin, with no path, query or fragment: Stack adds the webhook path." };
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return { ok: false, error: "A loopback address is not reachable from GitHub. Use the externally reachable HTTPS origin." };
  return { ok: true, value: url.origin };
}

export function labelInput(text: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Give the receiver a label." };
  if (trimmed.length > maxReceiverLabel) return { ok: false, error: `A label holds at most ${maxReceiverLabel} characters.` };
  return { ok: true, value: trimmed };
}

export function targetInput(draft: TargetDraft): { ok: true; value: GithubTarget } | { ok: false; error: string } {
  switch (draft.kind) {
    case "repository": {
      const repository = draft.repository.trim();
      return repositoryPattern.test(repository) ? { ok: true, value: { kind: "repository", repository } } : { ok: false, error: "A repository is owner/name, for example owner/project." };
    }
    case "organization": {
      const organization = draft.organization.trim();
      return namePattern.test(organization) ? { ok: true, value: { kind: "organization", organization } } : { ok: false, error: "An organization is its login, for example acme." };
    }
    case "enterprise": {
      const enterprise = draft.enterprise.trim();
      return namePattern.test(enterprise) ? { ok: true, value: { kind: "enterprise", enterprise } } : { ok: false, error: "An enterprise is its slug, for example acme-corp." };
    }
    case "sponsors_listing": {
      const account = draft.account.trim();
      return namePattern.test(account) ? { ok: true, value: { kind: "sponsors_listing", account } } : { ok: false, error: "A Sponsors listing is its account login." };
    }
    case "app": {
      const text = draft.appId.trim();
      if (!text) return { ok: true, value: { kind: "app" } };
      return /^[1-9]\d{0,15}$/.test(text) && Number.isSafeInteger(Number(text)) ? { ok: true, value: { kind: "app", appId: Number(text) } } : { ok: false, error: "An App ID is a positive whole number, or leave it empty." };
    }
    case "marketplace": return { ok: true, value: { kind: "marketplace" } };
  }
}

/** The exact request a receiver draft sends, frozen, with what the person should know before sending it. */
export function freezeReceiver(draft: ReceiverDraft, held: number | null): { ok: true; frozen: FrozenReceiver; notes: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.id)) errors.push("The receiver ID is not a UUID.");
  const label = labelInput(draft.label);
  if (!label.ok) errors.push(label.error);
  const target = targetInput(draft.target);
  if (!target.ok) errors.push(target.error);
  const host = draft.githubHost.trim().toLowerCase() || "github.com";
  if (host.length > 253 || !hostPattern.test(host)) errors.push("The GitHub host is a hostname such as github.com or ghe.example.com.");
  const origin = originInput(draft.publicOrigin);
  if (!origin.ok) errors.push(origin.error);
  if (held !== null && held >= maxReceivers) errors.push(`${maxReceivers} receivers exist, the most Stack keeps.`);
  if (errors.length || !label.ok || !target.ok || !origin.ok) return { ok: false, errors };
  const input = Object.freeze({ id: draft.id.toLowerCase(), label: label.value, target: Object.freeze(target.value), githubHost: host, publicOrigin: origin.value });
  const notes: string[] = [];
  const mode = setupMode(target.value, host);
  if (!mode.automated) notes.push(mode.reason);
  if (!origin.value) notes.push("No public origin is set. GitHub's cloud cannot reach a loopback or tailnet address, so nothing will arrive until one is set and the webhook path is published.");
  return { ok: true, frozen: { input, json: JSON.stringify(input, null, 2) }, notes };
}

/** An in-progress creation, persisted before it is sent so a lost answer is read back by its ID rather than guessed at. */
export type CreateRecord = { input: ReceiverCreateInput; at: number };
export const createSlot = "stack.source-setup.create";

/** What reading a receiver back by ID says about a creation whose answer was lost. */
export function createOutcome(endpoint: GithubEndpoint | null, input: ReceiverCreateInput): "created" | "mismatch" | "absent" {
  if (!endpoint) return "absent";
  return JSON.stringify(endpoint.target) === JSON.stringify(input.target) && endpoint.githubHost === input.githubHost ? "created" : "mismatch";
}

/* ---------- Editing and the secret ---------- */

/** The patch for one edit, with only what changed. `null` clears the public origin; the owner treats it as unset. */
export function editPatch(endpoint: Pick<GithubEndpoint, "label" | "publicOrigin" | "enabled">, change: { label?: string; publicOrigin?: string; enabled?: boolean }):
  { ok: true; patch: { label?: string; publicOrigin?: string | null; enabled?: boolean } | null } | { ok: false; error: string } {
  const patch: { label?: string; publicOrigin?: string | null; enabled?: boolean } = {};
  if (change.label !== undefined) {
    const label = labelInput(change.label);
    if (!label.ok) return label;
    if (label.value !== endpoint.label) patch.label = label.value;
  }
  if (change.publicOrigin !== undefined) {
    const origin = originInput(change.publicOrigin);
    if (!origin.ok) return origin;
    if (origin.value !== endpoint.publicOrigin) patch.publicOrigin = origin.value;
  }
  if (change.enabled !== undefined && change.enabled !== endpoint.enabled) patch.enabled = change.enabled;
  return { ok: true, patch: Object.keys(patch).length ? patch : null };
}

export const maxGraceSeconds = 86_400;
export type GraceUnit = "seconds" | "minutes" | "hours";
export type RotateChoice = { mode: "immediate" } | { mode: "grace"; amount: string; unit: GraceUnit };
const unitSeconds: Record<GraceUnit, number> = { seconds: 1, minutes: 60, hours: 3600 };

export function graceWords(seconds: number): string {
  if (seconds % 3600 === 0 && seconds >= 3600) return `${seconds / 3600} ${seconds === 3600 ? "hour" : "hours"}`;
  if (seconds % 60 === 0 && seconds >= 60) return `${seconds / 60} ${seconds === 60 ? "minute" : "minutes"}`;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** The rotation request: immediate revocation unless a grace period was explicitly chosen, never more than 24 hours. */
export function rotateRequest(choice: RotateChoice): { ok: true; graceSeconds: number; words: string } | { ok: false; error: string } {
  if (choice.mode === "immediate") return { ok: true, graceSeconds: 0, words: "The old secret stops being accepted immediately." };
  const text = choice.amount.trim();
  if (!/^[1-9]\d{0,6}$/.test(text)) return { ok: false, error: "Enter a whole number greater than zero for the grace period." };
  const seconds = Number(text) * unitSeconds[choice.unit];
  if (seconds > maxGraceSeconds) return { ok: false, error: "The grace period is at most 24 hours." };
  return { ok: true, graceSeconds: seconds, words: `The old secret is also accepted for ${graceWords(seconds)}; after that only the new one is.` };
}

/* ---------- Hook plan ---------- */

/** The events a hook plan asks for: all of them (`*`, the default) or an explicit list. */
export function eventSelection(mode: "all" | "list", text: string): { ok: true; events: string[] } | { ok: false; error: string } {
  if (mode === "all") return { ok: true, events: ["*"] };
  const events = splitList(text);
  if (!events.length) return { ok: false, error: "List at least one event, such as issues or pull_request." };
  if (events.length > 100) return { ok: false, error: "At most 100 events." };
  const bad = events.find((event) => !/^[a-z][a-z0-9_]{0,127}$/.test(event));
  if (bad !== undefined) return { ok: false, error: `“${bad}” is not an event name. Use names like issues or pull_request (the catalog lists them).` };
  return { ok: true, events };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
export const eventsWords = (events: readonly string[]): string => events.length === 1 && events[0] === "*" ? "All events (*)" : events.join(", ");

export type PlanChange = { label: string; from: string; to: string };
export type PlanReview = {
  planId: string; action: "create" | "update"; headline: string; hookId: number | null; url: string; events: string[]; eventsWords: string;
  /** The hook as GitHub reported it when the inventory was read here; null when it was not read or the plan creates one. */
  current: GithubHook | null; changes: PlanChange[]; unrelated: number | null; consequences: string[];
  expiresAt: string; msLeft: number; expired: boolean;
  /** Why this plan can no longer be applied, or null. The owner refuses it for the same reasons; this says so first. */
  stale: string | null;
};

/** Everything an operator is asked to approve: exactly which hook, what changes there, what stays untouched, and until when. */
export function planReview(plan: GithubHookPlan, hooks: readonly GithubHook[] | null, endpoint: Pick<GithubEndpoint, "revision" | "enabled" | "webhookUrl"> | null, now: number): PlanReview {
  const current = plan.action === "update" ? hooks?.find((hook) => hook.id === plan.hookId) ?? null : null;
  const changes: PlanChange[] = [];
  if (plan.action === "update" && current) {
    if (current.url !== plan.webhookUrl) changes.push({ label: "URL", from: current.url, to: plan.webhookUrl });
    if (!sameSet(current.events, plan.events)) changes.push({ label: "Events", from: eventsWords(current.events), to: eventsWords(plan.events) });
    if (!current.active) changes.push({ label: "Active", from: "inactive", to: "active" });
    if (current.contentType !== "json") changes.push({ label: "Content type", from: current.contentType ?? "unset", to: "json" });
    if (current.insecureSsl !== "0") changes.push({ label: "TLS verification", from: current.insecureSsl === "1" ? "off" : "unset", to: "on" });
  }
  const msLeft = Date.parse(plan.expiresAt) - now;
  const expired = !(msLeft > 0);
  let stale: string | null = null;
  if (endpoint) {
    if (endpoint.revision !== plan.endpointRevision) stale = `The receiver changed after this plan was prepared (revision ${plan.endpointRevision}, now ${endpoint.revision}).`;
    else if (!endpoint.enabled) stale = "The receiver is disabled now.";
    else if (endpoint.webhookUrl !== plan.webhookUrl) stale = "The receiver's webhook URL is not the one this plan sets.";
  }
  return {
    planId: plan.id, action: plan.action, hookId: plan.hookId,
    headline: plan.action === "create" ? "Create a new webhook" : `Update webhook #${plan.hookId}`,
    url: plan.webhookUrl, events: plan.events, eventsWords: eventsWords(plan.events), current, changes,
    unrelated: hooks ? hooks.filter((hook) => hook.id !== plan.hookId).length : null, consequences: plan.consequences,
    expiresAt: plan.expiresAt, msLeft: Math.max(0, msLeft), expired, stale,
  };
}

export const planBlock = (review: PlanReview): string | null => review.expired ? "This plan has expired. Prepare a new one." : review.stale ? `${review.stale} Prepare a new plan.` : null;

/** Mm:ss until expiry, or "expired". */
export function expiryWords(msLeft: number): string {
  if (msLeft <= 0) return "expired";
  const total = Math.ceil(msLeft / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")} left`;
}

/* ---------- Recovery journal ---------- */

/** A storage the journal writes to. Failure to write is reported, never swallowed: a request that cannot be recorded is not sent. */
export type KeyValue = { get(key: string): string | null; set(key: string, value: string): boolean; remove(key: string): void };

export function browserStorage(): KeyValue {
  return {
    get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
    set: (key, value) => { try { localStorage.setItem(key, value); return localStorage.getItem(key) === value; } catch { return false; } },
    remove: (key) => { try { localStorage.removeItem(key); } catch { /* nothing to remove */ } },
  };
}

export function memoryStorage(): KeyValue & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return { entries, get: (key) => entries.get(key) ?? null, set: (key, value) => { entries.set(key, value); return true; }, remove: (key) => { entries.delete(key); } };
}

export type RemoteKind = "apply" | "ping" | "test" | "redeliver";
export const remoteKindWords: Record<RemoteKind, string> = { apply: "Hook configuration", ping: "Ping", test: "Push test", redeliver: "Redelivery" };
/** `pending`: persisted and sent, no answer seen. `absent`: the owner has no record, so it never went to GitHub. The rest are the owner's own receipt statuses. */
export type JournalStatus = "pending" | "running" | "succeeded" | "failed" | "unknown" | "absent";
export type JournalEntry = {
  requestId: string; endpointId: string; kind: RemoteKind; at: number; intent: string; status: JournalStatus;
  planId?: string; hookId?: number; attemptId?: number; guid?: string;
  startedAt: string | null; completedAt: string | null; error: string | null;
};
const journalPrefix = "stack.source-setup.requests.";
export const journalKey = (endpointId: string): string => journalPrefix + endpointId;
const keepSettled = 12;
const unsettled = (entry: JournalEntry) => entry.status === "pending" || entry.status === "running" || entry.status === "unknown";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set<string>(["pending", "running", "succeeded", "failed", "unknown", "absent"]);
const kinds = new Set<string>(["apply", "ping", "test", "redeliver"]);

function valid(value: unknown): value is JournalEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.requestId === "string" && uuid.test(entry.requestId) && typeof entry.endpointId === "string" && typeof entry.kind === "string" && kinds.has(entry.kind)
    && typeof entry.at === "number" && typeof entry.intent === "string" && typeof entry.status === "string" && statuses.has(entry.status);
}

const listeners = new Set<() => void>();
let version = 0;
/** Changes whenever any journal is written, so a view can re-read. */
export const journalVersion = (): number => version;
export function onJournalChange(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
const changed = () => { version++; for (const listener of listeners) listener(); };

export function readJournal(kv: KeyValue, endpointId: string): JournalEntry[] {
  try {
    const parsed: unknown = JSON.parse(kv.get(journalKey(endpointId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid).filter((entry) => entry.endpointId === endpointId).sort((a, b) => a.at - b.at) : [];
  } catch { return []; }
}

function writeJournal(kv: KeyValue, endpointId: string, entries: JournalEntry[]): boolean {
  const open = entries.filter(unsettled), done = entries.filter((entry) => !unsettled(entry)).slice(-keepSettled);
  const kept = [...open, ...done].sort((a, b) => a.at - b.at);
  if (!kept.length) { kv.remove(journalKey(endpointId)); changed(); return true; }
  const ok = kv.set(journalKey(endpointId), JSON.stringify(kept));
  if (ok) changed();
  return ok;
}

/** Record a request before it is sent. False means it could not be recorded, and the caller must not send it. */
export function begin(kv: KeyValue, entry: JournalEntry): boolean {
  const entries = readJournal(kv, entry.endpointId).filter((held) => held.requestId !== entry.requestId);
  return writeJournal(kv, entry.endpointId, [...entries, entry]);
}

/** Fold what the owner says into the entry. A receipt is the owner's word; `null` is the owner having no record of that ID. */
export function settle(kv: KeyValue, endpointId: string, requestId: string, receipt: GithubRemoteReceipt | null, error: string | null = null): JournalEntry | null {
  const entries = readJournal(kv, endpointId);
  const held = entries.find((entry) => entry.requestId === requestId);
  if (!held) return null;
  const next: JournalEntry = receipt
    ? { ...held, status: receipt.status, startedAt: receipt.startedAt, completedAt: receipt.completedAt, error: receipt.error, hookId: receipt.hookId ?? held.hookId }
    : { ...held, status: "absent", error: error ?? held.error };
  writeJournal(kv, endpointId, entries.map((entry) => entry.requestId === requestId ? next : entry));
  return next;
}

export function forget(kv: KeyValue, endpointId: string, requestId: string): void {
  writeJournal(kv, endpointId, readJournal(kv, endpointId).filter((entry) => entry.requestId !== requestId));
}

export type RemoteIo = {
  dispatch(entry: JournalEntry): Promise<GithubRemoteReceipt>;
  readReceipt(requestId: string): Promise<GithubRemoteReceipt | null>;
};
export type RemoteOutcome =
  | { sent: false; reason: string }
  | { sent: true; entry: JournalEntry; receipt: GithubRemoteReceipt | null; error: string | null; readError: string | null };

const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Read what the owner recorded for this exact request ID, and nothing else: never a second dispatch, never a new ID. A receipt settles
 * the entry; no receipt means the owner never began it, so it never reached GitHub; a failed read leaves the entry as it was.
 */
export async function recover(kv: KeyValue, io: RemoteIo, entry: JournalEntry, error: string | null = null): Promise<RemoteOutcome> {
  try {
    const receipt = await io.readReceipt(entry.requestId);
    const next = settle(kv, entry.endpointId, entry.requestId, receipt, error) ?? entry;
    return { sent: true, entry: next, receipt, error, readError: null };
  } catch (readError) {
    return { sent: true, entry: readJournal(kv, entry.endpointId).find((held) => held.requestId === entry.requestId) ?? entry, receipt: null, error, readError: errorText(readError) };
  }
}

/**
 * Persist the request, send it once, and settle it. Any failure to get an answer (an error, a closed connection) is resolved by reading
 * the receipt for the same request ID; this function never dispatches twice.
 */
export async function sendRemote(kv: KeyValue, io: RemoteIo, entry: JournalEntry): Promise<RemoteOutcome> {
  if (!begin(kv, entry)) return { sent: false, reason: "This browser could not record the request, so it was not sent. Stack never sends a hook request it cannot recover." };
  try {
    const receipt = await io.dispatch(entry);
    const next = settle(kv, entry.endpointId, entry.requestId, receipt) ?? entry;
    return { sent: true, entry: next, receipt, error: null, readError: null };
  } catch (error) {
    return recover(kv, io, entry, errorText(error));
  }
}

/** The exact operation arguments for a recorded request: the same request ID, the same inputs, never a different intent. */
export function resendArguments(entry: JournalEntry): { name: string; args: Record<string, unknown> } | null {
  if (entry.kind === "apply") return entry.planId ? { name: "github_hook_apply", args: { planId: entry.planId, requestId: entry.requestId } } : null;
  if (!entry.hookId) return null;
  if (entry.kind === "redeliver") return entry.attemptId ? { name: "github_hook_redeliver", args: { endpointId: entry.endpointId, hookId: entry.hookId, deliveryId: entry.attemptId, requestId: entry.requestId } } : null;
  return { name: "github_hook_probe", args: { endpointId: entry.endpointId, hookId: entry.hookId, requestId: entry.requestId, action: entry.kind === "test" ? "test" : "ping" } };
}

/** Only a request the owner never recorded can be sent again, and only with its own ID. Anything that may have reached GitHub is never sent again. */
export const canSendAgain = (entry: JournalEntry): boolean => entry.status === "absent" && resendArguments(entry) !== null;
export const canReadReceipt = (entry: JournalEntry): boolean => entry.status === "pending" || entry.status === "running" || entry.status === "unknown";

const codeWords: Record<string, string> = {
  github_gh_not_installed: "gh is not installed on this machine.", github_gh_spawn_failed: "gh could not be started.", github_gh_request_failed: "gh failed without a usable answer.",
  github_installation_fenced: "The installation is fenced (a reset or reinstall is in progress).", github_stopping: "The Source owner is stopping.",
  github_native_request_capacity: "Too many gh requests are running; none was started.", github_request_interrupted: "The gh request was interrupted before it finished.",
  github_response_too_large: "GitHub's answer was larger than Stack reads.", github_response_invalid: "GitHub's answer was not understood.",
  github_http_401: "GitHub did not accept gh's credentials (401).", github_http_403: "GitHub refused: gh's account lacks permission here (403).", github_http_404: "GitHub could not find it, or gh's account cannot see it (404).",
  github_http_422: "GitHub rejected the request as invalid (422).", github_http_429: "GitHub is rate limiting this account (429).",
};
/** A sanitized error code in words. Provider text never reaches the UI; unknown codes are shown as the code. */
export function errorWords(code: string | null | undefined): string | null {
  if (!code) return null;
  const known = codeWords[code];
  if (known) return known;
  if (code.startsWith("owner_interrupted")) return "The owner was interrupted while this request was running. It will not run again.";
  return code;
}

export function entryWords(entry: JournalEntry): { word: string; tone: Tone; text: string } {
  const what = remoteKindWords[entry.kind].toLowerCase();
  const detail = errorWords(entry.error);
  switch (entry.status) {
    case "succeeded":
      return { word: "Admitted by GitHub", tone: "success", text: entry.kind === "apply"
        ? `GitHub accepted the hook configuration${entry.hookId ? ` (hook #${entry.hookId})` : ""}. That is configuration, not delivery verification: nothing has been shown to arrive.`
        : `GitHub accepted the ${what} request. That is admission, not arrival: a signed delivery arriving at Stack is a separate fact.` };
    case "failed":
      return { word: "Refused", tone: "destructive", text: `GitHub refused the ${what} request, so it did not take effect.${detail ? ` ${detail}` : ""}` };
    case "unknown":
      return { word: "Outcome unknown", tone: "warning", text: `The ${what} request may or may not have reached GitHub.${detail ? ` ${detail}` : ""} It will not run again. Inspect GitHub before asking for anything new.` };
    case "running":
      return { word: "Running", tone: "info", text: `The owner is still running the ${what} request.` };
    case "absent":
      return { word: "Never sent", tone: "muted", text: `Stack has no record of this ${what} request, so it never reached GitHub.${entry.error ? ` The answer it got: ${entry.error}` : ""}` };
    case "pending":
      return { word: "Not confirmed", tone: "warning", text: `The ${what} request was sent from this browser and no answer was seen. Read its receipt to learn what happened; it is never sent again under a new ID.` };
  }
}

/** The receiver's "Request receipt" fact from what this browser's journal holds: requests, as the owner answered them, and no more. */
export function requestFact(entries: readonly JournalEntry[], when: (at: number) => string): { word: string; tone: Tone; lines: string[] } {
  if (!entries.length) return { word: "None recorded", tone: "muted", lines: ["No hook, ping or redelivery request is recorded in this browser. A request being admitted by GitHub would still not be a signed arrival."] };
  const latest = entries[entries.length - 1]!;
  const view = entryWords(latest);
  const lines = entries.slice(-3).reverse().map((entry) => `${remoteKindWords[entry.kind]} ${entry.requestId.slice(0, 8)} · ${entryWords(entry).word} · ${when(entry.at)}`);
  lines.push("Requests are what this browser sent and the owner's receipt for each; a request is not an arrival.");
  return { word: view.word, tone: view.tone, lines };
}

/* ---------- Probes and attempts ---------- */

/**
 * Whether a signed arrival was observed since a probe request began. A ping is judged by `lastPingAt`; a push test by `lastDeliveryAt`
 * (any signed delivery). Observed after is consistent with the request and does not prove it caused the arrival.
 */
export function probeArrival(entry: Pick<JournalEntry, "kind" | "startedAt" | "at">, endpoint: Pick<GithubEndpoint, "lastPingAt" | "lastDeliveryAt">): { observed: boolean; at: string | null; label: string } {
  const since = entry.startedAt ? Date.parse(entry.startedAt) : entry.at;
  const arrival = entry.kind === "ping" ? endpoint.lastPingAt : endpoint.lastDeliveryAt;
  const label = entry.kind === "ping" ? "signed ping" : "signed delivery";
  if (arrival && Date.parse(arrival) >= since) return { observed: true, at: arrival, label };
  return { observed: false, at: arrival ?? null, label };
}

export const attemptOk = (attempt: Pick<GithubAttempt, "statusCode">): boolean => attempt.statusCode >= 200 && attempt.statusCode < 300;
export const attemptName = (attempt: Pick<GithubAttempt, "event" | "action">): string => attempt.action ? `${attempt.event}.${attempt.action}` : attempt.event;

/** Local sequence by upstream GUID, among deliveries received by this receiver. GitHub's attempt ID is not a Stack sequence; the GUID is the shared key. */
export function correlateAttempts(attempts: readonly Pick<GithubAttempt, "guid">[], local: readonly Pick<GithubDelivery, "sequence" | "deliveryId" | "endpointId">[], endpointId: string): Record<string, number> {
  const byGuid = new Map<string, number>();
  for (const delivery of local) if (delivery.endpointId === endpointId && !byGuid.has(delivery.deliveryId)) byGuid.set(delivery.deliveryId, delivery.sequence);
  const found: Record<string, number> = {};
  for (const attempt of attempts) { const sequence = byGuid.get(attempt.guid); if (sequence !== undefined) found[attempt.guid] = sequence; }
  return found;
}

export const correlationSpan = 500;
/** The exclusive local cursor a correlation read starts after, looking `back` sequences behind the newest arrival. */
export const correlationStart = (latest: number, back: number): number => Math.max(0, latest - back);

/** Hooks first: the managed or URL-matching hook leads, and the rest are listed as untouched. */
export function orderHooks(hooks: readonly GithubHook[], endpoint: Pick<GithubEndpoint, "managedHookId" | "webhookUrl">): { hook: GithubHook; role: "managed" | "matching" | "other" }[] {
  const role = (hook: GithubHook) => hook.id === endpoint.managedHookId ? "managed" as const : hook.url === endpoint.webhookUrl ? "matching" as const : "other" as const;
  const rank = { managed: 0, matching: 1, other: 2 };
  return hooks.map((hook) => ({ hook, role: role(hook) })).sort((a, b) => rank[a.role] - rank[b.role] || a.hook.id - b.hook.id);
}

/** A receiver's one-line destination for confirmations. */
export const receiverName = (endpoint: Pick<GithubEndpoint, "label" | "target">): string => `${endpoint.label} (${targetLabel(endpoint.target)})`;
