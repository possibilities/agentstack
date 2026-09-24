import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe, type ServedApi, type SocketSubscription } from "@agentstack/api";
import { StateStore } from "../src/store.js";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));
type View = { id: string; pid: number | null; cwd: string; url: string | null; state: string; account: string | null; runningAccount: string | null; mainThreadId: string | null; settings: { model: string; reasoningEffort: string; sandboxMode: string; approvalPolicy: string } };
function call(socket: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return socketCall(socket, "tools/call", { name, arguments: args }, { timeoutMs: 30_000 });
}

test("bots own the complete app-server lifecycle on one socket", { timeout: 120_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-bots-state-"));
  const home = await mkdtemp(join(tmpdir(), "agentstack-bots-home-"));
  const external = await mkdtemp(join(tmpdir(), "agentstack-bots-external-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const runtime = join(home, ".local", "libexec", "codexnk", "codex");
  await mkdir(join(runtime, ".."), { recursive: true });
  await symlink(fakeBin, runtime);
  const store = new StateStore(stateDir);
  const account = store.addAccount(JSON.stringify({ tokens: { refresh_token: "test", access_token: "access", id_token: "fixture.jwt.signature" } })).id;
  store.close();
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  let bots: ServedApi | undefined = await serveApi({ name: "bots", transport: "socket", env });
  const socket = bots.socketPath ?? "";
  let subscription: SocketSubscription | undefined;
  let defaultsSubscription: SocketSubscription | undefined;
  try {
    const tools = await socketCall(socket, "tools/list") as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; events: { scope: { required: boolean } } };
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["bot_start", "bot_stop", "bot_assign", "bot_remove", "bot_list", "bot_defaults_get", "bot_defaults_set", "voice_status", "voice_dial", "voice_hangup"]);
    assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties).sort(), ["args", "cwd", "id", "settings"]);
    assert.equal(tools.events.scope.required, false);
    const initial = await call(socket, "bot_defaults_get") as View["settings"];
    assert.deepEqual(initial, { model: "gpt-6-sol", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" });

    const first = await call(socket, "bot_start", { args: ["-c", 'model="gpt-5.4"'] }) as View;
    assert.equal(first.id, "bot-1");
    assert.equal(first.cwd, join(stateDir, "bots", "bot-1"));
    assert.equal(first.account, account);
    assert.equal(first.state, "running");
    assert.equal(first.mainThreadId, null);
    assert.deepEqual(first.settings, initial);
    assert.equal((await lstat(first.cwd)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(stateDir, "bots", "ledger.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await call(socket, "bot_start", { id: first.id }) as View).pid, first.pid);
    await assert.rejects(call(socket, "bot_start", { id: first.id, args: [] }), /stop it before changing args/);
    await assert.rejects(call(socket, "bot_start", { id: first.id, settings: { reasoningEffort: "high" } }), /stop it before changing settings/);

    const defaultNotices: string[] = [];
    defaultsSubscription = await socketSubscribe(socket, ["defaults_changed"], (topic) => defaultNotices.push(topic));
    const changed = await call(socket, "bot_defaults_set", { model: "gpt-custom", reasoningEffort: "high", sandboxMode: "read-only", approvalPolicy: "on-request" }) as View["settings"];
    assert.deepEqual(await call(socket, "bot_defaults_get"), changed);
    for (let i = 0; i < 100 && !defaultNotices.includes("defaults_changed"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(defaultNotices.includes("defaults_changed"));
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots[0]?.settings, initial);

    const notices: string[] = [];
    subscription = await socketSubscribe(socket, ["bots_changed", "threads_changed"], (topic) => notices.push(topic), { scope: first.id });
    await new Promise((resolve) => setTimeout(resolve, 30)); // Initial thread-watch invalidation may arrive after subscribing.
    notices.length = 0;
    const custom = await call(socket, "bot_start", { id: "custom", cwd: external }) as View;
    assert.equal(custom.cwd, external);
    assert.deepEqual(custom.settings, changed);
    const named = await call(socket, "bot_start", { id: "named", settings: { model: "gpt-6-sol", reasoningEffort: "medium" } }) as View;
    assert.equal(named.cwd, join(stateDir, "bots", "named"));
    assert.deepEqual(named.settings, { ...changed, model: "gpt-6-sol", reasoningEffort: "medium" });
    assert.equal((await call(socket, "bot_list") as { bots: View[] }).bots.length, 3);
    assert.equal(notices.length, 0);
    await call(socket, "bot_stop", { id: first.id });
    for (let i = 0; i < 100 && !notices.includes("bots_changed"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices.includes("bots_changed"));
    await call(socket, "bot_start", { id: first.id, args: [] });
    const saved = new StateStore(stateDir);
    assert.deepEqual(saved.servers().find((entry) => entry.id === first.id)?.args, []);
    saved.close();

    const second = await call(socket, "bot_start") as View;
    assert.equal(second.id, "bot-2");
    assert.deepEqual(second.settings, changed);
    await bots.close();
    bots = await serveApi({ name: "bots", transport: "socket", env });
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots.map((bot) => bot.id), ["bot-1", "custom", "named", "bot-2"]);
    assert.deepEqual(await call(socket, "bot_defaults_get"), changed);
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots[0]?.settings, initial);
    assert.ok((await call(socket, "bot_list") as { bots: View[] }).bots.every((bot) => bot.state === "running"));
    await call(socket, "bot_remove", { id: "custom" });
    assert.equal((await lstat(external)).isDirectory(), true);
    await call(socket, "bot_remove", { id: "named" });
    await assert.rejects(lstat(named.cwd), /ENOENT/);
    await call(socket, "bot_remove", { id: first.id });
    await assert.rejects(lstat(first.cwd), /ENOENT/);
    await call(auth.socketPath ?? "", "account_remove", { id: account });
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots, []);
    await assert.rejects(lstat(second.cwd), /ENOENT/);
  } finally {
    await subscription?.close();
    await defaultsSubscription?.close();
    await bots?.close();
    await auth.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    await rm(stateDir, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("bots refuse a workspace root that is not a real directory", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-bots-rootstate-"));
  const target = await mkdtemp(join(tmpdir(), "agentstack-bots-roottarget-"));
  const root = join(stateDir, "bots");
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  try {
    await symlink(target, root);
    await assert.rejects(serveApi({ name: "bots", transport: "socket", env }), /not a directory/);
    await rm(root);
    await writeFile(root, "not a directory");
    await assert.rejects(serveApi({ name: "bots", transport: "socket", env }), /not a directory/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});
