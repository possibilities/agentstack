import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe, type ServedApi, type SocketSubscription } from "@agentstack/api";
import { StateStore } from "../src/store.js";
import { chatRpc } from "../src/chats.js";

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
  const otherAccount = store.addAccount(JSON.stringify({ tokens: { refresh_token: "other", access_token: "access", id_token: "fixture.jwt.signature" } })).id;
  store.close();
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  let bots: ServedApi | undefined = await serveApi({ name: "bots", transport: "socket", env });
  const socket = bots.socketPath ?? "";
  let subscription: SocketSubscription | undefined;
  let defaultsSubscription: SocketSubscription | undefined;
  try {
    const tools = await socketCall(socket, "tools/list") as { tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; events: { scope: { required: boolean } } };
    assert.deepEqual(tools.tools.map((tool) => tool.name), ["bot_start", "bot_stop", "bot_assign", "bot_remove", "bot_list", "bot_defaults_get", "bot_defaults_set", "voice_status", "voice_dial", "voice_speak", "voice_hangup", "chat_list", "chat_tree", "chat_tree_detail", "chat_search", "chat_records", "chat_record_chunk", "chat_thread_read", "chat_turns", "chat_items", "chat_main_live", "chat_main_items", "chat_occurrences", "chat_open", "chat_send", "chat_steer", "chat_interrupt", "chat_enqueue", "chat_queue_list", "chat_queue_resolve", "chat_codex_queue_add", "chat_codex_queue_list", "chat_codex_queue_update", "chat_codex_queue_delete", "chat_codex_queue_reorder", "chat_codex_queue_start", "chat_upload_start", "chat_upload_status", "chat_upload_chunk", "chat_upload_finish", "chat_attachment_add", "chat_attachment_list", "chat_attachment_remove"]);
    assert.deepEqual(Object.keys(tools.tools[0].inputSchema.properties).sort(), ["account", "args", "cwd", "id", "settings"]);
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
