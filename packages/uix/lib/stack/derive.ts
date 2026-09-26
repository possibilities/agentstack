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

/** Bot↔Worker identity links, derived from the Bot side's `linkedAccounts` for Workers that still exist. */
export function accountLinks(accounts: Account[] | null, workers: WorkerAccount[] | null): Array<{ bot: string; worker: string }> {
  const known = new Set((workers ?? []).map((worker) => worker.id));
  const links: Array<{ bot: string; worker: string }> = [];
  for (const account of accounts ?? [])
    for (const link of account.linkedAccounts ?? [])
      if (link.scope === "worker" && known.has(link.id)) links.push({ bot: account.id, worker: link.id });
  return links;
}

const workerProviderTitles: Record<WorkerAccount["provider"], string> = { codex: "Codex", grok: "Grok", devin: "Devin", claude: "Claude" };
export const workerProviders = Object.keys(workerProviderTitles) as WorkerAccount["provider"][];

export function providerTitle(provider: WorkerAccount["provider"]): string {
  return workerProviderTitles[provider];
}

export function relativeTime(at: number | null, now: number): string {
  if (at === null) return "never";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
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

/** Countdown text for a future instant: "in 3h", "in 5d". Past instants read "now". */
export function untilTime(at: number | null, now: number): string {
  if (at === null || Number.isNaN(at)) return "unknown";
  const minutes = Math.round((at - now) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** A catalog model's display name without its routing prefix ("openai/GPT-5" → "GPT-5"). */
export function modelName(name: string): string {
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

/** Every reasoning effort a catalog may advertise, weakest first; "default" is not a level. */
export const effortLevels = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Usage accounts grouped for display: a Bot account and its linked Worker
 * account share one provider login, so identical observations collapse into
 * one row. Different observations stay separate so neither is hidden.
 */
export function usageRows<T extends { id: string; scope: string; linkedAccounts: Array<{ scope: string; id: string }> | null | undefined; usage: unknown; error: string | null; fresh: boolean }>(accounts: T[]): T[][] {
  const rows: T[][] = [];
  const placed = new Set<string>();
  const key = (account: T) => `${account.scope}:${account.id}`;
  for (const account of accounts) {
    if (placed.has(key(account))) continue;
    placed.add(key(account));
    const row = [account];
    for (const link of account.linkedAccounts ?? []) {
      const twin = accounts.find((item) => item.scope === link.scope && item.id === link.id);
      if (!twin || placed.has(key(twin))) continue;
      if (twin.error !== account.error || twin.fresh !== account.fresh || JSON.stringify(twin.usage) !== JSON.stringify(account.usage)) continue;
      placed.add(key(twin));
      row.push(twin);
    }
    rows.push(row);
  }
  return rows;
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

/** The usage API observes one machine-level Grok Bot login; label it like other accounts. */
export const grokBotLabel = "grok-bot-account-1";
