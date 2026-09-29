import type { Role, RoleCatalog, RoleShim, RoleShims } from "./types";

/**
 * Role shims: installed commands that run `stack roles inject` with an exact argument vector. The vector is edited
 * as tokens, never as a shell string, so what the page shows is exactly what the command runs. Native options are
 * checked by `roles inject` at launch; nothing here keeps an allowlist of them.
 */

export const shimHarnesses = ["claude", "codex", "opencode"] as const;
/** Command names a shim may never take, as `role_shim_create` refuses them. */
export const reservedShimNames = new Set(["stack", "claude", "codex", "opencode"]);
const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const maxArgs = 128;
const maxArgLength = 4_096;

/**
 * An argument vector split at its first `--`: the Stack side (Role and rendering context), the harness right after
 * the boundary, and the native side. Tokens keep their order and exact text; joining gives the vector back.
 */
export type ShimVector = { stack: string[]; harness: string; native: string[] };

export function splitShimArgs(args: readonly string[]): ShimVector {
  const separator = args.indexOf("--");
  if (separator < 0) return { stack: [...args], harness: "", native: [] };
  return { stack: args.slice(0, separator), harness: args[separator + 1] ?? "", native: args.slice(separator + 2) };
}

export function joinShimArgs(vector: ShimVector): string[] {
  return [...vector.stack, "--", vector.harness, ...vector.native];
}

export const sameArgs = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Why a new shim cannot take this name, mirroring `role_shim_create`; null when it can. A listed shim already owns its name. */
export function shimNameIssue(name: string, shims: readonly RoleShim[] = []): string | null {
  if (!name) return "Name the command";
  if (!namePattern.test(name)) return name.length > 100 ? "Use at most 100 characters" : "Start with a letter or digit, then use letters, digits, dots, underscores or hyphens";
  if (reservedShimNames.has(name)) return `“${name}” is Stack or a native harness command`;
  if (shims.some((shim) => shim.name === name)) return `“${name}” is already a Role shim`;
  return null;
}

/** Why this vector cannot be saved, mirroring `role_shim_create` and `role_shim_update`; null when it can. */
export function shimArgsIssue(vector: ShimVector): string | null {
  if (vector.stack.includes("--")) return "-- is the native boundary: it cannot appear among the Stack arguments";
  if (!(shimHarnesses as readonly string[]).includes(vector.harness)) return "Choose claude, codex or opencode after --";
  const args = joinShimArgs(vector);
  if (args.length > maxArgs) return `Use at most ${maxArgs} arguments in all`;
  if (args.some((arg) => arg.length > maxArgLength)) return `An argument is longer than ${maxArgLength.toLocaleString()} characters`;
  if (args.some((arg) => arg.includes("\0"))) return "An argument contains a NUL character";
  return null;
}

