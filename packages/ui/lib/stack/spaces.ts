import { accountLabels, workerAccountLabels } from "./derive";
import { workerAttention, workerLabel } from "./workers";
import { browseAttention } from "./browse";
import { statusIssues } from "./brain";
import { procAttention } from "./proc";
import type { StackState } from "./store";
import { nodeKey, type NodeRef } from "./types";

export type SpaceId = "fleet" | "accounts" | "lab" | "system" | "roles" | "inbox" | "signal" | "content" | "workers" | "scrape" | "browse" | "brain" | "proc";

export const spaces: { id: SpaceId; title: string; description: string; key: string }[] = [
  { id: "fleet", title: "Fleet", description: "Bots and their controls", key: "1" },
  { id: "accounts", title: "Accounts", description: "Accounts, usage limits, and model catalogs", key: "2" },
  { id: "lab", title: "Lab", description: "Experimental windows for tinkering", key: "3" },
  { id: "system", title: "System", description: "Server, processes, packages, host resources and activity", key: "4" },
  { id: "roles", title: "Roles", description: "Instructions, skills, MCP servers and trusted projects every new Bot launches with", key: "5" },
  { id: "inbox", title: "Inbox", description: "Notifications to read, answer and dismiss", key: "6" },
  { id: "signal", title: "Signal", description: "What conversations ask of you, and how it was interpreted", key: "7" },
  { id: "content", title: "Content", description: "Vault documents, collections, files and Artifacts", key: "8" },
  { id: "workers", title: "Workers", description: "What Workers started by Bots are doing, read-only", key: "9" },
  { id: "scrape", title: "Scrape", description: "Extraction, feeds, presets and their health, and the scrape-to-file queue", key: "0" },
  // The digits are taken; b is free on the bench.
  { id: "browse", title: "Browse", description: "Bot browser profiles, human handoffs and the browser toolchain", key: "b" },
  { id: "brain", title: "Brain", description: "Search and read collected research, submit material, and follow ingestion and sources", key: "n" },
  { id: "proc", title: "Proc", description: "What agents scheduled and ran on this machine, and what it printed", key: "p" },
];

export const defaultSpace: SpaceId = "fleet";

export function isSpaceId(value: unknown): value is SpaceId {
  return spaces.some((space) => space.id === value);
}

export function spaceTitle(space: SpaceId): string {
  return spaces.find((item) => item.id === space)?.title ?? space;
}

export type NodeHome = { kind: "space"; space: SpaceId; window: string } | { kind: "reference" };

/** Reference records deliberately have no spatial home. */
export function homeOf(ref: NodeRef): NodeHome {
  switch (ref.kind) {
    case "access-client":
    case "access-pairing":
    case "access-grant":
    case "access-credential":
      return { kind: "space", space: "system", window: "access" };
    case "server":
    case "child":
      return { kind: "space", space: "system", window: "server" };
    case "resource":
      return { kind: "space", space: "system", window: "resources" };
    case "process":
      return { kind: "space", space: "system", window: "processes" };
    case "account":
    case "login":
    case "worker-account":
      return { kind: "space", space: "accounts", window: "accounts" };
    case "worker-catalog":
      return { kind: "space", space: "accounts", window: "model-catalogs" };
    case "usage":
    case "usage-account":
    case "grok-bot-usage":
      return { kind: "space", space: "accounts", window: "usage" };
    case "bot":
      return { kind: "space", space: "fleet", window: "bots" };
    case "worker":
      return { kind: "space", space: "workers", window: "workers" };
    case "worker-window":
      return { kind: "space", space: "workers", window: ref.id };
    case "worker-runtime":
      return { kind: "space", space: "workers", window: "worker-runtimes" };
    case "chat":
      return { kind: "space", space: "fleet", window: ref.id };
    case "category":
    case "fragment":
      return { kind: "space", space: "roles", window: "role-instructions" };
    case "notification":
      return { kind: "space", space: "inbox", window: "notify-inbox" };
    case "skill":
      return { kind: "space", space: "roles", window: "role-skills" };
    case "mcp-server":
      return { kind: "space", space: "roles", window: "role-mcp-servers" };
    case "trusted-project":
      return { kind: "space", space: "roles", window: "role-projects" };
    case "signal":
      return { kind: "space", space: "signal", window: "signal" };
    case "attention-item":
      return { kind: "space", space: "signal", window: "attention" };
    case "attention-message":
      return { kind: "space", space: "signal", window: "attention-messages" };
    case "attention-run":
      return { kind: "space", space: "signal", window: "attention-runs" };
    case "document":
      return { kind: "space", space: "content", window: "content-documents" };
    case "collection":
    case "item":
      return { kind: "space", space: "content", window: "content-library" };
    case "artifact":
      return { kind: "space", space: "content", window: "content-artifacts" };
    case "preset":
      return { kind: "space", space: "scrape", window: "scrape-presets" };
    case "scrape-job":
      return { kind: "space", space: "scrape", window: "scrape-queue" };
    case "browser-profile":
      return { kind: "space", space: "browse", window: "browse-profiles" };
    case "browser-handoff":
      return { kind: "space", space: "browse", window: "browse-handoffs" };
    case "browser-controller":
      return { kind: "space", space: "browse", window: "browse-controllers" };
    case "browser-viewer":
      return { kind: "space", space: "browse", window: ref.id };
    case "research-document":
      return { kind: "space", space: "brain", window: "brain-reader" };
    case "ingestion-job":
      return { kind: "space", space: "brain", window: "brain-jobs" };
    case "research-source":
      return { kind: "space", space: "brain", window: "brain-sources" };
    case "proc-schedule":
      return { kind: "space", space: "proc", window: "proc-schedules" };
    case "proc-execution":
      return { kind: "space", space: "proc", window: "proc-schedule" };
    case "proc-run":
      return { kind: "space", space: "proc", window: "proc-runs" };
    case "proc-run-window":
      return { kind: "space", space: "proc", window: ref.id };
    case "package":
    case "operation":
      return { kind: "reference" };
  }
}

