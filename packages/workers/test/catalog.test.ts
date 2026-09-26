import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveApi, socketCall, socketPath } from "@agentstack/api";
import { WorkerSupervisor } from "../src/supervisor.js";
import { catalogModels, nativeDevinModels, optionsOf } from "../src/catalog.js";
import { writeV2Credential } from "./v2-credential-fixture.js";

const fake = `#!/usr/bin/env node
import { basename } from 'node:path';
if (process.argv[2] === '--version') { console.log('fake-acp 2.0'); process.exit(0); }
if (process.argv[2] === 'models') { console.log(JSON.stringify({ families: [{ variants: [{ model_uid: 'native-1' }] }] })); process.exit(0); }
let buffer = '';
let selected = '';
const id = basename(process.env.XDG_DATA_HOME.replace(/\\/data$/, ''));
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\\n');
    if (end < 0) break;
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const message = JSON.parse(line);
    let result;
    if (message.method === 'initialize') result = { protocolVersion: 1, agentInfo: { name: 'fake', version: 'test' }, agentCapabilities: { loadSession: true } };
    else if (message.method === 'session/new' || message.method === 'session/load') result = { sessionId: id, configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: id + '-small', options: [
        { value: id + '-small', name: 'Small' }, { value: id + '-large', name: 'Large' }, { value: id + '-plain', name: 'Plain' }, { value: id + '-imagine', name: 'Imagine' }] },
      { id: 'thinking', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] }] };
    else if (message.method === 'session/set_config_option') {
      selected = message.params.value;
      result = { configOptions: selected.endsWith('plain') ? [] : [{ id: 'thinking', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'low',
        options: selected.endsWith('large') ? [{ value: 'high', name: 'High' }, { value: 'max', name: 'Max' }] : [{ value: 'low', name: 'Low' }] }] };
    } else throw new Error('unexpected method: ' + message.method);
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});`;

test("ACP catalog reflects the exact account process and dependent effort choices without turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-worker-catalog-"));
  const binary = join(dir, "fake-acp");
  await writeFile(binary, fake);
  await chmod(binary, 0o700);
  const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, AGENTSTACK_OPENCODE_BIN: binary, AGENTSTACK_DEVIN_BIN: binary };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const supervisor = new WorkerSupervisor(dir, env);
  try {
    const prepare = async (provider: "grok" | "codex" = "grok") => {
      const response = await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_prepare", arguments: { provider } }) as { account: { id: string } };
      const id = response.account.id;
      const accountDir = join(dir, "worker-accounts", id, "data", "opencode");
      await (await import("node:fs/promises")).mkdir(accountDir, { recursive: true });
      await writeV2Credential(join(accountDir, "opencode.db"), provider === "grok" ? "xai" : "openai",
        JSON.stringify({ type: "oauth", access: id, refresh: id, metadata: { accountID: "acct-" + id } }));
      await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_confirm", arguments: { id } });
      return id;
    };
    const first = await prepare();
    const second = await prepare();
    const codex = await prepare("codex");
    const { account: devinAccount } = await socketCall(socketPath("auth", env), "tools/call", {
      name: "worker_account_prepare", arguments: { provider: "devin" } }) as { account: { id: string } };
    const devin = devinAccount.id;
    const devinDir = join(dir, "worker-accounts", devin, "data", "devin");
    await (await import("node:fs/promises")).mkdir(devinDir, { recursive: true });
    await writeFile(join(devinDir, "credentials.toml"), 'api_key = "test-key"\napi_server_url = "https://api.devin.ai/"\n', { mode: 0o600 });
    await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_confirm", arguments: { id: devin } });
    await supervisor.reconcile();
    const a = await supervisor.catalog(first, true);
    const b = await supervisor.catalog(second, true);
    const c = await supervisor.catalog(codex, true);
    const d = await supervisor.catalog(devin, true);
    assert.equal(a.models.length, 3);
    assert.deepEqual(a.models.map((model) => model.efforts), [["low"], ["high", "max"], []]);
    assert.ok(a.models.every((model) => model.id.startsWith(first) && !model.id.endsWith("imagine")), "Grok omits Imagine media models");
    assert.ok(b.models.every((model) => model.id.startsWith(second)));
    assert.notEqual(a.models[0]!.id, b.models[0]!.id);
    assert.deepEqual(c.models.map((model) => model.id), [codex + "-small", codex + "-large", codex + "-imagine"], "Codex catalogs omit entries without effort choices");
    assert.deepEqual(d.models.map((model) => model.id), [devin + "-small", devin + "-large", devin + "-imagine"], "Devin catalogs omit entries without effort choices");
    assert.deepEqual(d.nativeModelIds, ["native-1"]);
    assert.equal((await supervisor.catalog(first, false)).observedAt, a.observedAt);
    assert.equal(supervisor.runtimeList().length, 4);
    await supervisor.drain(second);
    const stale = await supervisor.catalog(second, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.observedAt, b.observedAt);
    assert.equal((await supervisor.catalog(second, false)).stale, true);
    await socketCall(socketPath("auth", env), "tools/call", { name: "worker_account_set_enabled", arguments: { id: first, enabled: false } }).catch(() => undefined);
    await supervisor.reconcile();
    assert.equal(supervisor.runtimeList().length, 3);
  } finally {
    await supervisor.close();
    await auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog parsing preserves native IDs and grouped ACP options", () => {
  assert.deepEqual(nativeDevinModels({ families: [{ variants: [{ model_uid: "exact-native-id" }] }] }), ["exact-native-id"]);
  assert.deepEqual(optionsOf({ configOptions: [{ id: "model", name: "Model", category: "model", type: "select", options: [
    { group: "recommended", name: "Recommended", options: [{ value: "exact-acp-id", name: "Model" }] },
  ] }] })[0]?.values, [{ value: "exact-acp-id", name: "Model" }]);
  const choice = (id: string, efforts: string[] = ["low"]) => ({ id, name: id, efforts, effortConfigId: efforts.length ? "thinking" : null });
  assert.deepEqual(catalogModels("codex", [
    choice("openai/gpt-4o", []), choice("openai/o3"), choice("openai/o3-pro"), choice("openai/gpt-realtime-2.1"),
    choice("openai/gpt-image-2"), choice("openai/chatgpt-image-latest"), choice("openai/gpt-5.6-sol"), choice("openai/o4-mini"),
  ]).map((model) => model.id), ["openai/gpt-5.6-sol", "openai/o4-mini"], "Codex reports only current reasoning models");
  assert.deepEqual(catalogModels("grok", [
    choice("xai/grok-4.20-0309-non-reasoning", []), choice("xai/grok-imagine-video"), choice("xai/grok-4.7"),
  ]).map((model) => model.id), ["xai/grok-4.20-0309-non-reasoning", "xai/grok-4.7"], "Grok keeps no-effort chat models");
  assert.deepEqual(catalogModels("devin", [choice("adaptive", []), choice("MODEL_PRIVATE_11", []), choice("swe-2-high")]).map((model) => model.id),
    ["swe-2-high"], "Devin omits entries without effort choices");
});

