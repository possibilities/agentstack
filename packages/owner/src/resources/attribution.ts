import { createHash } from "node:crypto";
import type { ChildStatus } from "../owner.js";
import { CollectionError, maxOwnedProcesses, type Collection, type ProcessReading } from "./collector.js";
import type { DomainLabel, DomainReading } from "./domains.js";
import type { ResourceCoverage, ResourceMetrics, ResourceProcess, ResourceScope } from "./schema.js";

export type ResourceRoots = { pid: number; attached: boolean; children: ChildStatus[] };
export type ResourceFrame = {
  id: string; collection: Collection; durationMs: number; coverage: ResourceCoverage;
  processes: Map<string, ResourceProcess>; scopes: Map<string, ResourceScope>;
  members: Map<string, Set<string>>;
  // Nearest surviving ancestry parent, including observed links through an exited intermediary.
  parents: Map<string, string | null>;
  children: Map<string, string[]>;
};
const noLabel = { botId: null, accountId: null, runtimeInstance: null, provider: null, attributedAt: null };
const metricKeys = ["rssBytes", "virtualBytes", "cpuTimeMs", "cpuPercent", "threads"] as const;
export function sumMetrics(metrics: Iterable<ResourceMetrics>): ResourceMetrics {
  const total: ResourceMetrics = { processCount: 0, rssBytes: 0, virtualBytes: 0, cpuTimeMs: 0, cpuPercent: 0, cpuMeasuredProcessCount: 0, threads: 0 };
  for (const item of metrics) {
    total.processCount += item.processCount;
    total.cpuMeasuredProcessCount += item.cpuMeasuredProcessCount;
    for (const key of metricKeys) total[key] = total[key] === null || item[key] === null ? null : total[key]! + item[key]!;
  }
  return total;
}
export function intervalCpu(now: ProcessReading, before: ProcessReading | undefined, elapsed: number | undefined): {
  percent: number | null; interval: number | null; status: ResourceProcess["cpuStatus"];
} {
  if (!before || before.id !== now.id) return { percent: null, interval: null, status: "warmup" };
  if (elapsed === undefined || elapsed <= 0 || now.cpuTimeMs < before.cpuTimeMs) return { percent: null, interval: null, status: "reset" };
  return { percent: (now.cpuTimeMs - before.cpuTimeMs) / elapsed * 100, interval: elapsed, status: "measured" };
}
function key(kind: string, name: string): string {
  const encoded = encodeURIComponent(name);
  return `${kind}:${encoded.length <= 200 ? encoded : createHash("sha256").update(name).digest("hex")}`;
}
function scope(id: string, kind: ResourceScope["kind"], name: string, process?: ResourceProcess): ResourceScope {
  return { id, kind, name, component: process?.component ?? null, botId: process?.botId ?? null,
    accountId: process?.accountId ?? null, runtimeInstance: process?.runtimeInstance ?? null, provider: process?.provider ?? null,
    shared: true, metrics: sumMetrics([]) };
}
export function processScope(process: ResourceProcess, subtree: boolean): ResourceScope {
  return { ...scope(subtree ? process.subtreeId : process.id, subtree ? "subtree" : "process", process.name, process), metrics: subtree ? process.subtree : process.self };
}

