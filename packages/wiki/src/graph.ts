import { findMentions, mentionHaystack } from "./links.js";
import { buildLinkLookup, lookupLinkTarget } from "./resolve.js";

/** The whole document graph, derived from body text and the current slug set.
 * Kept pure so the shape can be tested without a vault or an index. */

export interface GraphDocument {
  id: number;
  slug: string;
  title: string;
  path: string;
  tags: string[];
  body: string;
}

export interface GraphLink {
  sourceId: number;
  target: string;
}

export type EdgeKind = "wikilink" | "mention";

export interface GraphNode {
  slug: string;
  title: string;
  path: string;
  tags: string[];
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface DanglingLink {
  from: string;
  target: string;
  reason: "unresolved" | "ambiguous";
  candidates: string[];
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
  dangling: DanglingLink[];
}

export function buildGraph(
  documents: readonly GraphDocument[],
  links: readonly GraphLink[],
): GraphSnapshot {
  const bySlug = new Map<string, GraphDocument>();
  for (const document of documents)
    if (!bySlug.has(document.slug)) bySlug.set(document.slug, document);
  const byId = new Map<number, GraphDocument>();
  for (const document of documents) byId.set(document.id, document);
  const lookup = buildLinkLookup(documents);

  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const dangling: DanglingLink[] = [];
  const push = (from: string, to: string, kind: EdgeKind): void => {
    if (from === to) return;
    const key = `${from}\0${to}\0${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind });
  };

  for (const link of links) {
    const source = byId.get(link.sourceId);
    if (source === undefined) continue;
    const resolved = lookupLinkTarget(lookup, link.target);
    if (resolved === null) {
      dangling.push({
        from: source.slug,
        target: link.target,
        reason: "unresolved",
        candidates: [],
      });
      continue;
    }
    if ("ambiguous" in resolved) {
      dangling.push({
        from: source.slug,
        target: link.target,
        reason: "ambiguous",
        candidates: resolved.ambiguous,
      });
      continue;
    }
    push(source.slug, resolved.slug, "wikilink");
  }

  // A mention only adds signal where no explicit link already exists.
  const candidates = documents.map((document) => ({ slug: document.slug, title: document.title }));
  for (const document of documents) {
    for (const target of findMentions(mentionHaystack(document.body), candidates, document.slug)) {
      if (seen.has(`${document.slug}\0${target}\0wikilink`)) continue;
      push(document.slug, target, "mention");
    }
  }

  edges.sort(
    (left, right) =>
      left.from.localeCompare(right.from) ||
      left.to.localeCompare(right.to) ||
      left.kind.localeCompare(right.kind),
  );
  const nodes = [...bySlug.values()]
    .map((document) => ({
      slug: document.slug,
      title: document.title,
      path: document.path,
      tags: document.tags,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug));
  return { nodes, edges, dangling };
}

/** A document nothing points at and that points at nothing: findable only by
 * search, which is what doctor exists to surface. */
export function orphanSlugs(snapshot: GraphSnapshot): string[] {
  const connected = new Set<string>();
  for (const edge of snapshot.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  return snapshot.nodes.filter((node) => !connected.has(node.slug)).map((node) => node.slug);
}

export function edgesFrom(snapshot: GraphSnapshot, slug: string): GraphEdge[] {
  return snapshot.edges.filter((edge) => edge.from === slug);
}

export function edgesTo(snapshot: GraphSnapshot, slug: string): GraphEdge[] {
  return snapshot.edges.filter((edge) => edge.to === slug);
}
