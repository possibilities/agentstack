import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { operation, type PackageApi } from "./operation.js";
import { stateDir } from "./workspace.js";
import { pageState, requireStateOperator, stateHash, statePage, statePageInput, type StateEntry } from "./state.js";

export type StateCategory = Pick<StateEntry, "id" | "kind" | "authority" | "ownership" | "sensitivity" | "reads" | "actions" | "retention" | "regeneration"> & {
  paths: string[]; location?: StateEntry["location"]; issues?: string[];
};
export function stateCategories(owner: string, declarations: Array<Omit<StateCategory, "authority" | "ownership" | "sensitivity" | "reads" | "actions"> &
  Partial<Pick<StateCategory, "authority" | "ownership" | "sensitivity">> & { reads: string[]; actions?: string[] }>): StateCategory[] {
  return declarations.map(({ reads, actions = [], ...entry }) => ({ authority: "authoritative", ownership: "stack", sensitivity: "content", ...entry,
    reads: reads.map(operation => ({ package: owner, operation, arguments: {} })),
    actions: actions.map(operation => ({ package: owner, operation, arguments: {}, blockedBy: ["Select an exact resource through the linked read and satisfy the operation's lifecycle/revision contract"] })) }));
}

/** Metadata-only, bounded observation. Shared DB bytes are deliberately not allocated to logical owners. */
async function observe(root: string, category: StateCategory, measure: boolean) {
  const metadata: unknown[] = [], issues = [...category.issues ?? []];
  let bytes = 0, count = 0, partial = false;
  const queue = category.paths.map(path => join(root, path));
  while (queue.length) {
    const path = queue.shift()!;
    if (++count > 2000) { partial = true; issues.push("Storage scan bounded at 2000 entries; bytes are unmeasured for this category"); break; }
    try {
      const info = await lstat(path);
      metadata.push([path.slice(root.length), info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs]);
      if (info.isSymbolicLink()) { partial = true; issues.push("A storage symlink was not traversed"); continue; }
      if (info.isFile()) bytes += info.size;
      else if (info.isDirectory()) {
        if (!measure) { partial = true; continue; }
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (queue.length + count >= 2000) { partial = true; break; }
          queue.push(join(path, entry.name));
        }
      } else { partial = true; issues.push("Special storage entry not measured"); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") metadata.push([path.slice(root.length), "absent"]);
      else { partial = true; issues.push(`Storage observation failed: ${(error as NodeJS.ErrnoException).code ?? "unavailable"}`); }
    }
  }
  if (!category.paths.length || category.ownership === "shared" || category.location === "external" || category.location === "client") partial = true;
  return { revision: stateHash(metadata), bytes: partial ? null : bytes, issues, coverage: partial ? "partial" as const : "complete" as const };
}

/** Attach an owner-declared inventory without constructing any other Package API context. */
export function withStateInventory<Ctx extends object, Topic extends string = string>(owner: string, categories: readonly StateCategory[], api: PackageApi<Ctx, Topic>): PackageApi<Ctx, Topic> {
  const roots = new WeakMap<Ctx, string>();
  const inventory = operation({ name: `${owner}_state_read`,
    description: "Page this owner's state categories, ownership, retention, regeneration and read/action links. Optional measurement scans at most 2000 filesystem entries per category. Shared database bytes, external stores and client storage remain unmeasured; this is not a logical-record census or a deletion plan.",
    input: statePageInput.extend({ measure: z.boolean().default(false) }), output: statePage, annotations: { readOnlyHint: true },
    async call(ctx: Ctx, input, invocation) {
      requireStateOperator(invocation);
      const root = roots.get(ctx); if (!root) throw new Error("state inventory context is unavailable");
      const observedAt = new Date().toISOString();
      const entries: StateEntry[] = [];
      for (const category of categories) {
        const { paths: _paths, issues: _issues, ...declaration } = category;
        entries.push({ ...declaration, id: `${owner}:${category.id}`, ownerPackage: owner, subject: null, observedAt, location: category.location ?? "server",
          items: null, relationships: [], ...await observe(root, category, input.measure) });
      }
      return pageState(entries, input);
    },
  });
  return { ...api, operations: [...api.operations, inventory], async createContext(env) {
    const ctx = await api.createContext(env); roots.set(ctx, stateDir(env)); return ctx;
  } };
}