export function attribute(collection: Collection, roots: ResourceRoots, domains: DomainReading, previous?: ResourceFrame): ResourceFrame {
  const readings = new Map(collection.processes.map((item) => [item.pid, item]));
  const root = readings.get(roots.pid);
  if (!root) throw new CollectionError("owner_missing");
  const previousReadings = new Map(previous?.collection.processes.map((item) => [item.id, item]));
  const byParent = new Map<number, ProcessReading[]>();
  for (const item of readings.values()) {
    const children = byParent.get(item.ppid) ?? [];
    children.push(item);
    byParent.set(item.ppid, children);
  }
  const components = new Map(roots.children.filter((child) => child.running && child.pid && readings.get(child.pid)?.ppid === roots.pid)
    .map((child) => [child.pid!, child.name.slice(0, 160)]));
  const processes = new Map<string, ResourceProcess>();
  const parents = new Map<string, string | null>();
  const queue: Array<{ item: ProcessReading; parent: ResourceProcess | null; retained: boolean }> = [{ item: root, parent: null, retained: false }];
  // Only exact birth identities observed under this attached owner survive reparenting.
  if (roots.attached && previous?.coverage.mode === "owner_tree") {
    for (const old of previous.processes.values()) {
      const item = readings.get(old.pid);
      if (item?.id === old.id && item.id !== root.id) queue.push({ item, parent: null, retained: true });
    }
  }
  // Walk live ancestry first; retained seeds are appended only after that traversal.
  const retained = queue.splice(1);
  let cursor = 0;
  const add = ({ item, parent, retained }: typeof queue[number]) => {
    if (processes.has(item.id)) return;
    if (processes.size >= maxOwnedProcesses) throw new CollectionError("process_limit");
    const old = previous?.processes.get(item.id);
    const cpu = intervalCpu(item, previousReadings.get(item.id), previous && collection.monotonicMs - previous.collection.monotonicMs);
    const self: ResourceMetrics = { processCount: 1, rssBytes: item.rssBytes, virtualBytes: item.virtualBytes, cpuTimeMs: item.cpuTimeMs,
      cpuPercent: cpu.percent, cpuMeasuredProcessCount: cpu.percent === null ? 0 : 1, threads: item.threads };
    const process: ResourceProcess = { id: item.id, subtreeId: item.id.replace(/^process:/, "subtree:"), pid: item.pid, ppid: item.ppid,
      birth: item.birth, name: item.name, parentId: parent?.id ?? null, ancestryParentId: parent?.id ?? old?.ancestryParentId ?? null,
      ownership: item.id === root.id ? "root" : retained ? "retained" : "descendant",
      component: components.get(item.pid) ?? parent?.component ?? old?.component ?? "owner", ...noLabel,
      attribution: "component", cpuIntervalMs: cpu.interval, cpuStatus: cpu.status, self, subtree: self };
    processes.set(item.id, process);
    parents.set(item.id, parent?.id ?? null);
    if (roots.attached) for (const child of byParent.get(item.pid) ?? []) queue.push({ item: child, parent: process, retained: false });
  };
  while (cursor < queue.length) add(queue[cursor++]);
  for (const seed of retained) {
    add(seed);
    while (cursor < queue.length) add(queue[cursor++]);
  }
  // Reconnect retained roots through the prior forest, skipping exited intermediaries.
  for (const process of processes.values()) {
    const observedParent = readings.get(process.ppid);
    process.parentId = observedParent && observedParent.id !== process.id && processes.has(observedParent.id) ? observedParent.id : null;
    if (process.ownership !== "retained") continue;
    let parent = previous?.parents.get(process.id) ?? null;
    const seen = new Set([process.id]);
    while (parent && !processes.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = previous?.parents.get(parent) ?? null;
    }
    parents.set(process.id, parent && !seen.has(parent) ? parent : null);
  }

  // Domain responses only label processes already proved to be beneath the correct component.
  const labels = new Map<string, DomainLabel>();
  const conflicts = new Set<string>();
  for (const label of domains.labels) {
    const reading = readings.get(label.pid);
    const process = reading && processes.get(reading.id);
    if (!process || process.component !== label.component || components.has(process.pid)) {
      const status = domains.statuses.find((item) => item.source === label.component);
      if (status) status.unmatched++;
      continue;
    }
    if (conflicts.has(process.id)) continue;
    if (labels.has(process.id)) {
      // Conflicting records do not establish which domain owns the process.
      labels.delete(process.id);
      conflicts.add(process.id);
      const status = domains.statuses.find((item) => item.source === label.component);
      if (status) status.unmatched += 2;
    } else labels.set(process.id, label);
  }
  const children = new Map<string, string[]>();
  const ordered: string[] = [];
  for (const [id, parent] of parents) {
    if (!parent) ordered.push(id);
    else {
      const siblings = children.get(parent) ?? [];
      siblings.push(id);
      children.set(parent, siblings);
    }
  }
  for (let index = 0; index < ordered.length; index++) ordered.push(...(children.get(ordered[index]) ?? []));
  if (ordered.length !== processes.size) throw new CollectionError("collection_failed");
  // Parent-first iteration avoids recursion limits even for deep process trees.
  for (const id of ordered) {
    const process = processes.get(id)!;
    const parentId = parents.get(process.id);
    const parent = parentId ? processes.get(parentId) : undefined;
    const label = labels.get(process.id);
    const status = domains.statuses.find((item) => item.source === process.component);
    const old = previous?.processes.get(process.id);
    if (label) {
      Object.assign(process, { botId: label.botId, accountId: label.accountId, runtimeInstance: label.runtimeInstance,
        provider: label.provider, attribution: "current", attributedAt: status?.capturedAt ?? collection.capturedAt });
    } else if (parent?.botId || parent?.runtimeInstance) {
      Object.assign(process, { botId: parent.botId, accountId: parent.accountId, runtimeInstance: parent.runtimeInstance,
        provider: parent.provider, attribution: parent.attribution, attributedAt: parent.attributedAt });
    } else if (old && (old.botId || old.runtimeInstance) && (status?.state !== "current" || process.ownership === "retained")) {
      Object.assign(process, { botId: old.botId, accountId: old.accountId, runtimeInstance: old.runtimeInstance,
        provider: old.provider, attribution: "retained", attributedAt: old.attributedAt });
    }
  }

  const scopes = new Map<string, ResourceScope>([["total", scope("total", "total", "AgentStack")]]);
  const members = new Map<string, Set<string>>([["total", new Set(processes.keys())]]);
  const include = (group: ResourceScope, process: ResourceProcess) => {
    if (!scopes.has(group.id)) scopes.set(group.id, group);
    const set = members.get(group.id) ?? new Set();
    set.add(process.id);
    members.set(group.id, set);
  };
  for (const process of processes.values()) {
    include({ ...scope(key("component", process.component), "component", process.component), component: process.component }, process);
    if (process.botId) include({ ...scope(key("bot", process.botId), "bot", process.botId, process), runtimeInstance: null }, process);
    if (process.accountId) {
      const family = process.botId ? "bot" : "worker";
      include({ ...scope(key(`account:${family}`, process.accountId), "account", process.accountId, process), botId: null, runtimeInstance: null }, process);
    }
    if (process.runtimeInstance) include({ ...scope(key("runtime", process.runtimeInstance), "runtime", process.accountId!, process), botId: null }, process);
  }
  for (const group of scopes.values()) group.metrics = sumMetrics([...members.get(group.id)!].map((id) => processes.get(id)!.self));

  // Accumulate each process exactly once into its ancestry tree, not by summing overlapping domain scopes.
  for (const id of ordered.reverse()) {
    const process = processes.get(id)!;
    process.subtree = sumMetrics([process.self, ...(children.get(id) ?? []).map((child) => processes.get(child)!.subtree)]);
  }
  return { id: "", collection: { ...collection, processes: collection.processes.filter((item) => processes.has(item.id)) }, durationMs: 0,
    processes, parents, children, scopes, members,
    coverage: { mode: roots.attached ? "owner_tree" : "self_only", observedHostProcesses: collection.processes.length,
      ownedProcesses: processes.size, unreadableProcesses: collection.unreadableProcesses, vanishedDuringCollection: collection.vanishedDuringCollection,
      excludedCollectorProcesses: collection.excludedCollectorProcesses,
      retainedProcesses: [...processes.values()].filter((item) => item.ownership === "retained").length, domains: domains.statuses } };
}

export function selectScope(frame: ResourceFrame, id: string): { scope: ResourceScope; members: Set<string> } | undefined {
  const group = frame.scopes.get(id);
  if (group) return { scope: group, members: frame.members.get(id)! };
  const subtree = id.startsWith("subtree:");
  const process = frame.processes.get(subtree ? id.replace(/^subtree:/, "process:") : id);
  if (!process) return undefined;
  const members = new Set([process.id]);
  if (subtree) {
    for (const member of members) for (const child of frame.children.get(member) ?? []) members.add(child);
  }
  return { scope: processScope(process, subtree), members };
}

/** History only needs aggregate values; do not enumerate subtree membership for every point. */
export function scopeSummary(frame: ResourceFrame, id: string): ResourceScope | undefined {
  const group = frame.scopes.get(id);
  if (group) return group;
  const subtree = id.startsWith("subtree:");
  const process = frame.processes.get(subtree ? id.replace(/^subtree:/, "process:") : id);
  return process ? processScope(process, subtree) : undefined;
}
