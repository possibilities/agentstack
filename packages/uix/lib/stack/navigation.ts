import { defaultSpace, homeOf, parseNodeKey, parseSpacePath, type SpaceId } from "./spaces";
import { nodeKey, type NodeRef } from "./types";

export type ReferenceTarget = Extract<NodeRef, { kind: "package" | "operation" }> | "overview";
export type BenchLocation = { space: SpaceId; focus: NodeRef | null; inspect: NodeRef | null; reference: ReferenceTarget | null };
export const emptyLocation = (space: SpaceId = defaultSpace): BenchLocation => ({ space, focus: null, inspect: null, reference: null });

export function navigateTo(location: BenchLocation, ref: NodeRef): BenchLocation {
  const home = homeOf(ref);
  if (home.kind === "reference") return { ...location, reference: ref as ReferenceTarget };
  return { ...location, space: home.space, focus: ref };
}

export function locationHref(location: BenchLocation): string {
  const query = new URLSearchParams();
  if (location.focus) query.set("focus", nodeKey(location.focus));
  if (location.inspect) query.set("inspect", nodeKey(location.inspect));
  if (location.reference) query.set("reference", typeof location.reference === "string" ? location.reference : nodeKey(location.reference));
  return `/x/${location.space}${query.size ? `?${query}` : ""}`;
}

export function parseLocation(pathname: string, query: URLSearchParams): BenchLocation | null {
  const space = parseSpacePath(pathname);
  if (!space) return null;
  let location = emptyLocation(space);
  const focus = parseNodeKey(query.get("focus") ?? "");
  if (focus) location = navigateTo(location, focus);
  const inspect = parseNodeKey(query.get("inspect") ?? "");
  if (inspect && homeOf(inspect).kind !== "reference") location.inspect = inspect;
  // The retired left dock's `system` parameter is ignored; owner/child nodes resolve through `focus`.
  const reference = query.get("reference");
  const referenceNode = parseNodeKey(reference ?? "");
  if (reference === "overview") location.reference = "overview";
  else if (referenceNode?.kind === "package" || referenceNode?.kind === "operation") location.reference = referenceNode;
  return location;
}
