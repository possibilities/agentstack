import { lstatSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { stateHash, type StateOutcome } from "@stack/api";
import { removeClaudeCredentials, claudeConfigRoot, claudeKeychainService, type ClaudeCredentialOptions } from "./claude-credentials.js";

export function observeAuthFactoryReset(root: string) {
  const db = new DatabaseSync(join(root, "configuration.sqlite"), { readOnly: true });
  try {
    const accounts = db.prepare("SELECT name AS id FROM accounts ORDER BY name").all() as { id: string }[];
    const workers = db.prepare("SELECT id,provider FROM worker_accounts ORDER BY id").all() as { id: string; provider: string }[];
    const blockedBy: string[] = [];
    for (const account of [...accounts, ...workers]) z.uuid().parse(account.id);
    const profiles = workers.filter(account => account.provider === "claude").map(account => {
      const profile = claudeConfigRoot(root, account.id), path = join(profile, ".stack-profile.json");
      for (const directory of [join(root, "worker-accounts"), join(root, "worker-accounts", account.id), profile]) {
        if (!existsSync(directory)) continue;
        const stat = lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Auth profile directory scope is unsafe");
      }
      if (!existsSync(path)) return { id: account.id, marker: null };
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 128_000) throw new Error("Auth profile identity is unsafe");
      const body = readFileSync(path, "utf8"), marker = JSON.parse(body);
      if (marker.version !== 1 || marker.service !== claudeKeychainService(profile)) throw new Error("Auth keychain scope is unverified");
      return { id: account.id, marker: stateHash(body) };
    });
    const profileRoot = join(root, "worker-accounts");
    if (existsSync(profileRoot)) for (const id of readdirSync(profileRoot)) if (!workers.some(account => account.id === id)) blockedBy.push("Unattributed native account profile remains; inspect external keychain scope before installation reset");
    if (workers.some(account => !["codex", "devin", "claude"].includes(account.provider))) blockedBy.push("Auth has unsupported legacy native profiles; exact external credential scope is unverified");
    return { accounts, workers, profiles, blockedBy, revision: stateHash([accounts, workers, profiles]) };
  } finally { db.close(); }
}
/** Called only by the parent after verified Auth/native shutdown. State-root
 * files are cleared later; this owner removes only exact profile keychain items. */
export async function clearAuthFactoryCredentials(root: string, expected: ReturnType<typeof observeAuthFactoryReset>, progress: (outcome: StateOutcome) => void, options: ClaudeCredentialOptions = {}) {
  const current = observeAuthFactoryReset(root);
  if (current.revision !== expected.revision || current.blockedBy.length) throw new Error("Auth factory-reset identity changed or is unverified");
  for (const profile of current.profiles) {
    await removeClaudeCredentials(root, profile.id, options);
    progress({ resource: `auth:${profile.id}`, outcome: "removed", detail: "Exact profile-owned native keychain item removed/absent; ambient personal keychains untouched" });
  }
}
