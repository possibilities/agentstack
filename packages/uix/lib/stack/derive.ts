import type { Account, Server } from "./types";

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

/** Dense `codex-N` labels derived from the current account list order. */
export function accountLabels(accounts: Account[] | null): Map<string, string> {
  return new Map((accounts ?? []).map((account, index) => [account.id, `codex-${index + 1}`]));
}

export function pathParts(path: string): { head: string; tail: string } {
  const home = path.replace(/^\/Users\/[^/]+/, "~");
  const index = home.lastIndexOf("/");
  return index <= 0 ? { head: "", tail: home } : { head: home.slice(0, index + 1), tail: home.slice(index + 1) };
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

export function serversFor(accountId: string, servers: Server[] | null): Server[] {
  return (servers ?? []).filter((server) => server.account === accountId || server.runningAccount === accountId);
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