export function spaceHref(space: SpaceId, focus?: NodeRef | null): string {
  const base = space === defaultSpace ? "/" : `/${space}`;
  return focus ? `${base}?focus=${encodeURIComponent(nodeKey(focus))}` : base;
}

/** The root is Fleet; only single, known space segments resolve. */
export function parseSpacePath(pathname: string): SpaceId | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return defaultSpace;
  if (segments.length === 1 && isSpaceId(segments[0]) && segments[0] !== defaultSpace) return segments[0];
  return null;
}

/** Human-readable reasons each space needs attention; an empty list means all quiet. Only "closed" channels count — idle and connecting are normal. */
export function spaceAttention(state: Pick<StackState, "status" | "server" | "resources" | "accounts" | "workerAccounts" | "workerSessions" | "workerRuntimes" | "bots" | "attempt" | "catalog" | "endpoints" | "notifyCounts" | "signalStatus"> & Partial<Pick<StackState, "contentUploads" | "scrapeStatus" | "browserHandoffs" | "browserProfiles" | "browserToolchain" | "brainStatus" | "brainJobStats" | "brainSources" | "procSchedules" | "procStatus">>): Record<SpaceId | "api", string[]> {
  const attention: Record<SpaceId | "api", string[]> = { fleet: [], accounts: [], lab: [], roles: [], system: [], inbox: [], signal: [], content: [], workers: [], scrape: [], browse: [], brain: [], proc: [], api: [] };
  for (const bot of state.bots.data ?? []) if (bot.recoveryIssue) attention.fleet.push(`${bot.id} needs inspection`);
  const labels = accountLabels(state.accounts.data);
  for (const account of state.accounts.data ?? []) if (account.removing) attention.accounts.push(`${labels.get(account.id) ?? account.id} removal unfinished`);
  const workerLabels = workerAccountLabels(state.workerAccounts.data);
  for (const worker of state.workerAccounts.data ?? []) {
    const label = workerLabels.get(worker.id) ?? worker.id;
    if (worker.removing) attention.accounts.push(`${label} removal unfinished`);
    else if (!worker.ready) attention.accounts.push(`${label} needs sign-in`);
  }
  if (state.attempt?.status === "failed") attention.accounts.push("Sign-in failed");
  if (state.status.bots === "closed") attention.fleet.push("bots reconnecting");
  if (state.status.roles === "closed") attention.roles.push("roles reconnecting");
  const open = state.notifyCounts.data?.open ?? 0;
  if (open) attention.inbox.push(`${open} open notification${open === 1 ? "" : "s"}`);
  if (state.status.notify === "closed") attention.inbox.push("notify reconnecting");
  if (state.status.signal === "closed") attention.signal.push("signal reconnecting");
  if (state.signalStatus.error) attention.signal.push(`Signal status: ${state.signalStatus.error}`);
  const signal = state.signalStatus.data;
  for (const { source } of signal?.sourceErrors ?? []) attention.signal.push(`${source} unreadable`);
  if (signal?.lastInference?.error) attention.signal.push(`Last interpretation failed: ${signal.lastInference.error}`);
  if (state.status.content === "closed") attention.content.push("content reconnecting");
  for (const worker of state.workerSessions?.data ?? []) {
    const reason = workerAttention(worker);
    if (reason) attention.workers.push(`${workerLabel(worker)}: ${reason}`);
  }
  for (const runtime of state.workerRuntimes?.data ?? []) if (runtime.state === "error") attention.workers.push(`${runtime.provider} runtime error${runtime.error ? `: ${runtime.error}` : ""}`);
  if (state.status.worker === "closed") attention.workers.push("worker reconnecting");
  for (const upload of state.contentUploads ?? []) {
    if (upload.phase === "stalled") attention.content.push(`${upload.name} upload stalled`);
    if (upload.phase === "failed") attention.content.push(`${upload.name} upload failed`);
  }
  if (state.status.scrape === "closed") attention.scrape.push("scrape reconnecting");
  // Other optional tools affect narrower routes; the Status window lists them without raising attention.
  if (state.scrapeStatus?.data && !state.scrapeStatus.data.browser) attention.scrape.push("Browser runtime unavailable");
  if (state.status.browse === "closed") attention.browse.push("browse reconnecting");
  attention.browse.push(...browseAttention(state.browserHandoffs?.data ?? null, state.browserProfiles?.data ?? null, state.browserToolchain?.data ?? null));
  if (state.status.brain === "closed") attention.brain.push("brain reconnecting");
  attention.brain.push(...statusIssues(state.brainStatus?.data ?? null));
  const ledger = state.brainJobStats?.data;
  if (ledger) {
    // Failed and blocked jobs stay until someone retries or excludes them; retry_wait resolves itself.
    const stalled = ledger.by_state.failed + ledger.by_state.blocked;
    if (stalled) attention.brain.push(`${stalled} ${stalled === 1 ? "job needs" : "jobs need"} a decision`);
    if (ledger.stale_leases) attention.brain.push(`${ledger.stale_leases} stale ${ledger.stale_leases === 1 ? "lease" : "leases"}`);
  }
  for (const source of state.brainSources?.data ?? []) if (source.enabled && !source.paused && source.health.state === "unhealthy") attention.brain.push(`${source.display_name} unhealthy`);
  attention.proc.push(...procAttention(state));
  for (const name of ["auth", "usage", "worker"] as const) if (state.status[name] === "closed") attention.accounts.push(`${name} reconnecting`);
  for (const child of state.server.data?.children ?? []) if (!child.running) attention.system.push(`${child.name} stopped`);
  if (state.status.serve === "closed") attention.system.push("server reconnecting");
  if (state.server.error) attention.system.push(`Server status: ${state.server.error}`);
  if (state.resources.error) attention.system.push(`Resources: ${state.resources.error}`);
  if (state.resources.data?.observation.error) attention.system.push(`Resource sampling: ${state.resources.data.observation.error}`);
  for (const domain of state.resources.data?.observation.coverage?.domains ?? []) {
    if (domain.state === "stale" || domain.state === "unavailable") attention.system.push(`${domain.source} attribution ${domain.state}`);
  }
  // Closed package channels used to flag the System dock button; System is now the space that carries them.
  for (const [pkg, channel] of Object.entries(state.status)) if (pkg !== "serve" && channel === "closed") attention.system.push(`${pkg} reconnecting`);
  attention.system = [...new Set(attention.system)];
  if (state.catalog.error) attention.api.push(`Discovery: ${state.catalog.error}`);
  if (state.status.api === "closed") attention.api.push("api reconnecting");
  return attention;
}

