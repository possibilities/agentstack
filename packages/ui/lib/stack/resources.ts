import type { NodeRef, ServerResources, ResourceHistoryPoint, ResourceProcess, ResourceRetention, ResourceScope } from "./types";

type Read = <T>(name: string, args?: Record<string, unknown>) => Promise<T>;

/** The wire page shape of `serve_resources`; the store keeps only selected slices of it. */
type ResourcesPage = {
  observation: ServerResources["observation"];
  host: ServerResources["host"];
  capabilities: ServerResources["capabilities"];
  retention: ServerResources["retention"];
  runtime: ServerResources["runtime"];
  scopes: ResourceScope[];
  processes: ResourceProcess[];
  page: { offset: number; limit: number; total: number; nextOffset: number | null };
};

/**
 * One full resource read: every scope of the default `total` selection, then
 * its member processes, all pages pinned to the first page's snapshot.
 */
export async function loadResources(read: Read, { maxProcesses = 1000 }: { maxProcesses?: number } = {}): Promise<ServerResources> {
  const first = await read<ResourcesPage>("serve_resources", { view: "scopes", limit: 100 });
  const scopes = [...first.scopes];
  const snapshotId = first.observation.snapshotId;
  let next = first.page.nextOffset;
  while (next !== null) {
    const page = await read<ResourcesPage>("serve_resources", { snapshotId, view: "scopes", offset: next, limit: 100 });
    scopes.push(...page.scopes);
    next = page.page.nextOffset;
  }
  const processes: ResourceProcess[] = [];
  let processTotal = 0;
  if (snapshotId !== null) {
    next = 0;
    do {
      const page: ResourcesPage = await read("serve_resources", { snapshotId, view: "processes", ...(next ? { offset: next } : {}), limit: 100 });
      processTotal = page.page.total;
      processes.push(...page.processes);
      next = page.page.nextOffset;
    } while (next !== null && processes.length < maxProcesses);
    processes.length = Math.min(processes.length, maxProcesses);
  }
  return { observation: first.observation, host: first.host, capabilities: first.capabilities,
    retention: first.retention, runtime: first.runtime, scopes, processes, processTotal };
}

/**
 * Union by attemptId, oldest first. Points older than the server's retained
 * boundary are dropped and the result stays within the 120-point window.
 */
export function mergeHistory(existing: ResourceHistoryPoint[], incoming: ResourceHistoryPoint[], retention: ResourceRetention): ResourceHistoryPoint[] {
  const merged = new Map<string, ResourceHistoryPoint>();
  for (const point of [...existing, ...incoming]) merged.set(point.attemptId, point);
  const oldest = retention.oldestAttemptAt ? Date.parse(retention.oldestAttemptAt) : null;
  return [...merged.values()]
    .filter((point) => oldest === null || Date.parse(point.attemptedAt) >= oldest)
    .sort((a, b) => Date.parse(a.attemptedAt) - Date.parse(b.attemptedAt))
    .slice(-120);
}

export type ProcessTreeRow = { process: ResourceProcess; depth: number; hasChildren: boolean };

/**
 * Depth-first rows of the observed process tree. A process joins its currently
 * observed parent, else its last observed one, else becomes a root. Children
 * sort by pid. Cycles and unreachable remnants are appended as extra roots
 * rather than dropping records.
 */
export function processTree(processes: ResourceProcess[]): ProcessTreeRow[] {
  const byId = new Map(processes.map((process) => [process.id, process]));
  const children = new Map<string | null, ResourceProcess[]>();
  const parentOf = (process: ResourceProcess): string | null =>
    process.parentId && byId.has(process.parentId) ? process.parentId
      : process.ancestryParentId && byId.has(process.ancestryParentId) ? process.ancestryParentId : null;
  for (const process of processes) {
    const siblings = children.get(parentOf(process)) ?? [];
    siblings.push(process);
    children.set(parentOf(process), siblings);
  }
  for (const siblings of children.values()) siblings.sort((a, b) => a.pid - b.pid);
  const rows: ProcessTreeRow[] = [];
  const seen = new Set<string>();
  const stack: { process: ResourceProcess; depth: number }[] = [];
  const push = (process: ResourceProcess, depth: number) => stack.push({ process, depth });
  const walk = () => {
    while (stack.length) {
      const { process, depth } = stack.pop()!;
      if (seen.has(process.id)) continue;
      seen.add(process.id);
      const below = children.get(process.id) ?? [];
      rows.push({ process, depth, hasChildren: below.length > 0 });
      for (let i = below.length - 1; i >= 0; i -= 1) push(below[i], depth + 1);
    }
  };
  for (const root of [...(children.get(null) ?? [])].reverse()) push(root, 0);
  walk();
  // A parent loop leaves its members off every root's walk; surface them anyway.
  for (const process of [...processes].sort((a, b) => a.pid - b.pid)) {
    if (seen.has(process.id)) continue;
    push(process, 0);
    walk();
  }
  return rows;
}

/** The record a resource scope points at on the bench, if it has a destination. */
export function scopeTarget(scope: ResourceScope): NodeRef | null {
  switch (scope.kind) {
    case "component":
      return scope.component === "server" || scope.component === null ? { kind: "server" } : { kind: "child", id: scope.component };
    case "bot":
      return scope.botId ? { kind: "bot", id: scope.botId } : null;
    case "account":
      if (scope.id.startsWith("account:bot:")) return scope.accountId ? { kind: "account", id: scope.accountId } : null;
      if (scope.id.startsWith("account:worker:")) return scope.accountId ? { kind: "worker-account", id: scope.accountId } : null;
      return null;
    case "runtime":
      return scope.accountId ? { kind: "worker-account", id: scope.accountId } : null;
    case "process":
      return { kind: "process", id: scope.id };
    default:
      return null;
  }
}

const byteUnits = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] as const;

/** Binary units, null-friendly: 831 MiB, 1.4 GiB. */
export function formatBytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < byteUnits.length - 1) { scaled /= 1024; unit += 1; }
  if (unit === 0) return `${Math.round(scaled)} ${byteUnits[unit]}`;
  const text = scaled >= 100 || Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1);
  return `${text} ${byteUnits[unit]}`;
}

/** Whole percent once it reaches double digits; unavailable is a dash, never a zero. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}%`;
}

/** Compact durations: 45s, 12m, 3h 4m, 2d 5h. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`;
}
