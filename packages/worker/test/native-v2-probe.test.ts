import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { accountEnvironment, accountRoot, prepareAccountProfile, type WorkerAccount } from "@agentstack/auth";
import { AcpProcess, record } from "../src/acp.js";
import { effortOption, modelOption, optionsOf } from "../src/catalog.js";

const list = (binary: string, cwd: string, env: NodeJS.ProcessEnv) => new Promise<unknown>((resolve, reject) =>
  execFile(binary, ["auth", "list", "--format", "json", "--standalone"], { cwd, env, timeout: 20_000, maxBuffer: 200_000 },
    (error, stdout) => { if (error) reject(new Error("OpenCode V2 auth list failed")); else try { resolve(JSON.parse(stdout)); } catch { reject(new Error("OpenCode V2 auth list was not JSON")); } }));

test("OpenCode V2 advertises account-specific ACP options for isolated native credentials", {
  skip: process.env.AGENTSTACK_NATIVE_V2_PROBE !== "1", timeout: 90_000,
}, async () => {
  const binary = join(homedir(), ".local", "bin", "opencode");
  for (const [workerProvider, nativeProvider] of [["grok", "xai"], ["codex", "openai"]] as const) {
    const root = await mkdtemp(join(tmpdir(), "as-v2-acp-"));
    const account: WorkerAccount = { id: randomUUID(), provider: workerProvider, enabled: true, ready: false, removing: false };
    await prepareAccountProfile(root, account);
    const env = accountEnvironment(root, account);
    const cwd = join(accountRoot(root, account.id), "probe");
    try {
      await list(binary, cwd, env);
      const db = new DatabaseSync(join(accountRoot(root, account.id), "data", "opencode", "opencode.db"));
      try {
        db.prepare("INSERT INTO credential (id, integration_id, label, value, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)")
          .run(`cred_${randomUUID().replaceAll("-", "")}`, nativeProvider, "OAuth", JSON.stringify({ type: "oauth", methodID: "oauth",
            access: "disposable-catalog-test", refresh: "disposable-catalog-test", expires: Date.now() + 86_400_000,
            ...(nativeProvider === "openai" ? { metadata: { accountID: "disposable-test" } } : {}) }), Date.now(), Date.now());
      } finally { db.close(); }
      const auth = await list(binary, cwd, env);
      assert.ok(Array.isArray(auth) && auth.length === 1 && record(auth[0]) && auth[0].id === nativeProvider);
      const child = new AcpProcess(binary, ["acp"], cwd, env);
      try {
        await child.initialize();
        const session = await child.request("session/new", { cwd, mcpServers: [] }, 45_000);
        assert.ok(record(session) && typeof session.sessionId === "string");
        const model = modelOption(optionsOf(session));
        const preferred = nativeProvider === "xai" ? "xai/grok-build-0.1" : "openai/gpt-5.3-codex";
        const own = model?.values.find((item) => item.value === preferred) ?? (nativeProvider === "openai"
          ? model?.values.find((item) => item.value.startsWith("openai/gpt-5")) : undefined);
        assert.ok(own, `no ${nativeProvider} model was offered by isolated V2 ACP`);
        assert.ok(model!.values.every((item) => item.value.startsWith(`${nativeProvider}/`)));
        const changed = await child.request("session/set_config_option", { sessionId: session.sessionId, configId: model!.id, value: own.value });
        console.log(JSON.stringify({ provider: nativeProvider, modelOptions: model!.values.length, selected: own.value,
          efforts: effortOption(optionsOf(changed))?.values.map((item) => item.value) ?? [] }));
      } finally { await child.close(); }
    } finally { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  }
});
