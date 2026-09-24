import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { serveApi, socketCall, socketSubscribe } from "@agentstack/api";
import { AuthStore } from "@agentstack/auth";
import { StateStore } from "../src/store.js";
import { appServerSocket } from "../src/threads.js";

const fakeBin = fileURLToPath(new URL("../../test/fixtures/fake-app-server.mjs", import.meta.url));
const credential = (token: string) => JSON.stringify({ tokens: { refresh_token: token, access_token: "access", id_token: "fixture.jwt.signature" } });

test("codex lifecycle and change events are served on the namespaced unix socket", { timeout: 60_000 }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "agentstack-codex-api-"));
  const cwd = await mkdtemp(join(tmpdir(), "agentstack-codex-cwd-"));
  const savedHome = process.env.HOME;
  const savedPath = process.env.PATH;
  process.env.HOME = cwd;
  const runtime = join(cwd, ".local", "libexec", "codexnk", "codex");
  await mkdir(join(runtime, ".."), { recursive: true });
  await symlink(fakeBin, runtime);
  // A working PATH alternative must never substitute for the required runtime.
  await symlink(fakeBin, join(cwd, "codex"));
  process.env.PATH = `${cwd}:${savedPath ?? ""}`;
  const authStore = new AuthStore(stateDir);
  authStore.addAccount(credential("first-secret"));
  const secondAccount = authStore.addAccount(credential("second-secret"));
  const env = { ...process.env, AGENTSTACK_STATE_DIR: stateDir };
  const auth = await serveApi({ name: "auth", transport: "socket", env });
  const served = await serveApi({ name: "codex", transport: "socket", env });
  try {
    assert.equal(served.socketPath, join(stateDir, "sockets", "codex.sock"));
    assert.equal(auth.socketPath, join(stateDir, "sockets", "auth.sock"));
    const listedTools = (await socketCall(served.socketPath, "tools/list")) as {
      server: { name: string; description: string };
      transport: { type: string; path: string };
      websocket: unknown;
      events: { topics: Record<string, string>; subscribe: string } | null;
      tools: Array<{ name: string; description: string }>;
    };
    assert.equal(listedTools.server.name, "codex");
    assert.match(listedTools.server.description, /Start, stop, and list/);
    assert.equal(listedTools.transport.type, "socket");
    assert.equal(listedTools.transport.path, served.socketPath);
    assert.equal(listedTools.websocket, null);
    assert.deepEqual(listedTools.events?.subscribe, "events/subscribe");
    assert.deepEqual(listedTools.events?.topics, {
      servers_changed: "Published when a Codex app-server record starts, stops, exits, is reaped, or becomes fenced for recovery inspection.",
      threads_changed: "Published when a loaded Codex thread starts, changes status, or closes.",
    });
    assert.deepEqual(
      listedTools.tools.map((tool) => tool.name),
      ["server_start", "server_stop", "server_assign", "server_remove", "server_list"],
    );
    assert.ok(listedTools.tools.every((tool) => tool.description.length > 0));

    const received: string[] = [];
    const events = await socketSubscribe(served.socketPath ?? "", ["servers_changed"], (topic) => received.push(topic));
    const scoped: string[] = [];
    const unrelated: string[] = [];
    const scopedEvents = await socketSubscribe(served.socketPath ?? "", ["servers_changed"], (topic) => scoped.push(topic), { scope: "remote" });
    const otherEvents = await socketSubscribe(served.socketPath ?? "", ["servers_changed"], (topic) => unrelated.push(topic), { scope: "other" });
    assert.deepEqual(events.topics, ["servers_changed"]);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["accounts_changed"] }), /unknown topic/);
    await assert.rejects(socketCall(served.socketPath, "events/subscribe", { topics: ["inputs_changed"] }), /unknown topic/);
    await assert.rejects(socketSubscribe(served.socketPath ?? "", ["servers_changed"], () => undefined, { scope: "invalid/id" }), /invalid event scope/);

    await assert.rejects(socketCall(served.socketPath, "tools/call", { name: "account_list", arguments: {} }), /unknown operation/);
    await assert.rejects(socketCall(served.socketPath, "tools/call", { name: "input_observe_list", arguments: {} }), /unknown operation/);
    await socketCall(auth.socketPath ?? "", "tools/call", { name: "account_activate", arguments: { id: secondAccount.id } });

    const started = (await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote" },
    })) as { id: string; state: string; url: string; account: string | null; mainThreadId: string | null };
    assert.equal(started.id, "remote");
    assert.equal(started.state, "running");
    assert.equal(started.account, secondAccount.id);
    assert.equal((started as typeof started & { recoveryIssue: string | null }).recoveryIssue, null);
    assert.equal(started.mainThreadId, null);
    assert.match(started.url ?? "", /\/app\/[0-9a-f]{14}\.sock$/);
    const persisted = new StateStore(stateDir);
    assert.equal(persisted.servers().find((server) => server.id === "remote")?.codexBin, runtime);
    assert.equal(persisted.servers().find((server) => server.id === "remote")?.account, secondAccount.id);
    assert.equal(persisted.servers().find((server) => server.id === "remote")?.mainThreadId, null);
    persisted.close();
    for (let i = 0; i < 100 && received.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["servers_changed"]);
    assert.deepEqual(scoped, ["servers_changed"]);
    assert.deepEqual(unrelated, []);

    await assert.rejects(
      serveApi({ name: "codex", transport: "socket", env }),
      /already listening/,
    );

    const listed = (await socketCall(served.socketPath, "tools/call", {
      name: "server_list",
      arguments: {},
    })) as { servers: Array<{ id: string }> };
    assert.equal(listed.servers.some((server) => server.id === "remote"), true);
    assert.equal((listed.servers.find((server) => server.id === "remote") as { state?: string }).state, "running");

    await assert.rejects(socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "override", codexBin: fakeBin },
    }), /codexBin|Unrecognized/);
    await rm(runtime);
    await assert.rejects(socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "missing-bin" },
    }), /required codexnk runtime is missing/);
    await symlink(fakeBin, runtime);
    const afterBadBin = (await socketCall(served.socketPath, "tools/call", {
      name: "server_list", arguments: {},
    })) as { servers: Array<{ id: string; state: string }> };
    assert.equal(afterBadBin.servers.find((server) => server.id === "remote")?.state, "running");

    const stopped = (await socketCall(served.socketPath, "tools/call", {
      name: "server_stop",
      arguments: { id: "remote" },
    })) as { state: string };
    assert.equal(stopped.state, "stopped");
    for (let i = 0; i < 100 && received.length < 2; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(received, ["servers_changed", "servers_changed"]);
    assert.deepEqual(scoped, ["servers_changed", "servers_changed"]);
    assert.deepEqual(unrelated, []);

    await events.close();
    await scopedEvents.close();
    await otherEvents.close();
    received.length = 0;
    const running = await socketCall(served.socketPath, "tools/call", {
      name: "server_start",
      arguments: { cwd, id: "remote" },
    }) as { url: string };
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(received, []);

    // A fresh remote UI creates a blank thread; its first real turn makes it the main thread.
    const peer = appServerSocket(running.url);
    try {
      await new Promise<void>((resolve, reject) => { peer.once("open", resolve); peer.once("error", reject); });
      await appCall(peer, 1, "initialize", { clientInfo: { name: "remote-tui", version: "0" } });
      peer.send(JSON.stringify({ method: "initialized" }));
      await appCall(peer, 2, "thread/start", { cwd }); // A blank root must not claim the Server.
      const created = await appCall(peer, 3, "thread/start", { cwd }) as { thread: { id: string } };
      assert.equal((await socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} }) as { servers: Array<{ mainThreadId: string | null }> }).servers[0]?.mainThreadId, null);
      await appCall(peer, 4, "turn/start", { threadId: created.thread.id, input: [{ type: "text", text: "first turn" }] });
      let adopted: string | null = null;
      for (let i = 0; i < 100 && !adopted; i += 1) {
        const snapshot = await socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} }) as { servers: Array<{ mainThreadId: string | null }> };
        adopted = snapshot.servers[0]?.mainThreadId ?? null;
        if (!adopted) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(adopted, created.thread.id);
      await appCall(peer, 5, "thread/start", { cwd });
      assert.equal((await socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} }) as { servers: Array<{ mainThreadId: string | null }> }).servers[0]?.mainThreadId, adopted);
      await socketCall(served.socketPath, "tools/call", { name: "server_stop", arguments: { id: "remote" } });
      const resumed = await socketCall(served.socketPath, "tools/call", { name: "server_start", arguments: { cwd, id: "remote" } }) as { mainThreadId: string | null };
      assert.equal(resumed.mainThreadId, adopted);
    } finally { peer.close(); }

    await assert.rejects(
      socketCall(served.socketPath, "tools/call", { name: "server_start", arguments: {} }),
      /cwd/,
    );
    assert.deepEqual(await socketCall(served.socketPath, "tools/call", { name: "server_remove", arguments: { id: "remote" } }), { id: "remote" });
    const removed = (await socketCall(served.socketPath, "tools/call", { name: "server_list", arguments: {} })) as { servers: Array<{ id: string }> };
    assert.equal(removed.servers.some((server) => server.id === "remote"), false);
    const checked = new StateStore(stateDir);
    assert.equal(checked.hasServer("remote"), false);
    checked.close();
    await assert.rejects(lstat(join(stateDir, "history", "remote")), /ENOENT/);
  } finally {
    await served.close();
    await auth.close();
    authStore.close();
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    await rm(stateDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

function appCall(peer: ReturnType<typeof appServerSocket>, id: number, method: string, params: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { peer.off("message", onMessage); reject(new Error(`${method} timed out`)); }, 5_000);
    const onMessage = (raw: unknown) => {
      const frame = JSON.parse(String(raw)) as { id?: number; result?: unknown; error?: { message?: string } };
      if (frame.id !== id) return;
      clearTimeout(timer);
      peer.off("message", onMessage);
      if (frame.error) reject(new Error(frame.error.message));
      else resolve(frame.result);
    };
    peer.on("message", onMessage);
    peer.send(JSON.stringify({ id, method, params }));
  });
}