/** Exact inverse of nodeKey(); malformed keys return null. */
export function parseNodeKey(key: string): NodeRef | null {
  if (key === "server") return { kind: "server" };
  if (key === "signal") return { kind: "signal" };
  if (key === "login") return { kind: "login" };
  if (key === "usage") return { kind: "usage" };
  if (key === "grok-bot-usage") return { kind: "grok-bot-usage" };
  const colon = key.indexOf(":");
  if (colon <= 0) return null;
  const kind = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (!rest) return null;
  if (kind === "operation") {
    const dot = rest.indexOf(".");
    if (dot <= 0 || dot === rest.length - 1) return null;
    return { kind: "operation", pkg: rest.slice(0, dot), id: rest.slice(dot + 1) };
  }
  if (kind === "access-client" || kind === "access-pairing" || kind === "access-grant" || kind === "access-credential" || kind === "account" || kind === "worker-account" || kind === "worker-catalog" || kind === "usage-account" || kind === "child" || kind === "bot" || kind === "chat" || kind === "category" || kind === "fragment" || kind === "skill" || kind === "mcp-server" || kind === "trusted-project" || kind === "notification" || kind === "attention-item" || kind === "attention-message" || kind === "attention-run" || kind === "package" || kind === "resource" || kind === "process") {
    return { kind, id: rest };
  }
  // A separate branch keeps each union small enough for TypeScript to check assignability.
  if (kind === "document" || kind === "collection" || kind === "item" || kind === "artifact") return { kind, id: rest };
  if (kind === "worker" || kind === "worker-runtime" || kind === "worker-window") return { kind, id: rest };
  if (kind === "preset" || kind === "scrape-job") return { kind, id: rest };
  if (kind === "browser-profile" || kind === "browser-handoff" || kind === "browser-controller" || kind === "browser-viewer") return { kind, id: rest };
  if (kind === "research-document" || kind === "ingestion-job" || kind === "research-source") return { kind, id: rest };
  if (kind === "proc-schedule" || kind === "proc-execution" || kind === "proc-run" || kind === "proc-run-window") return { kind, id: rest };
  return null;
}
