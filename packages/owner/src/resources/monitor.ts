import { randomUUID } from "node:crypto";
import { attribute, processScope, scopeSummary, selectScope, type ResourceFrame, type ResourceRoots } from "./attribution.js";
import { CollectionError, createCollector, type Collector } from "./collector.js";
import { createDomainReader, type DomainReader } from "./domains.js";
import { ownerResourceHistoryInput, ownerResourcesInput, type HistoryInput, type HistoryOutput, type ResourceError,
  type ResourceScope, type ResourcesInput, type ResourcesOutput } from "./schema.js";

type Attempt = { id: string; at: string; error: ResourceError | null; frame: ResourceFrame | null };
export type MonitorOptions = {
  roots: () => ResourceRoots; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform;
  collect?: Collector; domains?: DomainReader; intervalMs?: number; timeoutMs?: number;
  maxSamples?: number; maxProcessRecords?: number;
};
function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
  return value;
}

/** One sampler per owner API context. Reads never trigger a new collection. */
export class ResourceMonitor {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly maxSamples: number;
  readonly maxProcessRecords: number;
  readonly platform: NodeJS.Platform;
  private readonly collect: Collector;
  private readonly domains: DomainReader;
  private readonly runId = randomUUID();
  private sequence = 0;
  private attempts: Attempt[] = [];
  private lastGood: ResourceFrame | undefined;
  private lastAttempt: Attempt | undefined;
  private droppedSamples = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private abort: AbortController | undefined;
  private inFlight: Promise<void> | undefined;
  private started = false;
  private closed = false;
  onChange: (() => void) | undefined;

  constructor(private readonly options: MonitorOptions) {
    this.intervalMs = bounded(options.intervalMs ?? 5_000, 1_000, 60_000, "intervalMs");
    this.timeoutMs = bounded(options.timeoutMs ?? 4_000, 50, 10_000, "timeoutMs");
    this.maxSamples = bounded(options.maxSamples ?? 120, 1, 120, "maxSamples");
    this.maxProcessRecords = bounded(options.maxProcessRecords ?? 50_000, 2_048, 100_000, "maxProcessRecords");
    this.platform = options.platform ?? process.platform;
    this.collect = options.collect ?? createCollector(this.platform);
    this.domains = options.domains ?? createDomainReader(options.env ?? process.env);
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    const tick = async () => {
      const start = performance.now();
      await this.sample(); // sample handles all collection failures, including timer invocations.
      if (!this.closed && this.lastAttempt?.error !== "process_capacity") {
        this.timer = setTimeout(() => { void tick(); }, Math.max(1, this.intervalMs - (performance.now() - start)));
        this.timer.unref();
      }
    };
    void tick();
  }

