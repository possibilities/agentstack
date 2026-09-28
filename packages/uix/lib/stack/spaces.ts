import { accountLabels, workerAccountLabels } from "./derive";
import type { StackState } from "./store";
import { nodeKey, type NodeRef } from "./types";

export type SpaceId = "fleet" | "accounts" | "lab" | "system" | "roles" | "inbox";

export const spaces: { id: SpaceId; title: string; description: string; key: string }[] = [
  { id: "fleet", title: "Fleet", description: "Bots and their controls", key: "1" },
  { id: "accounts", title: "Accounts", description: "Accounts, usage limits, and model catalogs", key: "2" },
  { id: "lab", title: "Lab", description: "Experimental windows for tinkering", key: "3" },
  { id: "system", title: "System", description: "Owner, processes, packages, host resources and activity", key: "4" },
  { id: "roles", title: "Roles", description: "Instructions every new Bot launches with", key: "5" },
  { id: "inbox", title: "Inbox", description: "Notifications to read, answer and dismiss", key: "6" },
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
    case "owner":
    case "child":
      return { kind: "space", space: "system", window: "owner" };
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
    case "chat":
      return { kind: "space", space: "fleet", window: ref.id };
    case "category":
    case "fragment":
      return { kind: "space", space: "roles", window: "role-instructions" };
    case "notification":
      return { kind: "space", space: "inbox", window: "notify-inbox" };
    case "package":
    case "operation":
      return { kind: "reference" };
  }
}

export function spaceHref(space: SpaceId, focus?: NodeRef | null): string {
  const base = `/x/${space}`;
  return focus ? `${base}?focus=${encodeURIComponent(nodeKey(focus))}` : base;
}

/** "/x" and "/x/" resolve to the default space; unknown or deeper paths do not resolve. */
export function parseSpacePath(pathname: string): SpaceId | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0] === "x") return defaultSpace;
  if (segments.length === 2 && segments[0] === "x" && isSpaceId(segments[1])) return segments[1];
  return null;
}

/** Human-readable reasons each space needs attention; an empty list means all quiet. Only "closed" channels count — idle and connecting are normal. */
export function spaceAttention(state: Pick<StackState, "status" | "owner" | "resources" | "accounts" | "workerAccounts" | "bots" | "attempt" | "catalog" | "endpoints" | "notifyCounts">): Record<SpaceId | "api", string[]> {
  const attention: Record<SpaceId | "api", string[]> = { fleet: [], accounts: [], lab: [], roles: [], system: [], inbox: [], api: [] };
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
  for (const name of ["auth", "usage", "worker"] as const) if (state.status[name] === "closed") attention.accounts.push(`${name} reconnecting`);
  for (const child of state.owner.data?.children ?? []) if (!child.running) attention.system.push(`${child.name} stopped`);
  if (state.status.owner === "closed") attention.system.push("owner reconnecting");
  if (state.owner.error) attention.system.push(`Owner status: ${state.owner.error}`);
  if (state.resources.error) attention.system.push(`Resources: ${state.resources.error}`);
  if (state.resources.data?.observation.error) attention.system.push(`Resource sampling: ${state.resources.data.observation.error}`);
  for (const domain of state.resources.data?.observation.coverage?.domains ?? []) {
    if (domain.state === "stale" || domain.state === "unavailable") attention.system.push(`${domain.source} attribution ${domain.state}`);
  }
  // Closed package channels used to flag the System dock button; System is now the space that carries them.
  for (const [pkg, channel] of Object.entries(state.status)) if (channel === "closed") attention.system.push(`${pkg} reconnecting`);
  attention.system = [...new Set(attention.system)];
  if (state.catalog.error) attention.api.push(`Discovery: ${state.catalog.error}`);
  if (state.status.api === "closed") attention.api.push("api reconnecting");
  return attention;
}

/** Exact inverse of nodeKey(); malformed keys return null. */
export function parseNodeKey(key: string): NodeRef | null {
  if (key === "owner") return { kind: "owner" };
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
  if (kind === "access-client" || kind === "access-pairing" || kind === "access-grant" || kind === "access-credential" || kind === "account" || kind === "worker-account" || kind === "worker-catalog" || kind === "usage-account" || kind === "child" || kind === "bot" || kind === "chat" || kind === "category" || kind === "fragment" || kind === "notification" || kind === "package" || kind === "resource" || kind === "process") {
    return { kind, id: rest };
  }
  return null;
}
