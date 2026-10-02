import type { Bot, CodexToolsConnection, Role, RoleCatalog, RoleCategory, RoleFragment, RoleInternalMcp, RoleInternalServer, RoleLaunchPreview, RoleMcpDefinition, RoleMcpServer, RolePreview, RoleRenderContext, RoleSkill, RoleSkillFile, RoleSnapshot, RoleTrustedProject, WorkerSession } from "./types";

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

/* ─── Conditions and rendering context ───────────────────────────────── */

/**
 * The rendering-context dimensions a fragment condition can name, in display order, with the `stack roles inject`
 * flag that supplies each. Mirrors the Roles API; a new dimension extends this list.
 */
export const conditionDimensions = [
  { key: "model", label: "Model", flag: "--with-model" },
  { key: "harness", label: "Harness", flag: "--with-harness" },
] as const satisfies ReadonlyArray<{ key: keyof RoleRenderContext; label: string; flag: string }>;
export type ConditionKey = typeof conditionDimensions[number]["key"];
/** Mirrors the Roles API's limit on one condition or context value. */
export const conditionValueLimit = 200;

/**
 * Known dimensions in display order, values verbatim. An empty string means the dimension is not set, so it is
 * dropped; whitespace is kept for validation to refuse rather than silently trimmed.
 */
export function normalizeContext(value: Partial<Record<string, unknown>> | null | undefined): RoleRenderContext {
  const context: RoleRenderContext = {};
  for (const { key } of conditionDimensions) {
    const text = value?.[key];
    if (typeof text === "string" && text !== "") context[key] = text;
  }
  return context;
}

/** One canonical string per context or condition set, for comparison and fencing. `{}` is unconditional. */
export const contextKey = (value: Partial<Record<string, unknown>> | null | undefined): string => JSON.stringify(normalizeContext(value));
export const hasConditions = (conditions: RoleRenderContext | null | undefined): boolean => Object.keys(normalizeContext(conditions)).length > 0;

/** Why the API would refuse each value: blank, or longer than its limit. */
export function contextIssues(context: RoleRenderContext): Partial<Record<ConditionKey, string>> {
  const issues: Partial<Record<ConditionKey, string>> = {};
  for (const { key } of conditionDimensions) {
    const value = context[key];
    if (value === undefined) continue;
    if (!value.trim()) issues[key] = "Use a value that is not only spaces, or clear it";
    else if (value.length > conditionValueLimit) issues[key] = `Use ${conditionValueLimit} characters or fewer`;
  }
  return issues;
}

