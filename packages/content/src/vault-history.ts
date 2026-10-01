import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import { stateHash } from "@stack/api";
import { slugify } from "./slug.js";
import { isMarkdownPath, walkVault } from "./vault.js";

export const vaultHistoryInput = z.strictObject({ slugs: z.array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(255)).min(1).max(20),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(50), revision: z.string().optional() });
const copy = z.strictObject({ slug: z.string(), path: z.string(), commit: z.string(), blob: z.string(), mode: z.string() });
export const vaultHistoryOutput = z.strictObject({ entries: z.array(copy), revision: z.string(), nextOffset: z.number().int().nullable(),
  commitsScanned: z.number().int(), paths: z.array(z.strictObject({ slug: z.string(), path: z.string(), current: z.boolean() })),
  remotes: z.array(z.strictObject({ name: z.string(), fetch: z.boolean(), push: z.boolean() })), retained: z.array(z.string()) });

/** No reconciliation, ensureGit, staging, commit, network or history rewrite. */
export function vaultHistory(root: string, input: z.infer<typeof vaultHistoryInput>) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error("Vault history requires a real owned directory");
  const metadata = lstatSync(join(root, ".git"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Vault Git metadata is external/linked; exact local history ownership is unavailable");
  const deadline = Date.now() + 15_000;
  const run = (args: string[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Vault history exceeds the inspection time budget; no incomplete disclosure is returned");
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
    const result = spawnSync("git", ["--no-optional-locks", ...args], { cwd: root, encoding: "utf8", timeout: Math.min(10_000, remaining), maxBuffer: 8_000_000,
      env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    if (result.error || result.status !== 0) throw new Error("Vault Git retention observation unavailable or exceeds bounded inspection; no state was changed");
    return result.stdout;
  };
  if (realpathSync(run(["rev-parse", "--show-toplevel"]).trim()) !== realpathSync(root)) throw new Error("Vault must be the Git repository root, not a parent/source checkout");
  const commits = () => run(["rev-list", "--all", "--reflog"]).trim().split("\n").filter(Boolean).sort();
  const before = commits();
  if (before.length > 2000) throw new Error("Vault history exceeds the 2000-commit inspection bound; no incomplete disclosure is returned");
  const slugs = [...new Set(input.slugs)].sort(), entries: z.infer<typeof copy>[] = [], paths = new Map<string, { slug: string; path: string; current: boolean }>();
  const matches = (path: string) => isMarkdownPath(path) && !path.split("/").some(part => part.startsWith(".") || part === "node_modules") && slugs.includes(slugify(basename(path, extname(path))));
  for (const file of walkVault(root)) if (matches(file.path)) paths.set(file.path, { slug: slugify(basename(file.path, extname(file.path))), path: file.path, current: true });
  for (const commit of before) {
    for (const row of run(["ls-tree", "-r", "-z", "--full-tree", commit]).split("\0").filter(Boolean)) {
      const tab = row.indexOf("\t"), path = row.slice(tab + 1), [mode, type, blob] = row.slice(0, tab).split(" ");
      if (tab < 0 || type !== "blob" || !matches(path)) continue;
      const slug = slugify(basename(path, extname(path)));
      entries.push({ slug, path, commit, blob: blob!, mode: mode! });
      if (!paths.has(path)) paths.set(path, { slug, path, current: false });
      if (entries.length > 20000) throw new Error("Vault retention entries exceed inspection bound; no incomplete disclosure is returned");
    }
  }
  const remotes = run(["remote"]).trim().split("\n").filter(Boolean).map(name => {
    // Credential-bearing URLs deliberately stay out of disclosure. Names and
    // presence are enough to make the independent retention boundary explicit.
    const fetch = Boolean(run(["remote", "get-url", "--all", name]).trim());
    const push = Boolean(run(["remote", "get-url", "--push", "--all", name]).trim());
    return { name, fetch, push };
  });
  const shallow = run(["rev-parse", "--is-shallow-repository"]).trim() === "true";
  if (stateHash(commits()) !== stateHash(before)) throw new Error("Vault refs/reflogs changed during inspection; restart paging");
  entries.sort((a, b) => a.slug.localeCompare(b.slug) || a.path.localeCompare(b.path) || a.commit.localeCompare(b.commit));
  const revision = stateHash([realpathSync(root), metadata.dev, metadata.ino, slugs, before, entries, [...paths.values()], remotes, shallow]);
  if (input.revision && input.revision !== revision) throw new Error("Vault history changed; restart paging");
  return { entries: entries.slice(input.offset, input.offset + input.limit), revision, nextOffset: input.offset + input.limit < entries.length ? input.offset + input.limit : null,
    commitsScanned: before.length, paths: [...paths.values()].sort((a, b) => a.path.localeCompare(b.path)), remotes,
    retained: ["Read-only path retention disclosure, not an erasure plan: ordinary deletion tombstones, local commits/blobs remain",
      "Coverage: every selected-slug path in commits reachable from all local refs and reflogs. Renamed paths with a different slug, unreachable loose objects and external clones/backups are not inventoried",
      shallow ? "Repository is shallow: unobserved older upstream history remains" : "Observed repository is not shallow; external remotes and backups are still unobservable",
      "Remote names/presence are disclosed without credential-bearing URLs; remote contents, filesystem snapshots/backups and device copies remain unobservable. No network, Git writes or history rewrite occurs"] };
}
