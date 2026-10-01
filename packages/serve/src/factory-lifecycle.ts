import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { socketCall, socketPath, stateDir } from "@stack/api";
import { observeAuthFactoryReset, clearAuthFactoryCredentials } from "@stack/auth";
import { observeWorkerFactoryReset, clearWorkerFactoryWorktrees } from "@stack/worker";
import { factoryRoleLaunchBlockers } from "@stack/roles";
import { retainFactoryVault } from "@stack/content";
import type { BrowserResetSnapshot } from "@stack/browse";
import type { FactoryResetHooks } from "./factory-reset.js";
import type { RunningServer } from "./server.js";

/** Parent integration, not a second offline Server. Keeps Browse alive only
 * for the exact reset callback after other owners have drained. */
export function factoryLifecycle(env: NodeJS.ProcessEnv, server: RunningServer, ingress: () => Promise<void>, finish: FactoryResetHooks["finish"]): FactoryResetHooks {
  const root = resolve(stateDir(env));
  return {
    async inspect() {
      const db = new DatabaseSync(join(root, "access", "access.db"), { readOnly: true });
      let serverId: string;
      try { serverId = (db.prepare("SELECT uuid FROM instance WHERE id=1").get() as { uuid: string }).uuid; } finally { db.close(); }
      const browser = await socketCall(socketPath("browse", env), "tools/call", { name: "browser_factory_reset_inspect", arguments: {} }) as BrowserResetSnapshot;
      return { serverId, auth: observeAuthFactoryReset(root), worker: await observeWorkerFactoryReset(root), browser, roleBlockers: await factoryRoleLaunchBlockers(root) };
    },
    async quiesce() {
      await ingress();
      for (const owner of ["proc", "signal", "infer", "auth", "worker", "hud", "bots", "usage", "brain", "xcom", "scrape", "content", "roles", "notify", "api"]) await server.stop([owner], { graceful: true });
    },
    async cleanup(selection, requestId, progress) {
      const blockers = await factoryRoleLaunchBlockers(root); if (blockers.length) throw new Error(blockers.join("; "));
      const result = await socketCall(socketPath("browse", env), "tools/call", { name: "browser_factory_reset_clear", arguments: { requestId, snapshot: selection.browser } }, { timeoutMs: 120_000 }) as { status: string; outcomes: Parameters<typeof progress>[0][] };
      for (const outcome of result.outcomes) progress({ ...outcome, resource: `browser:${outcome.resource}` });
      if (result.status !== "completed") throw new Error("Browser resources are unresolved; retain installation fence");
      await server.stop(["browse"], { graceful: true });
      await clearAuthFactoryCredentials(root, selection.auth, progress);
      await clearWorkerFactoryWorktrees(root, selection.worker, progress);
      await retainFactoryVault(root, requestId, progress);
    },
    finish,
  };
}
