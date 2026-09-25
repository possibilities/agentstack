import { nodeKey, type NodeRef } from "./types";

export type SpaceId = "fleet" | "system" | "api";

export const spaces: { id: SpaceId; title: string; description: string; key: string }[] = [
  { id: "fleet", title: "Fleet", description: "Accounts and bots", key: "1" },
  { id: "system", title: "System", description: "Owner processes, surfaces, and activity", key: "2" },
  { id: "api", title: "API", description: "Package API reference", key: "3" },
];

export const defaultSpace: SpaceId = "fleet";

export function isSpaceId(value: unknown): value is SpaceId {
  return spaces.some((space) => space.id === value);
}

export function spaceTitle(space: SpaceId): string {
  return spaces.find((item) => item.id === space)?.title ?? space;
}

/** The space and window where a node's card lives. */
export function homeOf(ref: NodeRef): { space: SpaceId; window: string } {
  switch (ref.kind) {
    case "owner":
    case "child":
      return { space: "system", window: "system" };
    case "account":
    case "login":
      return { space: "fleet", window: "accounts" };
    case "bot":
      return { space: "fleet", window: "bots" };
    case "package":
      return { space: "api", window: `package:${ref.id}` };
    case "operation":
      return { space: "api", window: `package:${ref.pkg}` };
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

/** Exact inverse of nodeKey(); malformed keys return null. */
export function parseNodeKey(key: string): NodeRef | null {
  if (key === "owner") return { kind: "owner" };
  if (key === "login") return { kind: "login" };
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
  if (kind === "account" || kind === "child" || kind === "bot" || kind === "package") {
    return { kind, id: rest };
  }
  return null;
}