test("operator disable and removal drain the exact account process before deleting credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agentstack-worker-lifecycle-"));
  const binary = join(dir, "fake-acp");
  await writeFile(binary, fake);
  await chmod(binary, 0o700);
  const env = { ...process.env, AGENTSTACK_STATE_DIR: dir, AGENTSTACK_OPENCODE_BIN: binary };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const workers = await serveApi({ name: "workers", transport: "socket", env });
  const call = (name: string, args: object) => socketCall(socketPath("auth", env), "tools/call", { name, arguments: args });
  try {
    const { account } = await call("worker_account_prepare", { provider: "grok" }) as { account: { id: string } };
    assert.deepEqual((await call("worker_account_list", {}) as { accounts: unknown[] }).accounts, [
      { id: account.id, provider: "grok", enabled: true, ready: false, removing: false, linkedAccounts: [] },
    ]);
    const root = join(dir, "worker-accounts", account.id);
    await (await import("node:fs/promises")).mkdir(join(root, "data", "opencode"), { recursive: true });
     await writeV2Credential(join(root, "data", "opencode", "opencode.db"), "xai", JSON.stringify({ type: "oauth", access: "first", refresh: "first" }));
    await call("worker_account_confirm", { id: account.id });
    const runtimes = async () => (await socketCall(socketPath("workers", env), "tools/call", {
      name: "worker_runtime_list", arguments: {},
    }) as { runtimes: Array<{ id: string }> }).runtimes;
    for (let attempt = 0; attempt < 40 && !(await runtimes()).some((item) => item.id === account.id); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await runtimes()).length, 1);
    const catalog = await socketCall(socketPath("workers", env), "tools/call", {
      name: "worker_catalog", arguments: { accountId: account.id },
    }) as { models: unknown[]; runtimeVersion: string; stale: boolean };
    assert.equal(catalog.models.length, 3);
     assert.equal(catalog.runtimeVersion, "fake-acp 2.0");
    assert.equal(catalog.stale, false);
    await call("worker_account_set_enabled", { id: account.id, enabled: false });
    assert.equal((await runtimes()).length, 0);
    await call("worker_account_set_enabled", { id: account.id, enabled: true });
    for (let attempt = 0; attempt < 40 && !(await runtimes()).some((item) => item.id === account.id); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await runtimes()).length, 1);
    await call("worker_account_remove", { id: account.id });
    assert.equal((await runtimes()).length, 0);
    await assert.rejects(stat(root), /ENOENT/);
    assert.deepEqual((await call("worker_account_list", {}) as { accounts: unknown[] }).accounts, []);

    const { account: codex } = await call("worker_account_prepare", { provider: "codex" }) as { account: { id: string } };
    assert.deepEqual((await call("account_list", {}) as { accounts: unknown[] }).accounts, []);
    const codexRoot = join(dir, "worker-accounts", codex.id);
    await (await import("node:fs/promises")).mkdir(join(codexRoot, "data", "opencode"), { recursive: true });
    await writeV2Credential(join(codexRoot, "data", "opencode", "opencode.db"), "openai",
      JSON.stringify({ type: "oauth", access: "codex-access", refresh: "codex-refresh", metadata: { accountID: "worker-only-codex" } }));
    await call("worker_account_confirm", { id: codex.id });
    for (let attempt = 0; attempt < 40 && !(await runtimes()).some((item) => item.id === codex.id); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual((await runtimes()).map((item) => item.id), [codex.id]);
    const codexCatalog = await socketCall(socketPath("workers", env), "tools/call", {
      name: "worker_catalog", arguments: { accountId: codex.id },
    }) as { models: Array<{ id: string; efforts: string[] }> };
    assert.equal(codexCatalog.models.length, 3, "Codex catalogs omit entries without effort choices");
    await call("worker_account_remove", { id: codex.id });
    assert.equal((await runtimes()).length, 0);
  } finally {
    await workers.close();
    await auth.close();
    await rm(dir, { recursive: true, force: true });
  }
});