/** “model = foo · harness = codex”, or null for an unconditional fragment or an empty context. */
export function contextSummary(context: RoleRenderContext | null | undefined): string | null {
  const normal = normalizeContext(context);
  const parts = conditionDimensions.filter(({ key }) => normal[key] !== undefined).map(({ key }) => `${key} = ${normal[key]}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * How a fragment's conditions meet a rendering context, as the API evaluates them: every present condition must
 * equal its context value exactly and case-sensitively. A differing value is a mismatch even when another is also
 * missing, since supplying the missing one would not help.
 */
export type ConditionOutcome = "match" | "missing" | "mismatch";

export function conditionOutcome(conditions: RoleRenderContext | null | undefined, context: RoleRenderContext): ConditionOutcome {
  let missing = false;
  for (const [key, value] of Object.entries(normalizeContext(conditions)) as Array<[ConditionKey, string]>) {
    const given = context[key];
    if (given === undefined) missing = true;
    else if (given !== value) return "mismatch";
  }
  return missing ? "missing" : "match";
}

const shellWord = (word: string): string => /^[A-Za-z0-9._/:=@+%,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`;

/**
 * The `stack roles inject` invocation that renders with this context, up to the `--` before the native command.
 * The flags only supply rendering context; they neither pick nor configure the native CLI or its model.
 */
export function injectCommand(roleName: string | null, context: RoleRenderContext): string {
  const normal = normalizeContext(context);
  const flags = conditionDimensions.flatMap(({ key, flag }) => normal[key] !== undefined ? [flag, shellWord(normal[key]!)] : []);
  return ["stack", "roles", "inject", roleName ? shellWord(roleName) : "default", ...flags, "--"].join(" ");
}

export const injectionGuidance = "Role injection reads an existing compatible Role store without the Server. It does not create, migrate or repair Roles; a missing or incompatible store is a setup error, not an empty Role. Internal tools can list without the Server, but only explicitly standalone-capable calls can execute without their service. Native runtime/plugin installation, authentication and approvals are separate.";

/** Why a fragment does or does not reach SYSTEM_APPEND.md in a rendering context. A disabled category outranks the fragment's own state. */
export type FragmentState = "renders" | "off" | "category-off" | "empty" | "missing-context" | "mismatch";

/** `context` is the one the preview uses; omitted, it is the empty context Bots and Workers render with today. */
export function fragmentState(fragment: Pick<RoleFragment, "enabled" | "body" | "conditions">, category: Pick<RoleCategory, "enabled">, context: RoleRenderContext = {}): FragmentState {
  if (!category.enabled) return "category-off";
  if (!fragment.enabled) return "off";
  if (!fragment.body.trim()) return "empty";
  const outcome = conditionOutcome(fragment.conditions, context);
  return outcome === "match" ? "renders" : outcome === "missing" ? "missing-context" : "mismatch";
}

export const fragmentStateLabel: Record<FragmentState, string> = {
  renders: "Renders",
  off: "Off",
  "category-off": "Category off",
  empty: "Empty",
  "missing-context": "Needs context",
  mismatch: "No match",
};

/** Counts in a rendering context; `rendering` equals the preview's segments for that same context. */
export function roleCounts(role: Pick<RoleSnapshot, "categories">, context: RoleRenderContext = {}): { categories: number; fragments: number; rendering: number; conditional: number } {
  const fragments = role.categories.flatMap((category) => category.fragments);
  const states = role.categories.flatMap((category) => category.fragments.map((fragment) => fragmentState(fragment, category, context)));
  return { categories: role.categories.length, fragments: fragments.length, rendering: states.filter((state) => state === "renders").length,
    conditional: fragments.filter((fragment) => hasConditions(fragment.conditions)).length };
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

/**
 * The fields a draft edits; switches and moves apply at once instead. Conditions travel as their canonical JSON, so
 * a draft owns them like text and an unrelated save leaves them alone. Older snapshots without them are unconditional.
 */
export const fragmentText = (fragment: Pick<RoleFragment, "title" | "description" | "body" | "conditions">): Fields =>
  ({ title: fragment.title, description: fragment.description, body: fragment.body, conditions: contextKey(fragment.conditions) });

/** The conditions a draft's canonical JSON holds; unreadable text is unconditional. */
export function draftConditions(value: string | undefined): RoleRenderContext {
  try { const parsed: unknown = JSON.parse(value ?? "{}"); return typeof parsed === "object" && parsed !== null ? normalizeContext(parsed as Record<string, unknown>) : {}; } catch { return {}; }
}

/**
 * A fragment write's arguments from draft changes: text as is, and conditions as the complete replacement object,
 * `{}` to clear them. Unchanged conditions are omitted, which the API preserves.
 */
export function fragmentChanges(changes: Fields): Record<string, unknown> {
  const { conditions, ...text } = changes;
  return conditions === undefined ? text : { ...text, conditions: draftConditions(conditions) };
}
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

/** How a Bot's applied Role relates to the Bot default, which its next launch resolves. */
export type LaunchState =
  /** The default Role at its current revision: a launch now would apply the same thing. */
  | "current"
  /** The default Role, launched at an older revision. */
  | "older"
  /** A different Role, possibly one deleted since. Equal revision numbers across Roles are unrelated. */
  | "other"
  /** A legacy launch with no Role ID; never assumed to be the default. */
  | "unknown";

/** `name` is the launched Role's, or null once it is deleted or its identity unknown. */
export type Launch = { state: LaunchState; roleId: string | null; roleRevision: number; name: string | null };

/**
 * Classify what a Bot launched with against the Bot default, since restarting it resolves that default again.
 * Null before a launch has applied anything, or before the catalog has loaded. Workers use `classifyWorkerRole`.
 */
export function classifyLaunch(session: { roleId: string | null; roleRevision: number | null }, catalog: RoleCatalog | null): Launch | null {
  // Older records may omit the ID altogether; like a null one it names no Role, so it is never taken for the default.
  if (typeof session.roleRevision !== "number" || !catalog) return null;
  if (!session.roleId) return { state: "unknown", roleId: null, roleRevision: session.roleRevision, name: null };
  const role = catalog.roles.find((item) => item.id === session.roleId) ?? null;
  const launch = { roleId: session.roleId, roleRevision: session.roleRevision, name: role?.name ?? null };
  if (session.roleId !== catalog.defaultRoleId) return { ...launch, state: "other" };
  // A launch newer than the catalog's read means the catalog is a step behind; that is not "older".
  return { ...launch, state: role && session.roleRevision < role.revision ? "older" : "current" };
}

/** The launched Role as people read it: “Researcher r5”, “Deleted role r5”, or “Unknown role r5”. */
export const launchLabel = (launch: Launch): string => `${launch.state === "unknown" ? "Unknown role" : launch.name ?? "Deleted role"} r${launch.roleRevision}`;

/**
 * What a restart would change, worded so it never claims a running Bot changed. Null when a launch now would
 * apply what this one did.
 */
export function launchHint(launch: Launch, defaultRole: Pick<Role, "name" | "revision"> | null): string | null {
  if (launch.state === "current") return null;
  const target = launch.state === "older" ? `r${defaultRole?.revision}` : defaultRole?.name ?? "a Role";
  return `Launched with ${launchLabel(launch)} · restart to use ${target}`;
}

/**
 * How a Worker's captured Role relates to that same Role now. A Worker may select any Role and keeps its snapshot
 * for good, so it is never judged against a default.
 */
export type WorkerRoleState =
  /** The captured Role at its current revision. */
  | "current"
  /** The captured Role has been edited since; the Worker keeps its older snapshot. */
  | "older"
  /** The captured Role ID is not in the loaded catalog. */
  | "deleted"
  /** A legacy record with a revision but no Role ID. */
  | "unknown"
  /** No catalog to name the captured ID against. */
  | "unavailable";

/**
 * `name` and `currentRevision` are the captured Role's while the catalog lists it. `workerDefault` says whether it
 * is the Worker default now, which is what an unselected new Worker would get, not how this one started.
 */
export type WorkerRole = { state: WorkerRoleState; roleId: string | null; roleRevision: number; name: string | null; currentRevision: number | null; workerDefault: boolean };

/** Null until the Worker has captured a Role. */
export function classifyWorkerRole(worker: { roleId?: string | null; roleRevision: number | null }, catalog: RoleCatalog | null): WorkerRole | null {
  if (typeof worker.roleRevision !== "number") return null;
  const base = { roleId: worker.roleId ?? null, roleRevision: worker.roleRevision, name: null, currentRevision: null, workerDefault: false };
  if (!base.roleId) return { ...base, state: "unknown" };
  if (!catalog) return { ...base, state: "unavailable" };
  const role = catalog.roles.find((item) => item.id === base.roleId);
  if (!role) return { ...base, state: "deleted" };
  // A capture newer than the catalog's read means the catalog is a step behind; that is not "older".
  return { ...base, name: role.name, currentRevision: role.revision, workerDefault: catalog.workerDefaultRoleId === role.id,
    state: worker.roleRevision < role.revision ? "older" : "current" };
}

/** “Researcher r5”, “Deleted role r5”, “Unknown role r5”, or “Role r5” when the catalog is unavailable. */
export const workerRoleLabel = (role: WorkerRole): string =>
  `${role.name ?? { current: "Role", older: "Role", deleted: "Deleted role", unknown: "Unknown role", unavailable: "Role" }[role.state]} r${role.roleRevision}`;

/**
 * Explains a Worker's captured Role without implying anything changes it. The Worker default is mentioned only as
 * what a new Worker without a selected Role would get.
 */
export function workerRoleHint(role: WorkerRole, workerDefault: Pick<Role, "id" | "name"> | null): string {
  const label = workerRoleLabel(role);
  const captured = {
    current: `Started with ${label}, that Role's current revision.`,
    older: `Started with ${label}; ${role.name} is now r${role.currentRevision}. This Worker keeps its r${role.roleRevision} snapshot, including through recovery.`,
    deleted: `Started with a Role deleted since, at r${role.roleRevision}. This Worker keeps that snapshot.`,
    unknown: `A legacy record with no Role ID, captured at r${role.roleRevision}; its Role is unknown.`,
    unavailable: `Started with Role r${role.roleRevision}; the Roles catalog is unavailable to name it.`,
  }[role.state];
  const unselected = !workerDefault || role.state === "unknown" || role.state === "unavailable" ? ""
    : role.workerDefault ? " It is also the current Worker default." : ` New Workers without a selected Role use “${workerDefault.name}”.`;
  return `${captured}${unselected} Editing a Role never changes a running Worker.`;
}

/** Running Bots are compared with the Bot default; open Workers with the Role each captured. */
export function roleLaunches(bots: Bot[] | null, workers: WorkerSession[] | null, catalog: RoleCatalog | null): {
  bots: Array<{ bot: Bot; launch: Launch }>;
  workers: Record<WorkerRoleState, number> & { total: number };
} {
  const running = (bots ?? []).filter((bot) => bot.state === "running").flatMap((bot) => {
    const launch = classifyLaunch(bot, catalog);
    return launch ? [{ bot, launch }] : [];
  });
  const counts = { current: 0, older: 0, deleted: 0, unknown: 0, unavailable: 0, total: 0 };
  for (const worker of workers ?? []) {
    const role = ["closed", "failed"].includes(worker.phase) ? null : classifyWorkerRole(worker, catalog);
    if (!role) continue;
    counts[role.state]++;
    counts.total++;
  }
  return { bots: running, workers: counts };
}

/* ─── Roles, selection and fencing ───────────────────────────────────── */

/** A Role-scoped response names its Role and that Role's revision. */
export type RoleRead = { roleId: string; revision: number };

/** The Role and revision a Role-scoped response describes; an editor snapshot names its Role `id`. */
export const roleReadOf = (value: { id: string; revision: number } | { roleId: string; revision: number }): RoleRead =>
  ({ roleId: "roleId" in value ? value.roleId : value.id, revision: value.revision });

/**
 * Whether a Role-scoped response may replace what the page holds. A response for any Role but the selected one is
 * dropped even when its revision is higher, since revisions of different Roles are unrelated; for the same Role a
 * read that lost a race to a newer write must not roll it back.
 */
export function acceptRoleRead(selected: string | null, held: RoleRead | null, incoming: RoleRead): boolean {
  if (incoming.roleId !== selected) return false;
  return !held || held.roleId !== incoming.roleId || incoming.revision >= held.revision;
}

/** The catalog has its own revision: a catalog read older than the held one is dropped. */
export const acceptCatalog = (held: Pick<RoleCatalog, "revision"> | null, incoming: Pick<RoleCatalog, "revision">): boolean => !held || incoming.revision >= held.revision;

export type Resolution = {
  /** The Role the page reads: the selection while it exists, else the default. */
  roleId: string | null;
  /** The selected Role is gone but has unsaved edits, so the selection stays on its ID for the person to resolve. */
  deleted: boolean;
  /** The ID the selection just left because it no longer exists, so the page can say so once. */
  fellBack: string | null;
};

/** Where the selection should be, given the catalog and which Roles hold unsaved drafts. Nothing changes until the catalog has loaded. */
export function resolveSelection(selected: string | null, catalog: RoleCatalog | null, drafted: ReadonlySet<string>): Resolution {
  if (!catalog) return { roleId: selected, deleted: false, fellBack: null };
  if (selected && catalog.roles.some((role) => role.id === selected)) return { roleId: selected, deleted: false, fellBack: null };
  if (selected && drafted.has(selected)) return { roleId: selected, deleted: true, fellBack: null };
  return { roleId: catalog.defaultRoleId, deleted: false, fellBack: selected };
}

/** Drafts about the catalog itself, such as a Role not yet created, belong to no Role. */
export const catalogScope = "catalog";

/** Draft and pending keys carry the Role they were made for, so selecting another Role or changing the default never retargets them. */
export const draftKey = (roleId: string, key: string): string => `${key === "new-role" ? catalogScope : roleId}:${key}`;

const scopeOf = (key: string): string => key.slice(0, key.indexOf(":"));

/** The entries one Role's windows see, keyed as their editors do: its own plus the catalog's. */
export function roleScoped<T>(all: Record<string, T>, roleId: string | null): Record<string, T> {
  const own: Record<string, T> = {};
  for (const [key, value] of Object.entries(all)) {
    const scope = scopeOf(key);
    if (scope === catalogScope || scope === roleId) own[key.slice(scope.length + 1)] = value;
  }
  return own;
}

/** IDs of the Roles that hold entries; catalog-scoped ones belong to no Role. */
export const scopedRoles = (all: Record<string, unknown>): Set<string> =>
  new Set(Object.keys(all).map(scopeOf).filter((scope) => scope !== catalogScope));

/** SQLite's NOCASE folds ASCII letters only, which is exactly the uniqueness the API enforces. */
export const nocase = (name: string): string => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** The text fields a Role's details draft edits. */
export const roleText = (role: Pick<Role, "name" | "description">): Fields => ({ name: role.name, description: role.description });
export const blankRoleText: Fields = { name: "", description: "" };

/** Why the API would refuse this Role name, as a hint before saving; the API stays the authority. `selfId` excludes the Role being renamed. */
export function roleNameIssue(name: string, catalog: RoleCatalog | null, selfId?: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "A name is required";
  if (trimmed.length > titleLimit) return `Use ${titleLimit} characters or fewer`;
  if (catalog?.roles.some((role) => role.id !== selfId && nocase(role.name) === nocase(trimmed))) return "Another Role already uses this name; letter case is ignored";
  return null;
}

/** The API's uniqueness failure in the words a person needs; other refusals pass through. */
export const roleErrorText = (message: string): string =>
  /UNIQUE constraint failed: roles\.name/i.test(message) ? "Another Role already uses this name; letter case is ignored" : message;

/** Which launch defaults a Role is: “Bot default”, “Worker default”, “Bot and Worker default”, or null. */
export const defaultsLabel = (bot: boolean, worker: boolean): string | null =>
  bot && worker ? "Bot and Worker default" : bot ? "Bot default" : worker ? "Worker default" : null;

/** Why a launch default cannot be deleted and how to free it. Null for a Role that is neither default. */
export function defaultDeleteHint(bot: boolean, worker: boolean): string | null {
  if (bot && worker) return "Make other Roles the Bot and Worker defaults first";
  if (bot) return "Make another Role the Bot default first";
  if (worker) return "Make another Role the Worker default first";
  return null;
}

/** How a Role reads in a window subtitle: “Manager · Bot default”, “Worker · Worker default” or “Researcher”. */
export const roleLabel = (role: Pick<Role, "id" | "name"> | null, catalog: Pick<RoleCatalog, "defaultRoleId" | "workerDefaultRoleId"> | null): string | null =>
  role ? [role.name, defaultsLabel(catalog?.defaultRoleId === role.id, catalog?.workerDefaultRoleId === role.id)].filter(Boolean).join(" · ") : null;

/* ─── Internal Stack MCP servers ─────────────────────────────────────── */

export const internalCounts = (servers: readonly RoleInternalServer[]): { on: number; total: number } =>
  ({ on: servers.filter((server) => server.enabled).length, total: servers.length });

/**
 * Every default MCP server name the page knows, switched on or off: an external MCP server may never take
 * one, so a disabled built-in still reserves its name.
 */
export function internalNames(internal: Pick<RoleInternalMcp, "servers"> | null, launch: Pick<RoleLaunchPreview, "internalMcpServers"> | null): string[] {
  return [...new Set([...(internal?.servers ?? []), ...(launch?.internalMcpServers ?? [])].map((server) => server.name))];
}

export const internalCollision = (name: string, names: Iterable<string>): boolean => {
  const canonical = (value: string) => value.toLowerCase() === "computer-use" ? "codex-computer-use" : value.toLowerCase();
  return [...names].some((other) => canonical(other) === canonical(name));
};

/* ─── Skills, MCP servers and trusted projects ───────────────────────── */

/** Mirrors the Roles API: a launch name for a skill directory or an MCP config table. */
export const resourceNamePattern = /^[a-z][a-z0-9-]{0,31}$/;
export const resourceNameLimit = 32;
export const envNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const headerNamePattern = /^[A-Za-z0-9-]+$/;
export const skillBodyLimit = 262_144;
export const skillFileCountLimit = 128;
/** Each supporting file travels as at most 262,144 base64 characters. */
export const skillFileBytesLimit = 196_608;
/** The Role snapshot's JSON budget until a launch preview reports the API's own. */
export const fallbackSnapshotLimit = 750_000;

export type ResourceKind = "skill" | "mcp-server" | "trusted-project";

export function findResource<T extends { id: string }>(items: T[] | undefined, id: string): { item: T; index: number } | null {
  const index = items?.findIndex((item) => item.id === id) ?? -1;
  return index >= 0 ? { item: items![index], index } : null;
}

/** The exact `*_reorder` permutation that places `id` before `beforeId`, or last when `beforeId` is null. */
export const resourceOrder = categoryOrder;

/** A launch name not yet taken, for duplicates: `name-copy`, then `name-copy-2`, … within the length limit. */
export function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  for (let attempt = 1; ; attempt++) {
    const suffix = attempt === 1 ? "-copy" : `-copy-${attempt}`;
    const name = `${base.slice(0, resourceNameLimit - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!used.has(name)) return name;
  }
}

export function nameIssue(name: string, taken: Iterable<string>): string | null {
  if (!name) return "A name is required";
  if (!resourceNamePattern.test(name)) return "Use lowercase letters, digits and hyphens, starting with a letter (32 at most)";
  if ([...taken].some((other) => other.toLowerCase() === name.toLowerCase())) return "Another record already uses this name";
  return null;
}

/* Skill files */

export function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** Canonical padded base64, as the API requires. */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

export const base64Bytes = (value: string): number => Math.floor(value.length * 3 / 4) - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);

const strictUtf8 = typeof TextDecoder === "undefined" ? null : new TextDecoder("utf-8", { fatal: true });

/** The file as editable text, or null when its bytes are not UTF-8 text. */
export function fileText(file: RoleSkillFile): string | null {
  try {
    const text = strictUtf8?.decode(decodeBase64(file.contentBase64)) ?? null;
    return text !== null && !text.includes("\u0000") ? text : null;
  } catch { return null; }
}

export const textFile = (path: string, text: string): RoleSkillFile => ({ path, contentBase64: encodeBase64(encoder.encode(text)) });

/** A file name the API accepts: every path segment starts with a letter or digit and uses only letters, digits, `.`, `_` and `-`. */
export function safeFilePath(name: string): string {
  const segments = name.split("/").map((segment) => segment.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "")).filter(Boolean);
  const path = segments.join("/").slice(0, 240);
  return path && path.toLowerCase() !== "skill.md" ? path : "file";
}

/** Why the API would refuse this supporting-file set, in its own terms. */
export function skillFileIssues(files: RoleSkillFile[]): string[] {
  const issues: string[] = [];
  if (files.length > skillFileCountLimit) issues.push(`A skill holds at most ${skillFileCountLimit} files`);
  const paths = new Set<string>();
  for (const file of files) {
    const path = file.path.toLowerCase();
    if (!file.path || file.path.length > 240 || !file.path.split("/").every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(part))) issues.push(`${file.path || "A file"} needs a relative path of letters, digits, “.”, “_” and “-”`);
    else if (path === "skill.md") issues.push("SKILL.md is generated from the name, description and body");
    if (file.contentBase64.length > 262_144) issues.push(`${file.path} is larger than ${formatBytes(skillFileBytesLimit)}`);
    if (paths.has(path)) issues.push(`${file.path} appears twice`);
    paths.add(path);
  }
  for (const path of paths) if ([...paths].some((other) => other !== path && other.startsWith(`${path}/`))) issues.push(`${path} is both a file and a folder`);
  return [...new Set(issues)];
}

export const skillBytes = (skill: Pick<RoleSkill, "body" | "files">): number => utf8Bytes(skill.body) + skill.files.reduce((sum, file) => sum + base64Bytes(file.contentBase64), 0);

/* Draft text for resources: every edited value is a string, so structured fields travel as JSON. */

export const skillText = (skill: Pick<RoleSkill, "name" | "description" | "body" | "files" | "harnesses">): Fields =>
  ({ name: skill.name, description: skill.description, body: skill.body, files: JSON.stringify(skill.files), harnesses: JSON.stringify(skill.harnesses ?? null) });
export const projectText = (project: Pick<RoleTrustedProject, "path" | "description">): Fields => ({ path: project.path, description: project.description });
export const mcpText = (server: Pick<RoleMcpServer, "name" | "description" | "definition" | "harnesses">): Fields =>
  ({ name: server.name, description: server.description, definition: JSON.stringify(toMcpForm(server.definition)), harnesses: JSON.stringify(server.harnesses ?? null) });
export const blankSkillText: Fields = { name: "", description: "", body: "", files: "[]" };
export const blankProjectText: Fields = { path: "", description: "" };

export function draftFiles(value: string): RoleSkillFile[] {
  try { const files = JSON.parse(value); return Array.isArray(files) ? files : []; } catch { return []; }
}

/* MCP definitions */

type Pairs = Array<[string, string]>;
/**
 * The MCP editor's form. Both transports keep their fields, so switching type and back loses nothing;
 * map fields are ordered rows so typing a key never reorders them.
 */
export type McpForm = {
  type: "http" | "stdio";
  url: string; bearerTokenEnvVar: string; httpHeaders: Pairs; envHttpHeaders: Pairs;
  command: string; args: string[]; env: Pairs; envVars: string[];
};

export const emptyMcpForm: McpForm = { type: "http", url: "", bearerTokenEnvVar: "", httpHeaders: [], envHttpHeaders: [], command: "", args: [], env: [], envVars: [] };
export const blankMcpText: Fields = { name: "", description: "", definition: JSON.stringify(emptyMcpForm) };

export function toMcpForm(definition: RoleMcpDefinition): McpForm {
  if (definition.type === "http") return { ...emptyMcpForm, type: "http", url: definition.url, bearerTokenEnvVar: definition.bearerTokenEnvVar ?? "",
    httpHeaders: Object.entries(definition.httpHeaders ?? {}), envHttpHeaders: Object.entries(definition.envHttpHeaders ?? {}) };
  return { ...emptyMcpForm, type: "stdio", command: definition.command, args: definition.args, env: Object.entries(definition.env ?? {}), envVars: definition.envVars ?? [] };
}

export function draftMcpForm(value: string): McpForm {
  try { return { ...emptyMcpForm, ...JSON.parse(value) }; } catch { return emptyMcpForm; }
}

/** The API definition a form describes, or what the API would refuse. Blank rows are ignored and empty optional fields omitted. */
export function fromMcpForm(form: McpForm): { definition: RoleMcpDefinition | null; issues: string[] } {
  const issues: string[] = [];
  const pairs = (rows: Pairs, label: string, key: RegExp, value?: RegExp, caseless = false) => {
    const kept = rows.map(([name, text]) => [name.trim(), text] as [string, string]).filter(([name, text]) => name || text);
    const seen = new Set<string>();
    for (const [name, text] of kept) {
      if (!key.test(name)) issues.push(`${label}: “${name}” is not a valid name`);
      if (value && !value.test(text)) issues.push(`${label}: “${text}” is not an environment variable name`);
      const id = caseless ? name.toLowerCase() : name;
      if (seen.has(id)) issues.push(`${label}: “${name}” appears twice`);
      seen.add(id);
    }
    return kept.length ? Object.fromEntries(kept) : undefined;
  };
  if (form.type === "http") {
    const url = form.url.trim();
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) issues.push("The URL must be HTTP(S) without credentials or a #fragment");
    } catch { issues.push(url ? "The URL is not valid" : "A URL is required"); }
    const token = form.bearerTokenEnvVar.trim();
    if (token && !envNamePattern.test(token)) issues.push("The bearer token variable is not an environment variable name");
    const httpHeaders = pairs(form.httpHeaders, "Headers", headerNamePattern, undefined, true);
    const envHttpHeaders = pairs(form.envHttpHeaders, "Environment headers", headerNamePattern, envNamePattern, true);
    const definition: RoleMcpDefinition = { type: "http", url, ...(token ? { bearerTokenEnvVar: token } : {}), ...(httpHeaders ? { httpHeaders } : {}), ...(envHttpHeaders ? { envHttpHeaders } : {}) };
    return { definition: issues.length ? null : definition, issues };
  }
  const command = form.command.trim();
  if (!command) issues.push("A command is required");
  if (form.args.length > 128) issues.push("At most 128 arguments");
  const env = pairs(form.env, "Environment", envNamePattern);
  const envVars = [...new Set(form.envVars.map((name) => name.trim()).filter(Boolean))];
  for (const name of envVars) if (!envNamePattern.test(name)) issues.push(`Passed variables: “${name}” is not an environment variable name`);
  const definition: RoleMcpDefinition = { type: "stdio", command, args: form.args, ...(env ? { env } : {}), ...(envVars.length ? { envVars } : {}) };
  return { definition: issues.length ? null : definition, issues };
}

/** Literal values that end up in plain text in the Role and each launch config. */
export function mcpLiterals(definition: RoleMcpDefinition): number {
  return definition.type === "http" ? Object.keys(definition.httpHeaders ?? {}).length : Object.keys(definition.env ?? {}).length;
}

/** Split a pasted command line into words, honouring quotes and backslashes; no expansion. */
export function splitCommandLine(line: string): string[] {
  const words: string[] = [];
  let word = "", quote: "'" | "\"" | null = null, started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === "\"" && index + 1 < line.length) word += line[++index];
      else word += char;
    } else if (char === "'" || char === "\"") { quote = char; started = true; }
    else if (char === "\\" && index + 1 < line.length) { word += line[++index]; started = true; }
    else if (/\s/.test(char)) { if (started) words.push(word); word = ""; started = false; }
    else { word += char; started = true; }
  }
  if (started) words.push(word);
  return words;
}

const toml = (value: string) => JSON.stringify(value);
const inline = (values: Record<string, string>) => `{ ${Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${toml(key)} = ${toml(value)}`).join(", ")} }`;

/** The config.toml table a launch writes for one enabled server; mirrors the Roles API's launch config. */
export function mcpToml(name: string, definition: RoleMcpDefinition): string {
  const lines = [`[mcp_servers.${name}]`];
  if (definition.type === "http") {
    lines.push(`url = ${toml(definition.url)}`);
    if (definition.bearerTokenEnvVar) lines.push(`bearer_token_env_var = ${toml(definition.bearerTokenEnvVar)}`);
    if (definition.httpHeaders) lines.push(`http_headers = ${inline(definition.httpHeaders)}`);
    if (definition.envHttpHeaders) lines.push(`env_http_headers = ${inline(definition.envHttpHeaders)}`);
  } else {
    lines.push(`command = ${toml(definition.command)}`, `args = [${definition.args.map(toml).join(", ")}]`);
    if (definition.env) lines.push(`env = ${inline(definition.env)}`);
    if (definition.envVars) lines.push(`env_vars = [${definition.envVars.map(toml).join(", ")}]`);
  }
  return [...lines, "enabled = true", ""].join("\n");
}

/** A one-line target for a row: the host for HTTP, the command and argument count for stdio. */
export function mcpTarget(definition: RoleMcpDefinition): string {
  if (definition.type === "http") {
    try { return new URL(definition.url).host; } catch { return definition.url; }
  }
  const command = definition.command.split("/").pop() || definition.command;
  return definition.args.length ? `${command} +${definition.args.length}` : command;
}

/* Trusted projects */

/** Bots whose working directory lies inside the project, as the launch preview matched them. */
export function projectBots(launch: RoleLaunchPreview | null, projectId: string, bots: Bot[] | null): Bot[] {
  const cwds = new Set((launch?.cwds ?? []).filter((entry) => entry.trustedProjectIds.includes(projectId)).map((entry) => entry.cwd));
  return (bots ?? []).filter((bot) => cwds.has(bot.cwd));
}

/** Past this age a Codex tools observation is shown as possibly out of date. */
export const codexStaleMs = 60 * 60_000;
export type CodexAvailability = { label: string; tone: "ok" | "warn" | "error" | "unknown"; stale: boolean };

/**
 * A Codex bridge's catalog availability, separate from the Role switch. Anything that makes the held
 * observation uncertain (a failed read, a check in progress, no check yet) reads as such, never as the
 * last result.
 */
export function codexAvailability(connection: CodexToolsConnection | undefined, readable: boolean, checking: boolean, now: number): CodexAvailability {
  if (!connection || !readable) return { label: "Unknown", tone: "unknown", stale: false };
  if (checking) return { label: "Checking…", tone: "unknown", stale: false };
  const { state, checkedAt } = connection.catalog;
  const stale = checkedAt !== null && now - Date.parse(checkedAt) > codexStaleMs;
  switch (state) {
    case "available": return { label: "Catalog available", tone: "ok", stale };
    case "unavailable": return { label: "Unavailable", tone: "warn", stale };
    case "failed": return { label: "Check failed", tone: "error", stale };
    default: return { label: "Not checked", tone: "unknown", stale: false };
  }
}

/** Chrome's extension browser observation, which catalog availability does not imply. */
export function chromeBrowserLabel(browser: CodexToolsConnection["browser"]): string {
  switch (browser?.state) {
    case "connected": return "One Chrome browser connected";
    case "none": return "No Chrome browser connected";
    case "multiple": return "Several Chrome browsers connected";
    case "failed": return "Browser check failed";
    default: return "Browser connection not checked";
  }
}