  /** Internal lifecycle/test hook; deliberately not exposed as an API operation. */
  sample(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.capture().finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async capture(): Promise<void> {
    const start = performance.now();
    const at = new Date().toISOString();
    const id = `${this.runId}:${++this.sequence}`;
    const abort = new AbortController();
    this.abort = abort;
    const timeout = setTimeout(() => abort.abort(new CollectionError("collection_timeout")), this.timeoutMs);
    const attempt: Attempt = { id, at, error: null, frame: null };
    try {
      const roots = this.options.roots();
      // allSettled drains both bounded sources before another cycle or close can proceed.
      const [metrics, labels] = await Promise.allSettled([this.collect(abort.signal), this.domains(roots.attached, abort.signal)]);
      abort.signal.throwIfAborted();
      if (metrics.status === "rejected") throw metrics.reason;
      if (labels.status === "rejected") throw labels.reason;
      const frame = attribute(metrics.value, roots, labels.value, this.lastGood);
      frame.id = id;
      frame.durationMs = performance.now() - start;
      attempt.frame = frame;
    } catch (error) {
      attempt.error = error instanceof CollectionError ? error.code : abort.signal.aborted ? "collection_timeout" : "collection_failed";
    } finally {
      clearTimeout(timeout);
      this.abort = undefined;
    }
    if (this.closed) return;
    if (attempt.frame) this.lastGood = attempt.frame;
    this.lastAttempt = attempt;
    this.attempts.push(attempt);
    let records = this.attempts.reduce((sum, item) => sum + (item.frame?.processes.size ?? 0), 0);
    while (this.attempts.length > this.maxSamples || records > this.maxProcessRecords) {
      records -= this.attempts.shift()!.frame?.processes.size ?? 0;
      this.droppedSamples++;
    }
    // Publication must not turn a timer into an unhandled rejection.
    try { this.onChange?.(); } catch { /* A transport failure does not discard a collected observation. */ }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.abort?.abort(new CollectionError("collection_timeout"));
    await this.inFlight;
    this.onChange = undefined;
    this.attempts = [];
    this.lastGood = undefined;
  }

  private retention(): ResourcesOutput["retention"] {
    return { maxSamples: this.maxSamples, maxProcessRecords: this.maxProcessRecords, retainedSamples: this.attempts.length,
      oldestAttemptAt: this.attempts[0]?.at ?? null, newestAttemptAt: this.attempts.at(-1)?.at ?? null, droppedSamples: this.droppedSamples };
  }

  async resources(input: ResourcesInput = {}): Promise<ResourcesOutput> {
    const query = ownerResourcesInput.parse(input);
    if (this.closed) throw new Error("resources_closed");
    if (!this.lastAttempt) await this.inFlight;
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    if (offset && !query.snapshotId) throw new Error("snapshotId is required for subsequent pages");
    if (query.kind && query.view === "processes") throw new Error("kind is only valid for the scopes view");
    const frame = query.snapshotId
      ? this.attempts.find((item) => item.frame?.id === query.snapshotId)?.frame ?? (this.lastGood?.id === query.snapshotId ? this.lastGood : undefined)
      : this.lastGood;
    if (query.snapshotId && !frame) throw new Error("unknown_or_expired_snapshot");
    const ageMs = frame ? Math.max(0, performance.now() - frame.collection.monotonicMs) : null;
    const error = this.lastAttempt?.error ?? null;
    const result: ResourcesOutput = {
      observation: { snapshotId: frame?.id ?? null, capturedAt: frame?.collection.capturedAt ?? null, ageMs,
        freshness: !frame ? "unavailable" : error || ageMs! > this.intervalMs * 2 + this.timeoutMs ? "stale" : "fresh",
        lastAttemptAt: this.lastAttempt?.at ?? null, error, source: this.platform === "darwin" ? "darwin_ps" : this.platform === "linux" ? "linux_proc" : "unsupported",
        intervalMs: this.intervalMs, staleAfterMs: this.intervalMs * 2 + this.timeoutMs, collectionDurationMs: frame?.durationMs ?? null,
        coverage: frame?.coverage ?? null },
      host: frame?.collection.host ?? null,
      capabilities: { rssBytes: this.platform === "darwin" || this.platform === "linux", virtualBytes: this.platform === "darwin" || this.platform === "linux",
        cpuTimeMs: this.platform === "darwin" || this.platform === "linux", cpuPercent: this.platform === "darwin" || this.platform === "linux", threads: this.platform === "linux",
        diskIoBytes: false, openFileDescriptors: false, networkBytes: false, gpu: false, perSessionAllocation: false },
      retention: this.retention(), scope: null, scopes: [], processes: [], page: { offset, limit, total: 0, nextOffset: null },
    };
    const scopeId = query.scopeId ?? "total";
    if (!frame) {
      if (scopeId !== "total") throw new Error("resources_unavailable");
      return result;
    }
    const selected = selectScope(frame, scopeId);
    if (!selected) throw new Error("unknown_resource_scope");
    result.scope = selected.scope;
    if (query.view === "processes") {
      const rows = [...frame.processes.values()].filter((item) => selected.members.has(item.id)).sort((a, b) => a.pid - b.pid);
      result.processes = rows.slice(offset, offset + limit);
      result.page.total = rows.length;
    } else {
      let rows: ResourceScope[];
      if (query.kind === "process" || query.kind === "subtree") {
        rows = [...frame.processes.values()].filter((item) => selected.members.has(item.id)).map((item) => processScope(item, query.kind === "subtree"));
      } else {
        rows = [...frame.scopes.values()].filter((item) => (!query.kind || query.kind === item.kind)
          && [...frame.members.get(item.id)!].every((id) => selected.members.has(id)));
      }
      rows.sort((a, b) => a.id.localeCompare(b.id));
      result.scopes = rows.slice(offset, offset + limit);
      result.page.total = rows.length;
    }
    result.page.nextOffset = offset + limit < result.page.total ? offset + limit : null;
    return result;
  }

  async history(input: HistoryInput = {}): Promise<HistoryOutput> {
    const query = ownerResourceHistoryInput.parse(input);
    if (this.closed) throw new Error("resources_closed");
    if (!this.lastAttempt) await this.inFlight;
    if (query.since && query.until && Date.parse(query.since) > Date.parse(query.until)) throw new Error("since must not follow until");
    const scopeId = query.scopeId ?? "total";
    if (scopeId !== "total" && !this.attempts.some((item) => item.frame && scopeSummary(item.frame, scopeId))) throw new Error("unknown_or_expired_resource_scope");
    const matching = this.attempts.filter((item) => (!query.since || Date.parse(item.at) >= Date.parse(query.since))
      && (!query.until || Date.parse(item.at) <= Date.parse(query.until)));
    const points = matching.slice(-(query.limit ?? 120)).map((item): HistoryOutput["points"][number] => {
      const selected = item.frame ? scopeSummary(item.frame, scopeId) : undefined;
      return { attemptId: item.id, attemptedAt: item.at, snapshotId: item.frame?.id ?? null, capturedAt: item.frame?.collection.capturedAt ?? null,
        state: !item.frame ? "gap" : selected ? "measured" : "absent", error: item.error,
        metrics: selected?.metrics ?? null, host: item.frame?.collection.host ?? null, coverage: item.frame?.coverage ?? null };
    });
    return { scopeId, intervalMs: this.intervalMs, retention: this.retention(),
      truncated: matching.length > points.length || (this.droppedSamples > 0 && (!query.since || Date.parse(query.since) < Date.parse(this.attempts[0]?.at ?? ""))), points };
  }
}
