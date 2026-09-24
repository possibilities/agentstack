import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AcpProcess, record } from "../src/acp.js";
import { effortOption, modelOption, optionsOf } from "../src/catalog.js";
import { accountEnvironment, accountRoot, credentialEvidence, prepareAccountProfile, type WorkerAccount } from "@agentstack/auth";

test("installed OpenCode and Devin ACP advertise no-turn session choices", {
  skip: process.env.AGENTSTACK_NATIVE_ACP_PROBE !== "1",
  timeout: 90_000,
}, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-acp-no-turn-"));
  try {
    const nativeAuth = JSON.parse(await readFile(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")) as Record<string, unknown>;
    console.log(JSON.stringify({ openCodeAuthShape: Object.fromEntries(["openai", "xai"].map((provider) => [provider,
      record(nativeAuth[provider]) ? { type: nativeAuth[provider].type, hasAccountId: typeof nativeAuth[provider].accountId === "string" } : null])) }));
    for (const [binary, args] of [["opencode", ["acp"]], ["devin", ["acp"]]] as const) {
      const process = new AcpProcess(binary, [...args], cwd, globalThis.process.env);
      try {
        const initialized = await process.initialize();
        const session = await process.request("session/new", { cwd, mcpServers: [] }, 45_000);
        assert.ok(record(session) && typeof session.sessionId === "string");
        const options = optionsOf(session);
        const model = modelOption(options);
        const effort = effortOption(options);
        const selected: Array<{ id: string; efforts: string[] }> = [];
        for (const choice of model?.values.slice(0, 2) ?? []) {
          const changed = await process.request("session/set_config_option", { sessionId: session.sessionId, configId: model!.id, value: choice.value });
          selected.push({ id: choice.value, efforts: effortOption(optionsOf(changed))?.values.map((item) => item.value) ?? [] });
        }
        console.log(JSON.stringify({ binary, version: record(initialized.agentInfo) ? initialized.agentInfo.version : null,
          modelOptions: model?.values.length ?? 0, selected,
          modelConfigId: model?.id ?? null, effortConfigId: effort?.id ?? null,
          effortOptions: effort?.values.length ?? 0 }));
      } finally { await process.close(); }
    }
    for (const provider of ["openai", "xai"] as const) {
      const config = join(cwd, `${provider}.json`);
      await writeFile(config, JSON.stringify({ enabled_providers: [provider], autoupdate: false }));
      const env: NodeJS.ProcessEnv = { ...globalThis.process.env, OPENCODE_CONFIG: config, OPENCODE_CONFIG_DIR: cwd };
      delete env.OPENCODE_CONFIG_CONTENT;
      const process = new AcpProcess("opencode", ["acp"], cwd, env);
      try {
        await process.initialize();
        const session = await process.request("session/new", { cwd, mcpServers: [] });
        const choices = modelOption(optionsOf(session))?.values ?? [];
        assert.ok(choices.length > 0);
        assert.ok(choices.every((choice) => choice.value.startsWith(`${provider}/`)));
        console.log(JSON.stringify({ filteredProvider: provider, models: choices.length }));
      } finally { await process.close(); }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("installed ACP harnesses use disposable, account-isolated native sign-ins", {
  skip: process.env.AGENTSTACK_NATIVE_ACP_PROBE !== "1",
  timeout: 90_000,
}, async (t) => {
  const state = await mkdtemp(join(tmpdir(), "agentstack-acp-accounts-"));
  try {
    const saved = JSON.parse(await readFile(join(homedir(), ".local", "share", "opencode", "auth.json"), "utf8")) as Record<string, unknown>;
    for (const [provider, nativeProvider] of [["codex", "openai"], ["grok", "xai"]] as const) {
      const native = saved[nativeProvider];
      if (!record(native) || typeof native.expires !== "number" || native.expires < Date.now() + 5 * 60_000) {
        t.diagnostic(`${provider} native OAuth token was too close to expiry for a safe no-refresh copy`);
        continue;
      }
      const account: WorkerAccount = { id: randomUUID(), provider, enabled: true, ready: true, removing: false };
      await prepareAccountProfile(state, account);
      const authPath = join(accountRoot(state, account.id), "data", "opencode", "auth.json");
      await mkdir(join(accountRoot(state, account.id), "data", "opencode"), { recursive: true, mode: 0o700 });
      await writeFile(authPath, JSON.stringify({ [nativeProvider]: native }), { mode: 0o600 });
      assert.ok((await credentialEvidence(state, account)).digest);
      const child = new AcpProcess("opencode", ["acp"], join(accountRoot(state, account.id), "probe"), accountEnvironment(state, account));
      try {
        await child.initialize();
        const session = await child.request("session/new", { cwd: join(accountRoot(state, account.id), "probe"), mcpServers: [] });
        const choices = modelOption(optionsOf(session))?.values ?? [];
        assert.ok(choices.length > 0);
        assert.ok(choices.every((choice) => choice.value.startsWith(`${nativeProvider}/`)));
        console.log(JSON.stringify({ isolatedProvider: provider, models: choices.length }));
      } finally { await child.close(); }
    }

    const devin: WorkerAccount = { id: randomUUID(), provider: "devin", enabled: true, ready: true, removing: false };
    await prepareAccountProfile(state, devin);
    const nativeCredentials = join(homedir(), ".local", "share", "devin", "credentials.toml");
    const target = join(accountRoot(state, devin.id), "data", "devin", "credentials.toml");
    await mkdir(join(accountRoot(state, devin.id), "data", "devin"), { recursive: true, mode: 0o700 });
    await copyFile(nativeCredentials, target);
    await chmod(target, 0o600);
    assert.ok((await credentialEvidence(state, devin)).digest);
    const child = new AcpProcess("devin", ["acp"], join(accountRoot(state, devin.id), "probe"), accountEnvironment(state, devin));
    try {
      await child.initialize();
      const session = await child.request("session/new", { cwd: join(accountRoot(state, devin.id), "probe"), mcpServers: [] });
      assert.ok((modelOption(optionsOf(session))?.values.length ?? 0) > 0);
      console.log(JSON.stringify({ isolatedProvider: "devin", models: modelOption(optionsOf(session))?.values.length ?? 0 }));
    } finally { await child.close(); }
  } finally { await rm(state, { recursive: true, force: true }); }
});
