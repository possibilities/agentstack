import type { Account, Bot, WorkerAccount, WorkerCatalog } from "./types";

export function shortId(id: string | null | undefined, length = 8): string {
  if (!id) return "—";
  return id.length > length + 1 ? id.slice(0, length) : id;
}

/** Stable hue for an identifier, so the same account keeps the same color everywhere. */
export function hueOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return Math.abs(hash) % 360;
}

/** Dense `codex-bot-account-N` labels derived from the current account list order. */
export function accountLabels(accounts: Account[] | null): Map<string, string> {
  return new Map((accounts ?? []).map((account, index) => [account.id, `codex-bot-account-${index + 1}`]));
}

/** Dense per-provider labels in list order: `codex-worker-account-N`, `grok-worker-account-N`, `devin-worker-account-N`, `claude-worker-account-N`. */
export function workerAccountLabels(workers: WorkerAccount[] | null): Map<string, string> {
  const labels = new Map<string, string>();
  const counts = new Map<WorkerAccount["provider"], number>();
  for (const worker of workers ?? []) {
    const next = (counts.get(worker.provider) ?? 0) + 1;
    counts.set(worker.provider, next);
    labels.set(worker.id, `${worker.provider}-worker-account-${next}`);
  }
  return labels;
}

const workerProviderTitles: Record<WorkerAccount["provider"], string> = { codex: "Codex", grok: "Grok", devin: "Devin", claude: "Claude" };
export const workerProviders = Object.keys(workerProviderTitles) as WorkerAccount["provider"][];
/** A Codex Worker account comes with its Codex Bot account, so only these providers are added directly. */
export const addableWorkerProviders = workerProviders.filter((provider) => provider !== "codex");
/** A paired Codex Worker account is removed only with its Codex Bot account. */
export function pairedWorker(account: Pick<WorkerAccount, "provider" | "linkedAccounts">): boolean {
  return account.provider === "codex" && (account.linkedAccounts ?? []).some((link) => link.scope === "bot");
}

export function providerTitle(provider: WorkerAccount["provider"]): string {
  return workerProviderTitles[provider];
}

/** Calendar months (clamped at month end), then elapsed days and smaller units. Keep the two largest units for compact labels. */
function durationParts(from: number, to: number): string {
  const start = new Date(from);
  const end = new Date(to);
  let months = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + end.getUTCMonth() - start.getUTCMonth();
  const afterMonths = (count: number) => {
    const date = new Date(start);
    const month = start.getUTCMonth() + count;
    date.setUTCDate(1);
    date.setUTCMonth(month);
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(start.getUTCDate(), lastDay));
    return date.getTime();
  };
  if (afterMonths(months) > to) months -= 1;
  let minutes = Math.floor((to - afterMonths(months)) / 60_000);
  const days = Math.floor(minutes / 1_440);
  minutes %= 1_440;
  const hours = Math.floor(minutes / 60);
  minutes %= 60;
  const units: Array<[number, string]> = [[Math.floor(months / 12), "y"], [months % 12, "mo"], [days, "d"], [hours, "h"], [minutes, "m"]];
  const parts: string[] = [];
  for (const [value, unit] of units) {
    if (value && parts.length < 2) parts.push(`${value}${unit}`);
  }
  return parts.join(" ") || "0m";
}

