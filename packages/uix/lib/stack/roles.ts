import type { Bot, RoleCategory, RoleFragment, RolePreview, RoleSnapshot, WorkerSession } from "./types";

/** Mirrors the Roles API's title limit. */
export const titleLimit = 200;
/** Mirrors the Roles API's human-only description limit. */
export const descriptionLimit = 4_000;
/** The rendered-size ceiling used until a preview reports the API's own. */
export const fallbackLimitBytes = 262_144;

const encoder = new TextEncoder();
export const utf8Bytes = (text: string): number => encoder.encode(text).length;
/** A rough estimate for prose and code: about four UTF-8 bytes per token. Always shown as approximate. */
export const approxTokens = (bytes: number): number => Math.ceil(bytes / 4);

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  const kb = bytes / 1_024;
  return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
}

export function formatCount(value: number): string {
  if (value < 1_000) return String(value);
  const k = value / 1_000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

/** Why a fragment does or does not reach SYSTEM_APPEND.md. A disabled category outranks the fragment's own state. */
export type FragmentState = "renders" | "off" | "category-off" | "empty";

export function fragmentState(fragment: Pick<RoleFragment, "enabled" | "body">, category: Pick<RoleCategory, "enabled">): FragmentState {
  if (!category.enabled) return "category-off";
  if (!fragment.enabled) return "off";
  return fragment.body.trim() ? "renders" : "empty";
}

export const fragmentStateLabel: Record<FragmentState, string> = {
  renders: "Renders",
  off: "Off",
  "category-off": "Category off",
  empty: "Empty",
};

export function roleCounts(role: Pick<RoleSnapshot, "categories">): { categories: number; fragments: number; rendering: number } {
  const fragments = role.categories.flatMap((category) => category.fragments.map((fragment) => fragmentState(fragment, category)));
  return { categories: role.categories.length, fragments: fragments.length, rendering: fragments.filter((state) => state === "renders").length };
}

export function findFragment(role: Pick<RoleSnapshot, "categories"> | null, id: string): { category: RoleCategory; fragment: RoleFragment; index: number } | null {
  for (const category of role?.categories ?? []) {
    const index = category.fragments.findIndex((fragment) => fragment.id === id);
    if (index >= 0) return { category, fragment: category.fragments[index], index };
  }
  return null;
}

export function findCategory(role: Pick<RoleSnapshot, "categories"> | null, id: string): { category: RoleCategory; index: number } | null {
  const index = role?.categories.findIndex((category) => category.id === id) ?? -1;
  return index >= 0 ? { category: role!.categories[index], index } : null;
}

export type FilteredCategory = { category: RoleCategory; fragments: RoleFragment[] };

/**
 * Case-insensitive search over titles, descriptions and bodies. Every word must match somewhere in a
 * fragment or its category; a category whose own text matches keeps all of its fragments.
 */
export function filterRole(categories: RoleCategory[], query: string): FilteredCategory[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return categories.map((category) => ({ category, fragments: category.fragments }));
  const text = (...values: string[]) => values.join("\n").toLowerCase();
  return categories.flatMap((category) => {
    const own = text(category.title, category.description);
    if (words.every((word) => own.includes(word))) return [{ category, fragments: category.fragments }];
    const fragments = category.fragments.filter((fragment) => {
      const haystack = text(own, fragment.title, fragment.description, fragment.body);
      return words.every((word) => haystack.includes(word));
    });
    return fragments.length ? [{ category, fragments }] : [];
  });
}

/** The zero-based `fragment_move` index that places `id` before `beforeId`, or last when `beforeId` is null. */
export function moveIndex(category: Pick<RoleCategory, "fragments">, id: string, beforeId: string | null): number {
  const others = category.fragments.filter((fragment) => fragment.id !== id);
  const at = beforeId === null ? -1 : others.findIndex((fragment) => fragment.id === beforeId);
  return at < 0 ? others.length : at;
}

/** The exact `category_reorder` permutation that places `id` before `beforeId`, or last when `beforeId` is null. */
export function categoryOrder(categories: Pick<RoleCategory, "id">[], id: string, beforeId: string | null): string[] {
  const others = categories.map((category) => category.id).filter((item) => item !== id);
  const at = beforeId === null ? -1 : others.indexOf(beforeId);
  others.splice(at < 0 ? others.length : at, 0, id);
  return others;
}

/** IDs present after a write but not before it, e.g. the fragment a create just made. */
export function addedIds<T extends { id: string }>(before: T[], after: T[]): string[] {
  const known = new Set(before.map((item) => item.id));
  return after.filter((item) => !known.has(item.id)).map((item) => item.id);
}

export const copyTitle = (title: string): string => `${title} (copy)`.slice(0, titleLimit);

/* ─── Drafts ─────────────────────────────────────────────────────────── */

/**
 * Unsaved text edits to one record. `base` is the saved value each edited field had when editing began,
 * so a save can tell a concurrent change (conflict) from an unrelated one (follow it).
 */
export type Draft = { base: Record<string, string>; values: Record<string, string> };
export const emptyDraft: Draft = { base: {}, values: {} };

type Fields = Record<string, string>;

/** The text fields a draft edits; switches and moves apply at once instead. */
export const fragmentText = (fragment: Pick<RoleFragment, "title" | "description" | "body">): Fields =>
  ({ title: fragment.title, description: fragment.description, body: fragment.body });
export const categoryText = (category: Pick<RoleCategory, "title" | "description">): Fields =>
  ({ title: category.title, description: category.description });

/** Record one field's new text; returning to the value editing started from clears that field. */
export function editDraft(draft: Draft, field: string, value: string, saved: Fields): Draft {
  const base = field in draft.base ? draft.base[field] : saved[field] ?? "";
  const values = { ...draft.values };
  const bases = { ...draft.base };
  if (value === base) {
    delete values[field];
    delete bases[field];
  } else {
    values[field] = value;
    bases[field] = base;
  }
  return { base: bases, values };
}

/** Edited fields whose saved value moved after editing began. */
export function draftConflicts(draft: Draft, saved: Fields): string[] {
  return Object.keys(draft.values).filter((field) => (saved[field] ?? "") !== draft.base[field]);
}

/** The fields a save would write: edits that differ from what is saved now. */
export function draftChanges(draft: Draft, saved: Fields): Fields {
  return Object.fromEntries(Object.entries(draft.values).filter(([field, value]) => (saved[field] ?? "") !== value));
}

/** Keep mine: treat the current saved values as the base, so a save overwrites them deliberately. */
export function keepDraft(draft: Draft, saved: Fields): Draft {
  const base = { ...draft.base };
  for (const field of draftConflicts(draft, saved)) base[field] = saved[field] ?? "";
  return { base, values: draft.values };
}

/** Use theirs: drop the edits that conflict and keep the rest. */
export function yieldDraft(draft: Draft, saved: Fields): Draft {
  const conflicts = new Set(draftConflicts(draft, saved));
  const pick = (record: Fields) => Object.fromEntries(Object.entries(record).filter(([field]) => !conflicts.has(field)));
  return { base: pick(draft.base), values: pick(draft.values) };
}

export const draftDirty = (draft: Draft | undefined, saved: Fields): boolean => Boolean(draft && Object.keys(draftChanges(draft, saved)).length);

/* ─── Preview and launches ───────────────────────────────────────────── */

export type PreviewPiece = { fragmentId: string; categoryId: string; text: string; title: string | null };

/** The preview's size, measured locally when an older Roles API does not report it. */
export const previewBytes = (preview: RolePreview): number => typeof preview.bytes === "number" ? preview.bytes : utf8Bytes(preview.rendered);

/**
 * The preview's text cut at each fragment span, titled from the Role when it still has that fragment.
 * Null when the preview has no spans, as from a Roles API older than this UI; show the text whole then.
 */
export function previewPieces(preview: RolePreview, role: Pick<RoleSnapshot, "categories"> | null): PreviewPiece[] | null {
  if (!Array.isArray(preview.segments)) return null;
  return preview.segments.map((segment) => ({
    fragmentId: segment.fragmentId,
    categoryId: segment.categoryId,
    text: preview.rendered.slice(segment.start, segment.end),
    title: findFragment(role, segment.fragmentId)?.fragment.title ?? null,
  }));
}

/** Running Bots and open Workers keep the Role revision they launched with; edits reach only later launches. */
export function roleLaunches(bots: Bot[] | null, workers: WorkerSession[] | null, revision: number): {
  bots: Array<{ bot: Bot; current: boolean }>;
  workers: { current: number; behind: number };
} {
  const running = (bots ?? []).filter((bot) => bot.state === "running" && bot.roleRevision !== null)
    .map((bot) => ({ bot, current: bot.roleRevision === revision }));
  const open = (workers ?? []).filter((worker) => worker.roleRevision !== null && !["closed", "failed"].includes(worker.phase));
  return {
    bots: running,
    workers: { current: open.filter((worker) => worker.roleRevision === revision).length, behind: open.filter((worker) => worker.roleRevision !== revision).length },
  };
}
