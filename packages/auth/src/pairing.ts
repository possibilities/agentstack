import type { AuthStore } from "./store.js";
import { credentialEvidence } from "./worker-accounts.js";

/**
 * Give every Codex Bot account its paired Codex Worker account. An older,
 * unpaired Codex Worker joins the Bot that shares its ID or its native
 * sign-in identity; otherwise the Bot gets a new Worker that needs sign-in.
 * Returns whether any pairing changed.
 */
export async function pairCodexWorkers(store: AuthStore): Promise<boolean> {
  const pairs = store.workerPairs();
  const paired = new Set(pairs.values());
  const unpaired = store.workerAccounts().filter((account) => account.provider === "codex" && !account.removing && !pairs.has(account.id));
  const identities = new Map<string, string | null>();
  const identity = async (id: string) => {
    if (!identities.has(id)) {
      const account = unpaired.find((item) => item.id === id)!;
      identities.set(id, account.ready ? await credentialEvidence(store.stateDir, account).then((evidence) => evidence.identity, () => null) : null);
    }
    return identities.get(id)!;
  };
  let changed = false;
  for (const bot of store.listAccounts()) {
    if (bot.removing || paired.has(bot.id)) continue;
    const botIdentity = store.botAccountIdentity(bot.id);
    let match = unpaired.find((account) => account.id === bot.id);
    for (const account of unpaired) {
      if (match || !botIdentity) break;
      if (await identity(account.id) === botIdentity) match = account;
    }
    if (match) {
      store.pairWorker(match.id, bot.id);
      unpaired.splice(unpaired.indexOf(match), 1);
    } else store.createPairedWorker(bot.id);
    changed = true;
  }
  return changed;
}