export function relativeTime(at: number | null, now: number): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${durationParts(at, now)} ago`;
}

export function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function botsFor(accountId: string, bots: Bot[] | null): Bot[] {
  return (bots ?? []).filter((bot) => bot.account === accountId || bot.runningAccount === accountId);
}

/** Buckets event timestamps into `count` bins ending now. */
export function histogram(times: number[], now: number, count: number, span: number): number[] {
  const bins = new Array<number>(count).fill(0);
  const width = span / count;
  for (const at of times) {
    const age = now - at;
    if (age < 0 || age >= span) continue;
    bins[count - 1 - Math.floor(age / width)] += 1;
  }
  return bins;
}

/** Countdown text for a future instant: "in 1d 16h". Past instants read "now". */
export function untilTime(at: number | null, now: number): string {
  if (at === null || Number.isNaN(at)) return "unknown";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return "now";
  return `in ${durationParts(now, now + minutes * 60_000)}`;
}

/** A catalog model's display name without its routing prefix ("openai/GPT-5" → "GPT-5"). */
export function modelName(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** Every reasoning effort a catalog may advertise, weakest first; "default" is not a level. */
export const effortLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Usage accounts grouped for display. A Worker account linked to a Bot
 * account shares its provider login, so it folds into that Bot's row, which
 * leads with the Bot. It keeps its own row only while that Bot is unobserved
 * and it is not, so no measurement is hidden behind an empty one.
 */
export function usageRows<T extends { id: string; scope: string; linkedAccounts: Array<{ scope: string; id: string }> | null | undefined; usage: unknown }>(accounts: T[]): T[][] {
  const host = (account: T) => account.scope === "worker" ? (account.linkedAccounts ?? []).map((link) => link.scope === "bot"
    ? accounts.find((item) => item.scope === "bot" && item.id === link.id) : undefined)
    .find((bot) => bot && (bot.usage !== null || account.usage === null)) : undefined;
  const hosts = new Map(accounts.map((account) => [account, host(account)]));
  return accounts.filter((account) => !hosts.get(account))
    .map((account) => [account, ...accounts.filter((item) => hosts.get(item) === account)]);
}

/** What a Models tab shows for one Worker account; equal identities render identically. */
export function catalogIdentity(state: { catalog: WorkerCatalog; stale: boolean; error: string | null; unavailable: string | null }): string {
  const { provider, source, runtimeVersion, modelConfigId, models, nativeModelIds } = state.catalog;
  return JSON.stringify([provider, source, runtimeVersion, modelConfigId, models, nativeModelIds, state.stale, state.error, state.unavailable]);
}

/**
 * Worker accounts grouped for the Models window: accounts with the same
 * catalog identity collapse into one stacked tab, in list order. An account
 * without an observed catalog (a null identity) always stands alone.
 */
export function catalogRows<T>(accounts: T[], identity: (account: T) => string | null): T[][] {
  const rows: T[][] = [];
  const byIdentity = new Map<string, T[]>();
  for (const account of accounts) {
    const key = identity(account);
    const row = key === null ? undefined : byIdentity.get(key);
    if (row) {
      row.push(account);
      continue;
    }
    rows.push([account]);
    if (key !== null) byIdentity.set(key, rows[rows.length - 1]);
  }
  return rows;
}

/**
 * Split a command line into arguments the way a shell would for plain text:
 * whitespace separates, single and double quotes group, a backslash escapes
 * the next character (inside double quotes too). Null for an unclosed quote.
 */
export function splitArgs(line: string): string[] | null {
  const args: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += char;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (char === "\\" && i + 1 < line.length) { current += line[++i]; started = true; }
    else if (/\s/.test(char)) { if (started) args.push(current); current = ""; started = false; }
    else { current += char; started = true; }
  }
  if (quote) return null;
  if (started) args.push(current);
  return args;
}

const inferErrors: Record<string, string> = {
  // Admission refusals: nothing started.
  infer_busy: "This account already has a request running. Wait for it to finish.",
  infer_closing: "Inference is shutting down. Try again once it restarts.",
  infer_request_conflict: "That request ID was already used for different input.",
  // Failed requests: definite.
  account_unavailable: "The account is disabled, removed or being removed. Choose another.",
  credentials_unavailable: "The account's Codex sign-in is unavailable. Sign it in again from Accounts.",
  catalog_unavailable: "Model discovery failed. Try discovering again.",
  model_unavailable: "The account no longer offers that model and effort. Discover models again.",
  cancelled: "Cancelled by shutdown before anything was sent.",
  codex_sign_in_required: "Codex rejected the sign-in. Sign the account in again from Accounts.",
  codex_access_denied: "Codex denied this account access to direct inference.",
  codex_rate_limited: "Codex is rate limiting this account. Wait before running again.",
  // Unknown outcomes: may have been charged, never retried.
  infer_interrupted: "Inference restarted while this request was running. It may have been charged and was not retried.",
};
const inferRefusals = new Set(["infer_busy", "infer_closing", "infer_request_conflict"]);

/** Explains an `infer` outcome or refusal code from the request ledger or an admission call. */
export function inferErrorText(code: string): string {
  const status = /^infer_http_error:(\d{3})$/.exec(code);
  if (status) return `The Codex backend answered HTTP ${status[1]}.`;
  if (/^infer_output_budget_exceeded:/.test(code)) return "Generation completed above the token threshold, so it was charged. The output is kept in the request's trace; the threshold is not a spending cap.";
  if (/^infer_outcome_unknown:/.test(code)) return "The request was interrupted after it may have been sent. It may have been charged and was not retried.";
  return inferErrors[code] ?? code;
}

/**
 * Explains a failed `infer_start` call. A deliberate refusal started nothing.
 * Anything else — a lost connection or bridge timeout — leaves admission
 * unconfirmed, and resending the same request ID is safe: it cannot dispatch twice.
 */
export function inferAdmission(message: string): { text: string; uncertain: boolean } {
  if (inferRefusals.has(message)) return { text: inferErrorText(message), uncertain: false };
  return { text: `The request may not have started (${message}). Resending uses the same request ID, so it cannot start twice.`, uncertain: true };
}
