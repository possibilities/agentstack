import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { stateDir } from "./workspace.js";

export const installationFence = z.strictObject({ version: z.literal(1), requestId: z.uuid(), generation: z.uuid(), nextGeneration: z.uuid(), pid: z.number().int().positive(), browserRevision: z.string() });
export type InstallationFence = z.infer<typeof installationFence>;
export function installationControlRoot(env: NodeJS.ProcessEnv = process.env) {
  const root = resolve(stateDir(env)), parent = dirname(root);
  return join(existsSync(parent) ? realpathSync(parent) : parent, `${basename(root)}.factory-control`);
}
export function readInstallationFence(env: NodeJS.ProcessEnv = process.env): InstallationFence | null {
  const control = installationControlRoot(env), path = join(control, "fence.json");
  let directory;
  try { directory = lstatSync(control); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid?.() || directory.mode & 0o077) throw new Error("Installation reset control directory is unsafe");
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 8192) throw new Error("Installation reset fence is unsafe");
    return installationFence.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
export function assertInstallationOpen(env: NodeJS.ProcessEnv = process.env, operation?: string) {
  const fence = readInstallationFence(env);
  // These exceptions admit no new work/identity/configuration. Reset effects
  // independently require the exact admitted request and pinned selection.
  if (fence && !["serve_factory_reset_receipt_get", "serve_factory_reset_clear", "browser_factory_reset_clear", "browser_bot_release", "browser_session_close", "worker_account_drain"].includes(operation ?? ""))
    throw new Error(`Installation factory reset is fenced (${fence.requestId}); inspect its cold receipt. No new work or automatic restart is allowed.`);
}
