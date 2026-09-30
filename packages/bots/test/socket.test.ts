import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { operation, serveSocket, stateDependencyInput, stateDependencies, serveApi, socketCall, socketSubscribe, type ServedApi, type SocketSubscription, type StatePlan, type StateReceipt } from "@stack/api";
import { StateStore } from "../src/store.js";
import { chatRpc } from "../src/chats.js";
import { RoleStore } from "@stack/roles";
import type { SettingsView } from "@stack/settings";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));
type View = { id: string; pid: number | null; cwd: string; url: string | null; state: string; account: string | null; runningAccount: string | null; mainThreadId: string | null; settings: { model: string; reasoningEffort: string; sandboxMode: string; approvalPolicy: string } };
function call(socket: string, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return socketCall(socket, "tools/call", { name, arguments: args }, { timeoutMs: 30_000 });
}

test("bots own the complete app-server lifecycle on one socket", { timeout: 120_000 }, async () => {
  const stateDir = await realpath(await mkdtemp(join(tmpdir(), "stack-bots-state-")));
  const home = await mkdtemp(join(tmpdir(), "stack-bots-home-"));
  const external = await mkdtemp(join(tmpdir(), "stack-bots-external-"));
  const savedHome = process.env.HOME;
  process.env.HOME = home;
  const runtime = join(home, ".local", "libexec", "codexnk", "codex");
  await mkdir(join(runtime, ".."), { recursive: true });
  await symlink(fakeBin, runtime);
  const store = new StateStore(stateDir);
  const account = store.addAccount(JSON.stringify({ tokens: { refresh_token: "test", access_token: "access", id_token: "fixture.jwt.signature" } })).id;
  const otherAccount = store.addAccount(JSON.stringify({ tokens: { refresh_token: "other", access_token: "access", id_token: "fixture.jwt.signature" } })).id;
  store.close();
  const roles = new RoleStore(stateDir);
  roles.role(roles.catalog().defaultRoleId!).update(0, { name: "Fixture" });
  roles.close();
  const env = { ...process.env, STACK_STATE_DIR: stateDir };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  let bots: ServedApi | undefined = await serveApi({ name: "bots", transport: "socket", env });
  const socket = bots.socketPath ?? "";
  let subscription: SocketSubscription | undefined;
  let defaultsSubscription: SocketSubscription | undefined;
  try {
    const tools = await socketCall(socket, "tools/list") as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; events: { scope: { required: boolean } } };
    assert.ok(tools.tools.some((tool) => tool.name === "bot_settings_read"));
    assert.deepEqual(Object.keys(tools.tools.find((tool) => tool.name === "bot_start")!.inputSchema.properties).sort(), ["account", "args", "cwd", "id", "settings"]);
    assert.equal(tools.events.scope.required, false);
    const initial = await call(socket, "bot_defaults_get") as View["settings"];
    assert.deepEqual(initial, { model: "gpt-6-sol", reasoningEffort: "medium", sandboxMode: "danger-full-access", approvalPolicy: "never" });

    await assert.rejects(call(socket, "bot_start", {}), /account/);
    await call(auth.socketPath ?? "", "account_set_enabled", { id: account, enabled: false });
    await assert.rejects(call(socket, "bot_start", { account }), /unavailable or disabled/);
    await call(auth.socketPath ?? "", "account_set_enabled", { id: account, enabled: true });
    const first = await call(socket, "bot_start", { account, args: ["-c", 'model="gpt-5.4"'] }) as View;
    assert.equal(first.id, "bot-1");
    assert.equal(first.cwd, join(stateDir, "bots", "bot-1"));
    assert.equal(first.account, account);
    assert.equal(first.state, "running");
    assert.equal(first.mainThreadId, null);
    assert.equal((await call(socket, "chat_main_live", { botId: first.id }) as { threadId: string | null }).threadId, null);
    const opened = await call(socket, "chat_open", { botId: first.id, input: [{ type: "text", text: "first chat" }] }) as { threadId: string; turn: { id: string } };
    assert.equal((await call(socket, "bot_list") as { bots: View[] }).bots[0]?.mainThreadId, opened.threadId);
    const notify = (threadId: string, method: string, params: Record<string, unknown>) => chatRpc(first.url!, "test/notify", { method, params: { threadId, ...params } });
    await notify("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "item/started", { turnId: "other", item: { id: "elsewhere", type: "agentMessage", text: "not this bot" } });
    const liveNotices: string[] = [];
    const liveSubscription = await socketSubscribe(socket, ["chat_live_changed"], (topic) => liveNotices.push(topic), { scope: first.id });
    await notify(opened.threadId, "item/started", { turnId: "turn-live", item: { id: "live", type: "agentMessage", text: "Working" } });
    await notify(opened.threadId, "item/agentMessage/delta", { turnId: "turn-live", itemId: "live", delta: " now" });
    let followed: { items: Array<{ item: { text?: string }; completed: boolean }> } = { items: [] };
    for (let n = 0; n < 100; n++) {
      followed = await call(socket, "chat_main_live", { botId: first.id }) as typeof followed;
      if (followed.items[0]?.item.text === "Working now") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(followed.items.length, 1);
    assert.equal(followed.items[0]?.item.text, "Working now");
    for (let n = 0; n < 100 && liveNotices.length === 0; n++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(liveNotices.length >= 1);
    const cursor = followed as unknown as { instance: string; revision: number };
    const quiet = await call(socket, "chat_main_live", { botId: first.id, after: { instance: cursor.instance, revision: cursor.revision } }) as { reset: boolean; items: unknown[] };
    assert.equal(quiet.reset, false);
    assert.deepEqual(quiet.items, []);
    const burst = liveNotices.length;
    await Promise.all(Array.from({ length: 20 }, () => notify(opened.threadId, "item/agentMessage/delta", { turnId: "turn-live", itemId: "live", delta: "." })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(liveNotices.length > burst && liveNotices.length - burst < 10, `coalesced live notices: ${liveNotices.length - burst}`);
    const delta = await call(socket, "chat_main_live", { botId: first.id, after: { instance: cursor.instance, revision: cursor.revision } }) as { reset: boolean; items: Array<{ item: { text?: string } }> };
    assert.equal(delta.reset, false);
    assert.equal(delta.items[0]?.item.text, "Working now" + ".".repeat(20));
    liveSubscription.close();
    await notify(opened.threadId, "item/completed", { turnId: "turn-live", item: { id: "live", type: "agentMessage", text: "Finished" } });
    for (let n = 0; n < 100; n++) {
      followed = await call(socket, "chat_main_live", { botId: first.id }) as typeof followed;
      if (followed.items[0]?.completed) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(followed.items[0]?.item.text, "Finished");
    await assert.rejects(call(socket, "chat_open", { botId: first.id, input: [{ type: "text", text: "duplicate root" }] }), /already has a main thread/);
    const history = join(stateDir, "history", first.id, "2026", "09", "25");
    await mkdir(history, { recursive: true });
    await writeFile(join(history, `rollout-test-${opened.threadId}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-09-25T00:00:00Z", payload: { id: opened.threadId, session_id: opened.threadId, cwd: first.cwd } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-25T00:00:01Z", payload: { type: "message", role: "user", content: [{ text: "first chat with keyword" }] } }),
      "",
    ].join("\n"));
    assert.equal((await call(socket, "chat_search", { botId: first.id, query: "keyword" }) as { hits: { threadId: string }[] }).hits[0]?.threadId, opened.threadId);
    assert.equal((await call(socket, "chat_list", { botId: first.id }) as { chats: { threadId: string }[] }).chats[0]?.threadId, opened.threadId);
    assert.equal((await call(socket, "chat_records", { botId: first.id, threadId: opened.threadId }) as { records: unknown[] }).records.length, 1);
    await assert.rejects(call(socket, "chat_records", { botId: first.id, threadId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }), /lineage/);
    const descendant = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await writeFile(join(history, `rollout-test-${descendant}.jsonl`), [
      JSON.stringify({ type: "session_meta", timestamp: "2026-09-25T00:00:00Z", payload: { id: descendant, session_id: opened.threadId, parent_thread_id: opened.threadId, cwd: first.cwd } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-09-25T00:00:01Z", payload: { type: "message", role: "user", content: [{ text: "descendant searchable" }] } }), "",
    ].join("\n"));
    assert.equal((await call(socket, "chat_search", { botId: first.id, query: "descendant" }) as { hits: { threadId: string }[] }).hits[0]?.threadId, descendant);
    await assert.rejects(call(socket, "chat_send", { botId: first.id, threadId: descendant, input: [{ type: "text", text: "do not send" }] }), /descendants are read-only/);
    assert.equal(((await call(socket, "chat_thread_read", { botId: first.id, threadId: opened.threadId }) as { thread: { id: string } }).thread.id), opened.threadId);
    const sent = await call(socket, "chat_send", { botId: first.id, threadId: opened.threadId, input: [{ type: "text", text: "follow-up" }] }) as { turn: { id: string } };
    assert.equal((await call(socket, "chat_turns", { botId: first.id, threadId: opened.threadId }) as { data: unknown[] }).data.length, 2);
    assert.equal((await call(socket, "chat_items", { botId: first.id, threadId: opened.threadId }) as { data: unknown[] }).data.length, 2);
    const mainItems = await call(socket, "chat_main_items", { botId: first.id }) as { threadId: string; data: unknown[]; nextCursor: string | null };
    assert.equal(mainItems.threadId, opened.threadId);
    assert.equal(mainItems.data.length, 2);
    assert.equal(mainItems.nextCursor, null);
    assert.equal((await call(socket, "chat_main_live", { botId: first.id }) as { threadId: string }).threadId, opened.threadId);
    assert.deepEqual((await call(socket, "chat_occurrences", { botId: first.id, threadId: opened.threadId, query: "follow" }) as { data: unknown[] }).data, []);
    assert.equal((await call(socket, "chat_steer", { botId: first.id, threadId: opened.threadId, expectedTurnId: sent.turn.id, input: [{ type: "text", text: "steer" }] }) as { turnId: string }).turnId, sent.turn.id);
    await call(socket, "chat_interrupt", { botId: first.id, threadId: opened.threadId, turnId: sent.turn.id });
    const native = await call(socket, "chat_codex_queue_add", { botId: first.id, threadId: opened.threadId, clientUserMessageId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", input: [{ type: "text", text: "native" }] }) as { queuedSubmission: { id: string } };
    assert.ok(native.queuedSubmission.id);
    assert.deepEqual((await call(socket, "chat_codex_queue_list", { botId: first.id, threadId: opened.threadId }) as { data: unknown[] }).data, []);
    await call(socket, "chat_codex_queue_update", { botId: first.id, threadId: opened.threadId, queuedSubmissionId: native.queuedSubmission.id, input: [{ type: "text", text: "edited" }] });
    await call(socket, "chat_codex_queue_reorder", { botId: first.id, threadId: opened.threadId, queuedSubmissionIds: [native.queuedSubmission.id] });
    assert.equal((await call(socket, "chat_codex_queue_delete", { botId: first.id, threadId: opened.threadId, queuedSubmissionId: native.queuedSubmission.id }) as { deleted: boolean }).deleted, true);
    assert.ok((await call(socket, "chat_codex_queue_start", { botId: first.id, threadId: opened.threadId }) as { turn: { id: string } }).turn.id);
    assert.equal((await call(socket, "chat_attachment_add", { botId: first.id, threadId: opened.threadId, attachmentType: "note", identityKey: "one", payload: { x: 1 } }) as { attachment: { identityKey: string } }).attachment.identityKey, "one");
    assert.deepEqual((await call(socket, "chat_attachment_list", { botId: first.id, threadId: opened.threadId }) as { data: unknown[] }).data, []);
    await call(socket, "chat_attachment_remove", { botId: first.id, threadId: opened.threadId, attachmentType: "note", identityKey: "one" });
    const queued = await call(socket, "chat_enqueue", { botId: first.id, threadId: opened.threadId, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", input: [{ type: "text", text: "queued" }] }) as { id: string };
    assert.equal((await call(socket, "chat_queue_list", { botId: first.id, threadId: opened.threadId }) as { entries: { id: string }[] }).entries[0]?.id, queued.id);
    assert.deepEqual(first.settings, initial);
    assert.equal((await lstat(first.cwd)).mode & 0o777, 0o700);
    assert.equal((await lstat(join(stateDir, "bots", "ledger.sqlite"))).mode & 0o777, 0o600);
    assert.equal((await call(socket, "bot_start", { id: first.id, account }) as View).pid, first.pid);
    await assert.rejects(call(socket, "bot_start", { id: first.id, account: otherAccount }), /assigned to a different account/);
    await assert.rejects(call(socket, "bot_start", { id: first.id, account, args: [] }), /stop it before changing args/);
    await assert.rejects(call(socket, "bot_start", { id: first.id, account, settings: { reasoningEffort: "high" } }), /stop it before changing settings/);

    const defaultNotices: string[] = [];
    defaultsSubscription = await socketSubscribe(socket, ["defaults_changed"], (topic) => defaultNotices.push(topic));
    const changed = await call(socket, "bot_defaults_set", { model: "gpt-custom", reasoningEffort: "high", sandboxMode: "read-only", approvalPolicy: "on-request" }) as View["settings"];
    assert.deepEqual(await call(socket, "bot_defaults_get"), changed);
    for (let i = 0; i < 100 && !defaultNotices.includes("defaults_changed"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(defaultNotices.includes("defaults_changed"));
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots[0]?.settings, initial);

    const notices: string[] = [];
    subscription = await socketSubscribe(socket, ["bots_changed", "threads_changed"], (topic) => notices.push(topic), { scope: first.id });
    const custom = await call(socket, "bot_start", { id: "custom", cwd: external, account }) as View;
    assert.equal(custom.cwd, external);
    assert.deepEqual(custom.settings, changed);
    const named = await call(socket, "bot_start", { id: "named", account, settings: { model: "gpt-6-sol", reasoningEffort: "medium" } }) as View;
    assert.equal(named.cwd, join(stateDir, "bots", "named"));
    assert.deepEqual(named.settings, { ...changed, model: "gpt-6-sol", reasoningEffort: "medium" });
    assert.equal((await call(socket, "bot_list") as { bots: View[] }).bots.length, 3);
    // Thread invalidations may arrive independently of Bot lifecycle changes.
    // Exercise that case without discarding any incorrectly scoped bots_changed.
    await notify(opened.threadId, "thread/settings/updated", {});
    for (let i = 0; i < 100 && !notices.includes("threads_changed"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices.includes("threads_changed"));
    assert.equal(notices.includes("bots_changed"), false, `unrelated Bot creation published scoped lifecycle notices: ${JSON.stringify(notices)}`);
    await call(socket, "bot_stop", { id: first.id });
    assert.equal((await call(socket, "chat_main_live", { botId: first.id }) as { instance: string | null }).instance, null);
    for (let i = 0; i < 100 && !notices.includes("bots_changed"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(notices.includes("bots_changed"));
    await call(socket, "bot_start", { id: first.id, account, args: [] });
    const saved = new StateStore(stateDir);
    assert.deepEqual(saved.servers().find((entry) => entry.id === first.id)?.args, []);
    saved.close();

    const second = await call(socket, "bot_start", { account }) as View;
    assert.equal(second.id, "bot-2");
    assert.deepEqual(second.settings, changed);
    await bots.close();
    bots = await serveApi({ name: "bots", transport: "socket", env });
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots.map((bot) => bot.id), ["bot-1", "custom", "named", "bot-2"]);
    assert.deepEqual(await call(socket, "bot_defaults_get"), changed);
    assert.deepEqual((await call(socket, "bot_list") as { bots: View[] }).bots[0]?.settings, initial);
    assert.ok((await call(socket, "bot_list") as { bots: View[] }).bots.every((bot) => bot.state === "running"));
    // Settings save is independent of process application; reset must survive both restart paths.
    const options = await call(socket, "bot_settings_options", { id: first.id }) as { models: { available: boolean; data: { defaultReasoningEffort: string }[] }; features: { available: boolean; issue: string }; voices: { available: boolean }; requirements: { available: boolean; data: null } };
    assert.equal(options.models.available, true);
    assert.equal(options.models.data[0]?.defaultReasoningEffort, "low");
    assert.equal(options.voices.available, true);
    assert.equal(options.features.available, false, "a refused discovery part cannot erase independent catalogs");
    assert.ok(options.features.issue);
    assert.deepEqual(options.requirements, { available: true, data: null, issue: null });
    const readSettings = () => call(socket, "bot_settings_read", { id: first.id, observe: true }) as Promise<SettingsView>;
    const beforeSettings = await readSettings();
    const patch = { id: first.id, expectedRevision: beforeSettings.saved.revision, requestId: crypto.randomUUID(),
      reset: ["model", "model_reasoning_effort", "sandbox_mode", "approval_policy"], set: { model_context_window: 120_000, "voice.includeStartupContext": false } };
    const preview = await call(socket, "bot_settings_preview", patch) as { changes: unknown[] };
    assert.equal(preview.changes.length, 6);
    const receipt = await call(socket, "bot_settings_patch", patch) as { revision: number; applied: boolean };
    assert.equal(receipt.applied, false);
    const pendingSettings = await readSettings();
    assert.equal(pendingSettings.loaded?.values.model, initial.model);
    assert.equal(pendingSettings.saved.values.model, undefined);
    assert.equal((await call(socket, "bot_list") as { bots: View[] }).bots[0]!.pid, (await call(socket, "bot_start", { id: first.id, account }) as View).pid);
    await assert.rejects(call(socket, "bot_settings_apply", { id: first.id, expectedRevision: receipt.revision }), /Stop the Bot/);
    await call(socket, "bot_stop", { id: first.id });
    await assert.rejects(call(socket, "bot_settings_apply", { id: first.id, expectedRevision: receipt.revision - 1 }), /revision conflict/);
    await call(socket, "bot_settings_apply", { id: first.id, expectedRevision: receipt.revision });
    const appliedSettings = await readSettings();
    assert.deepEqual(appliedSettings.loaded?.values, { model_context_window: 120_000 });
    assert.equal(appliedSettings.fields.find((field) => field.key === "voice.includeStartupContext")!.loaded.state, "unknown",
      "starting the process does not apply voice settings");
    assert.equal(appliedSettings.fields.find((field) => field.key === "model")!.resolved.state, "unknown");
    assert.equal(appliedSettings.fields.find((field) => field.key === "model_context_window")!.resolved.value, 120_000);
    const activeBot = (await call(socket, "bot_list") as { bots: View[] }).bots[0]!;
    assert.deepEqual(activeBot.settings, {});
    await chatRpc(activeBot.url!, "test/notify", { method: "thread/settings/updated", params: { threadId: opened.threadId, threadSettings: { model: "thread-model", effort: "low", serviceTier: null } } });
    assert.equal((await readSettings()).fields.find((field) => field.key === "model")!.effective.value, "thread-model");
    await chatRpc(activeBot.url!, "test/notify", { method: "thread/settings/updated", params: { threadId: "unrelated", threadSettings: { model: "foreign" } } });
    assert.equal((await readSettings()).fields.find((field) => field.key === "model")!.effective.value, "thread-model");
    await bots.close();
    bots = await serveApi({ name: "bots", transport: "socket", env });
    assert.deepEqual((await readSettings()).saved.values, appliedSettings.saved.values);
    // State maintenance runs through the same public owner as lifecycle and
    // refuses unavailable dependency evidence before any filesystem effect.
    const planInput = { botId: "named", action: { kind: "workspace_clear", selection: { all: true } } };
    const unavailable = await call(socket, "bot_state_plan", planInput) as StatePlan;
    assert.ok(unavailable.blockedBy.some(reason => reason.includes("dependencies unavailable")));
    const dependencies = await Promise.all(["worker", "browse", "proc", "serve"].map(name => serveSocket({
      info: { name, description: "Dependency fixture", transportDescription: "Socket", path: join(stateDir, "sockets", `${name}.sock`) }, context: {},
      operations: [operation({ name: `${name}_bot_dependencies`, description: "Fixture has no dependent resources", input: stateDependencyInput, output: stateDependencies,
        async call() { return { revision: "empty", blockedBy: [], retained: [], relationships: [] }; } })],
    })));
    try {
      await call(socket, "bot_stop", { id: "named" }); await call(socket, "bot_stop", { id: "custom" });
      const externalPlan = await call(socket, "bot_state_plan", { ...planInput, botId: "custom" }) as StatePlan;
      assert.ok(externalPlan.blockedBy.some(reason => reason.includes("external")));
      await writeFile(join(named.cwd, "proof.txt"), "selected bytes");
      const stale = await call(socket, "bot_state_plan", planInput) as StatePlan;
      await writeFile(join(named.cwd, "proof.txt"), "new bytes");
      await assert.rejects(call(socket, "bot_workspace_clear", { botId: "named", planId: stale.id, expectedRevision: stale.revision, requestId: crypto.randomUUID() }), /changed/);
      const plan = await call(socket, "bot_state_plan", planInput) as StatePlan;
      const input = { botId: "named", planId: plan.id, expectedRevision: plan.revision, requestId: crypto.randomUUID() };
      const receipt = await call(socket, "bot_workspace_clear", input) as StateReceipt;
      assert.equal(receipt.status, "completed");
      await writeFile(join(named.cwd, "new.txt"), "after clear");
      assert.deepEqual(await call(socket, "bot_workspace_clear", input), receipt);
      assert.ok((await lstat(join(named.cwd, "new.txt"))).isFile());
      const resetPlan = await call(socket, "bot_state_plan", { botId: "named", action: { kind: "session_reset", history: "retain" } }) as StatePlan;
      const reset = await call(socket, "bot_session_reset", { botId: "named", planId: resetPlan.id, expectedRevision: resetPlan.revision, requestId: crypto.randomUUID() }) as StateReceipt;
      assert.equal(reset.status, "completed");
      await call(socket, "bot_remove", { id: "named" });
      await call(socket, "bot_start", { id: "named", account });
      await assert.rejects(call(socket, "bot_workspace_clear", input), /another Bot incarnation/);
    } finally { await Promise.all(dependencies.map(owner => owner.close())); }
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
  const stateDir = await mkdtemp(join(tmpdir(), "stack-bots-rootstate-"));
  const target = await mkdtemp(join(tmpdir(), "stack-bots-roottarget-"));
  const root = join(stateDir, "bots");
  const env = { ...process.env, STACK_STATE_DIR: stateDir };
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