/** One POSIX shell word for display: plain when nothing in it is special to the shell, otherwise single-quoted. */
export function shellWord(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The command the shim runs, as a shell would read it. Invocation arguments arrive through "$@", unchanged. */
export function shimCommand(args: readonly string[]): string {
  return [...["stack", "roles", "inject", ...args].map(shellWord), '"$@"'].join(" ");
}

/**
 * How `roles inject` would read the Stack side, for labelling only. It never blocks a save: `roles inject` is the
 * authority and checks the vector when the command runs.
 */
export type StackReading = { role: string | null; model: string | null; harness: string | null; warnings: string[] };

export function readStackArgs(stack: readonly string[]): StackReading {
  const reading: StackReading = { role: null, model: null, harness: null, warnings: [] };
  for (let index = 0; index < stack.length; index++) {
    const token = stack[index]!;
    const [flag, ...inline] = token.split("=");
    if (flag === "--with-model" || flag === "--with-harness") {
      const key = flag === "--with-model" ? "model" : "harness";
      const value = inline.length ? inline.join("=") : stack[index + 1];
      if (!inline.length) index++;
      if (value === undefined || (!inline.length && value.startsWith("-"))) reading.warnings.push(`${flag} needs a value`);
      else if (reading[key] !== null) reading.warnings.push(`${flag} is given twice`);
      else reading[key] = value;
    } else if (token.startsWith("-")) reading.warnings.push(`roles inject does not take ${token} before --`);
    else if (!token) reading.warnings.push("An empty argument is not a Role name");
    else if (reading.role !== null) reading.warnings.push(`Only one Role may be named; “${token}” is a second`);
    else reading.role = token;
  }
  return reading;
}

/** Which Role the shim would use if it ran now. Roles resolve when the command runs, so this can change later. */
export function shimRoleNote(role: string | null, catalog: RoleCatalog | null): { text: string; tone: "muted" | "warning" } {
  const fallback = catalog?.roles.find((item) => item.id === catalog.defaultRoleId);
  if (role === null || role === "default") return { text: `The catalog default when it runs${fallback ? ` (today “${fallback.name}”)` : ""}.`, tone: "muted" };
  if (!catalog) return { text: `The Role named “${role}” when it runs.`, tone: "muted" };
  const match = catalog.roles.find((item: Role) => asciiLower(item.name) === asciiLower(role));
  return match
    ? { text: `The Role named “${match.name}” when it runs.`, tone: "muted" }
    : { text: `No Role is named “${role}” now. The command fails until one exists; it is looked up each time it runs.`, tone: "warning" };
}

// Role names match SQLite NOCASE, which folds ASCII only.
const asciiLower = (value: string) => value.replace(/[A-Z]/g, (char) => char.toLowerCase());

/** A refused shim write in the operator's terms; each refusal wrote and removed nothing. */
export function shimErrorText(message: string): { kind: "stale" | "exists" | "foreign" | "other"; text: string } {
  const exists = /refusing to replace an existing command: (\S+)/.exec(message);
  if (exists) return { kind: "exists", text: `A command already exists at ${exists[1]}. Stack never replaces a file it did not install; choose another name.` };
  const foreign = /not a Stack-owned Role shim: (\S+)/.exec(message);
  if (foreign) return { kind: "foreign", text: `${foreign[1]} is no longer a Stack-owned shim: it was removed or edited outside Stack. Nothing was changed.` };
  if (/stale Role shim revision/.test(message)) return { kind: "stale", text: "This command changed since it was listed. Nothing was written; review the current version and save again." };
  return { kind: "other", text: message };
}

/** A shim being edited: a new one, or an installed one at the revision the edit started from. */
export type ShimDraft = {
  mode: "new" | "edit";
  name: string;
  vector: ShimVector;
  /** The installed shim this edit is based on; a save sends its revision. */
  base: RoleShim | null;
  /** When `base` was taken: only a listing read after it can say the shim changed or went away. */
  since: number;
  /** The revision this page's own save replaced, which a listing read before the save may still show. */
  replaced: string | null;
  /** The last refusal, in the operator's terms. */
  error: string | null;
};

export const blankShimVector: ShimVector = { stack: ["default"], harness: "", native: [] };

export const newShimDraft = (now: number): ShimDraft => ({ mode: "new", name: "", vector: blankShimVector, base: null, since: now, replaced: null, error: null });

/** Edit an installed shim, or continue after saving one; `replaced` is the revision that save superseded. */
export const shimDraftFrom = (shim: RoleShim, now: number, replaced: string | null = null): ShimDraft =>
  ({ mode: "edit", name: shim.name, vector: splitShimArgs(shim.args), base: shim, since: now, replaced, error: null });

/**
 * Where an edit stands against the listing. `changed` is the installed shim when someone else replaced it (a save
 * would be refused as stale); `gone` means it was removed or edited outside Stack. Neither is ever overwritten.
 */
export function shimEditState(draft: ShimDraft, listing: RoleShims, listedAt: number | null): {
  listed: RoleShim | null; gone: boolean; changed: RoleShim | null; dirty: boolean; invalid: string | null;
} {
  const args = joinShimArgs(draft.vector);
  if (draft.mode === "new") {
    return { listed: null, gone: false, changed: null, dirty: draft.name !== "" || !sameArgs(args, joinShimArgs(blankShimVector)),
      invalid: shimNameIssue(draft.name, listing.shims) ?? shimArgsIssue(draft.vector) };
  }
  const base = draft.base!;
  const listed = listing.shims.find((shim) => shim.name === draft.name) ?? null;
  return {
    listed,
    gone: !listed && (listedAt ?? 0) > draft.since,
    changed: listed && listed.revision !== base.revision && listed.revision !== draft.replaced ? listed : null,
    dirty: !sameArgs(args, base.args),
    invalid: shimArgsIssue(draft.vector),
  };
}
