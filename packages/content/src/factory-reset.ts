import { lstatSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { retainStateDirectory, snapshotStateFiles, type StateOutcome } from "@stack/api";
import { z } from "zod";

/** Factory reset starts a new empty Vault, without rewriting/removing the old
 * authored Git history. Relocate, do not copy or reconcile, the exact old Vault. */
export async function retainFactoryVault(root: string, generation: string, progress: (outcome: StateOutcome) => void) {
  z.uuid().parse(generation);
  const wiki = join(root, "wiki"), vault = join(wiki, "vault");
  if (!existsSync(vault)) return;
  const stat = lstatSync(vault);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Vault retention ownership is unavailable");
  if (!existsSync(join(vault, ".git"))) return;
  const metadata = lstatSync(join(vault, ".git"));
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.()) throw new Error("Linked/external Vault Git ownership is unverified; installation deletion is refused");
  const retained = join(realpathSync(dirname(root)), `${basename(root)}.retained-git`);
  mkdirSync(retained, { recursive: true, mode: 0o700 });
  const destination = lstatSync(retained);
  if (!destination.isDirectory() || destination.isSymbolicLink() || destination.uid !== process.getuid?.() || destination.mode & 0o077) throw new Error("Vault retention destination is unsafe");
  const snapshot = await snapshotStateFiles(wiki, { paths: ["vault"] });
  await retainStateDirectory(wiki, "vault", retained, generation, snapshot);
  progress({ resource: "content:vault-git", outcome: "retained", detail: `Old Vault files/Git retained at sibling ${basename(root)}.retained-git/${generation}/vault; new active Vault starts empty. Remotes/backups remain.` });
}
