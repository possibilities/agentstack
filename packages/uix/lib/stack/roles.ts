import type { Bot, RoleCategory, RoleFragment, RoleLaunchPreview, RoleMcpDefinition, RoleMcpServer, RolePreview, RoleSkill, RoleSkillFile, RoleSnapshot, RoleTrustedProject, WorkerSession } from "./types";

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

export const skillText = (skill: Pick<RoleSkill, "name" | "description" | "body" | "files">): Fields =>
  ({ name: skill.name, description: skill.description, body: skill.body, files: JSON.stringify(skill.files) });
export const projectText = (project: Pick<RoleTrustedProject, "path" | "description">): Fields => ({ path: project.path, description: project.description });
export const mcpText = (server: Pick<RoleMcpServer, "name" | "description" | "definition">): Fields =>
  ({ name: server.name, description: server.description, definition: JSON.stringify(toMcpForm(server.definition)) });
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
