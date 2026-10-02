import type { BrainAdmission, BrainFilters, BrainJob, BrainJobState, BrainJobStats, BrainSource, BrainStatus } from "./types";

/**
 * Remote Access sessions receive only Brain's read-only operations: admission, dispositions,
 * deletion, source control and content reveal stay on the local UI.
 */
export function brainLocalReason(remote: unknown): string | null {
  return remote ? "Available only on the local UI" : null;
}

export type BrainJobView = "attention" | "active" | "done" | "all";

/** Which ledger states each Jobs tab reads. Attention comes first: it is stalled work to decide on. */
export const jobViews: Record<BrainJobView, { title: string; states: BrainJobState[] | null }> = {
  attention: { title: "Needs attention", states: ["failed", "blocked", "retry_wait"] },
  active: { title: "Active", states: ["running", "queued"] },
  done: { title: "Done", states: ["completed", "excluded", "cancelled"] },
  all: { title: "All", states: null },
};

type Tone = "success" | "warning" | "destructive" | "muted" | "info";

export const jobStateView: Record<BrainJobState, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "info" },
  running: { label: "Running", tone: "info" },
  retry_wait: { label: "Waiting to retry", tone: "warning" },
  blocked: { label: "Blocked", tone: "destructive" },
  failed: { label: "Failed", tone: "destructive" },
  completed: { label: "Completed", tone: "success" },
  excluded: { label: "Excluded", tone: "muted" },
  cancelled: { label: "Cancelled", tone: "muted" },
};

export const terminalStates = new Set<BrainJobState>(["completed", "excluded", "cancelled", "failed"]);

/** Operator dispositions each state accepts, mirroring the ledger's legal transitions; the ledger still decides. */
export function jobActions(state: BrainJobState, contentClearedAt?: string | null): Array<"retry" | "cancel" | "exclude"> {
  if (contentClearedAt) return [];
  switch (state) {
    case "failed": case "blocked": case "retry_wait": return ["retry", "cancel", "exclude"];
    case "queued": return ["cancel", "exclude"];
    case "running": return ["cancel"];
    case "cancelled": case "excluded": return ["retry"];
    case "completed": return [];
  }
}

/** Merge several newest-first state lists into one newest-first list without duplicates. */
export function mergeJobs(lists: BrainJob[][]): BrainJob[] {
  const byId = new Map<number, BrainJob>();
  for (const list of lists) for (const job of list) byId.set(job.id, job);
  return [...byId.values()].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id);
}

/** Counts behind each Jobs tab, from `jobs_stats`. */
export function viewCount(stats: BrainJobStats | null, view: BrainJobView): number | null {
  if (!stats) return null;
  const states = jobViews[view].states;
  return states ? states.reduce((sum, state) => sum + (stats.by_state[state] ?? 0), 0) : stats.total;
}

/** What an admission establishes, in Brain's own terms. It never says saved or indexed unless it was. */
export function admissionText(admission: BrainAdmission): string {
  if (admission.status === "already_indexed") return `Already indexed as document ${admission.document_id}`;
  return admission.status === "duplicate" ? `Duplicate of job ${admission.job_id}` : `Admitted as job ${admission.job_id}`;
}

/** A page-local label for something submitted here. Job reads never return the submitted content. */
export function submissionLabel(source: string, kind: "url" | "text", title: string): string {
  if (title.trim()) return title.trim();
  if (kind === "url") {
    try {
      const url = new URL(source.trim());
      return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    } catch { return source.trim(); }
  }
  const line = source.trim().split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line || "Text";
}

/** Only the filters a person actually set, so defaults stay the operation's own. */
export function filterArgs(filters: BrainFilters): Record<string, string> {
  return Object.fromEntries(Object.entries(filters).filter(([, value]) => typeof value === "string" && value.trim()).map(([key, value]) => [key, (value as string).trim()]));
}

export function sourceHost(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "http:" || url.protocol === "https:") return url.host.replace(/^www\./, "");
  } catch { /* not a URL */ }
  return uri.length > 60 ? `${uri.slice(0, 59)}…` : uri;
}

/** A clickable external address: only http(s) URIs open, in a new tab without a referrer. */
export function externalHref(uri: string | null | undefined): string | null {
  if (!uri) return null;
  try {
    const url = new URL(uri);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch { return null; }
}

const healthLabels: Record<string, string> = {
  share_ingress_unhealthy: "Share ingress unhealthy",
  ingestion_worker_failed: "Ingestion worker failed",
  ingestion_maintenance_failed: "Ingestion maintenance failed",
};

/** Human reasons Brain's own status needs attention; empty when the worker runs and health is clear. */
export function statusIssues(status: BrainStatus | null): string[] {
  if (!status) return [];
  const issues: string[] = [];
  if (status.worker !== "running") issues.push(`Ingestion worker ${status.worker}`);
  if (status.health && !(status.health === "ingestion_worker_failed" && status.worker === "failed")) issues.push(healthLabels[status.health] ?? status.health);
  return issues;
}

export const sourceHealthView: Record<BrainSource["health"]["state"], { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "success" },
  warning: { label: "Warning", tone: "warning" },
  unhealthy: { label: "Unhealthy", tone: "destructive" },
  never: { label: "Never run", tone: "muted" },
};

/** A cadence in the largest whole unit: 3600 → "1h", 90 → "90s". */
export function cadence(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export type CallError = { text: string; uncertain: boolean };

/**
 * A rejected Brain call. A timeout or dropped connection may have admitted or changed state, so
 * its outcome is unknown and nothing is resent automatically.
 */
export function brainCallError(error: unknown): CallError {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out|connection closed/i.test(message)) return { text: `Outcome unknown: ${message}`, uncertain: true };
  const [code, ...rest] = message.split("\n");
  if (code === "brain_stopping") return { text: "Brain is stopping", uncertain: false };
  return { text: rest.length ? `${code}: ${rest.join(" ")}` : message, uncertain: false };
}

/**
 * Where a chunk sits in a possibly head/tail-truncated document body. Offsets are exact only for an
 * untruncated body; otherwise the chunk's own text is located. Null when the chunk was omitted.
 */
export function chunkRange(content: string, truncated: boolean, chunk: { start_char: number; end_char: number; content?: string }): [number, number] | null {
  if (!truncated && chunk.end_char <= content.length) return [chunk.start_char, chunk.end_char];
  const text = chunk.content?.trim();
  if (!text) return null;
  const probe = text.slice(0, 160);
  const start = content.indexOf(probe);
  return start < 0 ? null : [start, Math.min(content.length, start + text.length)];
}

/** Split an FTS snippet into plain and matched runs; Brain marks matches with ⟦ and ⟧. */
export function snippetParts(snippet: string): Array<{ text: string; match: boolean }> {
  const parts: Array<{ text: string; match: boolean }> = [];
  const pattern = /⟦([^⟧]*)⟧/g;
  let last = 0;
  for (const found of snippet.matchAll(pattern)) {
    if (found.index > last) parts.push({ text: snippet.slice(last, found.index), match: false });
    parts.push({ text: found[1], match: true });
    last = found.index + found[0].length;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), match: false });
  return parts;
}

/** Plain-text citations for pasting into a chat: one block per hit, in rank order. */
export function contextText(hits: Array<{ citation: string; content: string }>): string {
  return hits.map((hit) => `${hit.citation}\n\n${hit.content.trim()}`).join("\n\n---\n\n");
}
